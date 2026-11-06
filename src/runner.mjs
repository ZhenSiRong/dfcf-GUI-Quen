#!/usr/bin/env node
/**
 * quan runner —— 一次完整的「取数 → 信号 → 风控 → GUI 下单 → 归档」流程
 * ===============================================================
 * 默认 dry-run（只到确认弹窗，不点确定）；真实下单必须显式 --live。
 *
 * 用法：
 *   node src/runner.mjs                        # dry-run + 真实账户/行情
 *   node src/runner.mjs --mock                 # dry-run + 离线 fixture（可重复）
 *   node src/runner.mjs --live                 # 真实下单（交易时段）
 *   node src/runner.mjs --live --confirm       # 每笔真实委托前人工确认
 *   node src/runner.mjs --force                # 跳过时段/当日重复 live 检查
 *   node src/runner.mjs --at 2026-11-06T14:50:00+08:00   # 仅 dry-run 可用
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  RISK, ROOT, loadAccount, loadUniverse, SNAPSHOT_FIXTURE,
} from "./config.mjs";
import { createLogger, raiseAlert } from "./util/log.mjs";
import { shanghaiNow, parseHHMM } from "./util/time.mjs";
import { decideSession, findTodayLiveRun } from "./scheduler/session.mjs";
import { createMarket } from "./market/source.mjs";
import { getQuote, limitPrices } from "./market/push2.mjs";
import { decideAll } from "./strategy/sma.mjs";
import { checkOrder } from "./risk/guard.mjs";
import { WapBroker } from "./broker/wap.mjs";
import { MockBroker } from "./broker/mock.mjs";
import {
  openDb, startRun, finishRun, logSignal, logOrder,
  snapshotPositions, snapshotBalance, todayOrderCount,
  getFailures, bumpFailure, resetFailures,
} from "./store/db.mjs";
import { renderReport, writeReport } from "./report/daily.mjs";

// 运行产物（日志/截图/DB）默认仅本人可读
process.umask(0o077);

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const out = { live: false, mock: false, force: false, confirm: false, at: null, maxOrders: 0, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--mock") out.mock = true;
    else if (a === "--force") out.force = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--at") out.at = argv[++i] || null;
    else if (a === "--max-orders") out.maxOrders = Number(argv[++i] || 0);
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error("未知参数: " + a);
  }
  if (!Number.isFinite(out.maxOrders) || out.maxOrders < 0) out.maxOrders = 0;
  return out;
}

const HELP = `quan runner
  --live      真实下单（默认 dry-run）
  --mock      使用 fixtures/market.json + 内存 MockBroker
  --force     跳过交易时段与当日重复 live 检查
  --confirm   每笔真实委托前在终端确认
  --max-orders N  本次运行最多提交 N 笔真实委托（0=不额外限制）
  --at ISO    指定“现在”（仅 dry-run，便于测试）
  --help      显示帮助
`;

const round2 = (x) => Math.round(x * 100) / 100;

/** 限价：买价上浮 0.3% / 卖价下浮 0.3%，夹在涨跌停之间 */
function orderPrice(side, quote, code) {
  const lim = limitPrices(quote, code);
  let p = quote.last * (side === "buy" ? 1.003 : 0.997);
  p = round2(p);
  if (lim) p = Math.min(Math.max(p, lim.down), lim.up);
  return round2(p);
}

function askYes(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(String(ans).trim().toLowerCase() === "yes");
    });
  });
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

// ---------------- 主流程 ----------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  // --at 只影响“现在”的判定；真实账户绝不能靠改时间来绕过时段检查
  if (args.at && args.live && !args.mock) throw new Error("--at 只能用于 dry-run 或 --mock");

  const log = createLogger("runner");
  const db = openDb();
  const now = args.at ? shanghaiNow(new Date(args.at)) : shanghaiNow();
  const account = loadAccount();
  const mode = args.live ? "live" : "dry-run";

  // 只允许模拟组合真实下单；真实账户必须显式解锁
  if (args.live && !args.mock && account.sim !== true && process.env.QUAN_ALLOW_NON_SIM !== "1") {
    throw new Error(`拒绝真实下单：${account.zjzh} 未被标记为模拟组合（sim=true）。如确认无误，设置 QUAN_ALLOW_NON_SIM=1`);
  }

  const session = decideSession({ now, live: args.live, force: args.force });

  log.info(`启动 mode=${mode} mock=${args.mock} zjzh=${account.zjzh} ${now.date} ${now.time} (${now.weekday})`);
  log.info(`时段判定: ${session.reason} run=${session.run}`);

  if (!session.run) {
    log.warn(`跳过本次运行：${session.reason}`);
    console.log(`SUMMARY ${JSON.stringify({ ok: true, skipped: true, reason: session.reason })}`);
    return 0;
  }

  if (args.live && !args.force) {
    const prev = findTodayLiveRun(db, now.date);
    if (prev) {
      log.warn(`今日已有成功的 live 运行（#${prev.id} ${prev.ts}），跳过。需要重跑请加 --force`);
      console.log(`SUMMARY ${JSON.stringify({ ok: true, skipped: true, reason: "already_ran_today", runId: prev.id })}`);
      return 0;
    }
  }

  // 节假日保护：行情最后更新时间不是今天 → 交易所没开市，跳过 live
  if (args.live && !args.mock) {
    let probe = null;
    try {
      probe = await getQuote("601398");
    } catch (e) {
      log.error("行情时间探测失败: " + (e?.message || e));
    }
    const qDate = probe?.quoteTime ? shanghaiNow(new Date(probe.quoteTime * 1000)).date : null;
    if (qDate !== now.date) {
      const reason = qDate ? "stale_market_data" : "market_probe_failed";
      log.warn(`跳过 live：行情最后更新=${qDate || "unknown"}，今天=${now.date}（可能休市）`);
      raiseAlert("live_skipped_market_closed", { zjzh: account.zjzh, reason, qDate, today: now.date });
      console.log(`SUMMARY ${JSON.stringify({ ok: true, skipped: true, reason })}`);
      return 0;
    }
  }

  const runId = startRun(db, mode);
  let broker = null;

  try {
    if (args.mock) {
      broker = fs.existsSync(SNAPSHOT_FIXTURE)
        ? MockBroker.fromSnapshot(SNAPSHOT_FIXTURE, process.env.QUAN_MOCK_KEY || "demo")
        : new MockBroker({ cash: 1_000_000 });
      log.info("使用 MockBroker（内存，不接触真实账户）");
    } else {
      broker = await WapBroker.create({ headless: true, log: (m) => log.info(m) });
      log.info("使用 WapBroker（真实 H5）");
    }

    // 1. 登录态 / 接口健康检查
    const health = await broker.health(account.zjzh);
    if (!health.ok) {
      raiseAlert("broker_unhealthy", { zjzh: account.zjzh, health });
      throw new Error(`Broker 健康检查失败: ${health.reason || health.message || "unknown"}`);
    }
    log.info(`健康检查通过 total=${health.total} cash=${health.cash}`);
    if (broker.persist) await broker.persist();

    // 2. 运行前快照
    const [beforeBal, beforePos, openOrders] = await Promise.all([
      broker.balance(account.zjzh),
      broker.positions(account.zjzh),
      broker.orders(account.zjzh),
    ]);
    if (!beforeBal.ok || !beforePos.ok) throw new Error("无法读取账户快照");
    snapshotBalance(db, account.zjzh, beforeBal);
    snapshotPositions(db, account.zjzh, beforePos.positions);

    const before = { balance: beforeBal, positions: beforePos };
    log.info(`运行前: 总资产=${beforeBal.total} 可用=${beforeBal.cash} 持仓=${beforePos.positions.length} 未成交委托=${openOrders.orders.length}`);

    // 3. 行情 + 历史（股票池 ∪ 当前持仓，避免移出股票池的持仓无人管）
    const uni = loadUniverse();
    const heldCodes = beforePos.positions.map((p) => String(p.code));
    const codes = [...new Set([...uni.codes, ...heldCodes])];
    const market = createMarket({ mock: args.mock });
    const quotes = await market.quotes(codes);
    const bars = await market.bars(codes, 90);
    log.info(`行情: quotes=${quotes.size} bars=${bars.size} codes=${codes.join(",")}`);

    // 把当日实时价并入最后一根 K 线（开盘后才有意义）
    for (const code of codes) {
      const q = quotes.get(code);
      const list = bars.get(code);
      if (!q || !Array.isArray(list) || !list.length) continue;
      const lastDate = list.at(-1).date;
      if (now.date > lastDate && now.minutes >= parseHHMM("09:30")) {
        list.push({ date: now.date, open: q.last, high: q.last, low: q.last, close: q.last, volume: 0, synthetic: true });
      } else if (now.date === lastDate) {
        list[list.length - 1] = { ...list.at(-1), close: q.last, high: Math.max(list.at(-1).high, q.last), low: Math.min(list.at(-1).low, q.last) };
      }
    }

    // 4. 信号
    const posQty = {};
    for (const p of beforePos.positions) posQty[String(p.code)] = p.qty;
    const signals = decideAll({
      universe: codes,
      barsByCode: bars,
      positionQtyByCode: posQty,
      params: uni.params,
    }).map((s) => ({ ...s, name: quotes.get(s.code)?.name || beforePos.positions.find((p) => p.code === s.code)?.name || "" }));

    for (const s of signals) {
      logSignal(db, { strategy: "sma", code: s.code, action: s.action, reason: s.reason, payload: s.meta });
      const m = s.meta || {};
      log.info(`信号 ${s.code} ${s.name || ""} ${s.action} (${s.reason}) trend=${m.trend ?? "-"} ratio=${m.ratio ?? "-"}`);
    }

    // 5. 执行
    const pending = new Set(openOrders.orders.filter((o) => o.canCancel).map((o) => o.code));
    // dry-run 可反复跑；只有真实委托才做「同日同代码只下一次」的限制
    const alreadyOrdered = args.live
      ? new Set(
          db.prepare(
            "SELECT DISTINCT code FROM orders WHERE zjzh=? AND date(ts, '+8 hours')=? AND dry_run=0",
          ).all(account.zjzh, now.date).map((r) => r.code),
        )
      : new Set();

    const positionsForGuard = new Map();
    for (const p of beforePos.positions) {
      positionsForGuard.set(String(p.code), p);
    }

    const executions = [];
    const skipped = [];
    let submittedThisRun = 0;

    // 先卖后买，避免资金/持仓顺序影响
    const ordered = [...signals].sort((a, b) => {
      const rank = (x) => (x.action === "sell" ? 0 : x.action === "buy" ? 1 : 2);
      return rank(a) - rank(b);
    });

    for (const s of ordered) {
      if (s.action === "hold") continue;
      if (args.live && args.maxOrders > 0 && submittedThisRun >= args.maxOrders) {
        skipped.push({ code: s.code, action: s.action, reason: `本次运行已达 --max-orders ${args.maxOrders}` });
        continue;
      }
      if (pending.has(s.code)) {
        skipped.push({ code: s.code, action: s.action, reason: "已有未成交委托" });
        continue;
      }
      if (alreadyOrdered.has(s.code)) {
        skipped.push({ code: s.code, action: s.action, reason: "今日已对该代码下过单" });
        continue;
      }

      const q = quotes.get(s.code);
      if (!q || !Number.isFinite(q.last) || q.last <= 0) {
        skipped.push({ code: s.code, action: s.action, reason: "无有效行情" });
        continue;
      }

      let price;
      let qty;

      if (s.action === "buy") {
        price = orderPrice("buy", q, s.code);
        const budget = Math.min(
          RISK.maxNotionalPerOrder,
          (beforeBal.total || beforeBal.cash) * RISK.maxPositionRatioPerStock,
        );
        qty = Math.floor(budget / price / RISK.lotSize) * RISK.lotSize;
        if (qty < RISK.lotSize) {
          skipped.push({ code: s.code, action: "buy", reason: `1 手 ${price * 100} 元超出单笔预算 ${budget.toFixed(0)}` });
          continue;
        }
      } else {
        const p = beforePos.positions.find((x) => String(x.code) === s.code);
        qty = Math.floor(p?.available ?? p?.qty ?? 0);
        if (qty <= 0) {
          skipped.push({ code: s.code, action: "sell", reason: "可卖数量为 0（T+1 或已挂单）" });
          continue;
        }
        price = orderPrice("sell", q, s.code);
      }

      // 真实模式下逐笔刷新可用资金，避免同一次运行内多笔买入用到过期余额
      let guardBalance = { total: beforeBal.total, cash: beforeBal.cash };
      if (args.live) {
        const fresh = await broker.balance(account.zjzh).catch(() => null);
        if (fresh?.ok) guardBalance = { total: fresh.total, cash: fresh.cash };
      }

      const guard = checkOrder({
        side: s.action,
        code: s.code,
        price,
        qty,
        quote: q,
        balance: guardBalance,
        positions: positionsForGuard,
        todayOrders: todayOrderCount(db, account.zjzh, now.date),
        consecutiveFailures: getFailures(db, account.zjzh),
      });

      if (!guard.ok) {
        skipped.push({ code: s.code, action: s.action, reason: `风控[${guard.rule}] ${guard.detail}` });
        log.warn(`风控拒绝 ${s.code} ${s.action}: [${guard.rule}] ${guard.detail}`);
        continue;
      }

      if (args.live && args.confirm) {
        const ok = await askYes(
          `\n即将真实${s.action === "buy" ? "买入" : "卖出"} ${s.code} ${q.name || ""} ${qty} 股 @ ${price}（约 ${(price * qty).toFixed(0)} 元）。输入 yes 确认：`,
        );
        if (!ok) {
          skipped.push({ code: s.code, action: s.action, reason: "人工取消" });
          log.warn(`人工取消 ${s.code}`);
          continue;
        }
      }

      let res;
      try {
        res = await broker.place({
          zjzh: account.zjzh,
          comboName: account.name,
          side: s.action,
          code: s.code,
          price,
          qty,
          dryRun: !args.live,
        });
      } catch (e) {
        // 单笔 GUI 异常不应中断整轮（截图已由 WapBroker 保存）
        res = {
          ok: false,
          dryRun: !args.live,
          response: { message: (e?.message || String(e)).split("\n")[0] },
        };
        log.error(`下单异常 ${s.code}: ${res.response.message}`);
      }

      const rec = {
        code: s.code, name: q.name || res.name || "", side: s.action,
        price, qty, ok: !!res.ok, dryRun: !args.live,
        orderId: res.orderId || null,
        message: res.ok ? (args.live ? "已提交" : "dry-run 已到确认弹窗，未提交") : (res.response?.message || res.message || "失败"),
      };
      executions.push(rec);

      logOrder(db, {
        zjzh: account.zjzh, orderId: rec.orderId, code: rec.code, name: rec.name,
        side: rec.side, price, qty, status: res.ok ? (args.live ? "submitted" : "dry_run") : "failed",
        dryRun: !args.live, response: res.response || null,
      });

      if (res.ok) {
        alreadyOrdered.add(s.code);
        submittedThisRun++;
        if (args.live) resetFailures(db, account.zjzh);
        log.info(`委托成功 ${rec.code} ${rec.side} ${qty}@${price} orderId=${rec.orderId || "-"}${args.live ? "" : " (dry-run)"}`);
      } else {
        if (args.live) bumpFailure(db, account.zjzh);
        const msg = rec.message;
        log.error(`委托失败 ${rec.code} ${rec.side}: ${msg}`);
        raiseAlert("order_failed", { zjzh: account.zjzh, code: rec.code, side: rec.side, price, qty, message: msg });
      }
    }

    // 6. 运行后快照
    const [afterBal, afterPos, afterOrders] = await Promise.all([
      broker.balance(account.zjzh),
      broker.positions(account.zjzh),
      broker.orders(account.zjzh),
    ]);
    if (afterBal.ok) snapshotBalance(db, account.zjzh, afterBal);
    if (afterPos.ok) snapshotPositions(db, account.zjzh, afterPos.positions);
    const after = { balance: afterBal, positions: afterPos };

    log.info(`运行后: 总资产=${afterBal.total} 可用=${afterBal.cash} 持仓=${afterPos.positions.length} 未成交委托=${afterOrders.orders.length}`);

    // 7. 日报
    const md = renderReport({
      now, mode, mock: args.mock, account, session: session.session,
      before, after, signals, executions, skipped, openOrders: afterOrders.orders,
    });
    ensureDir(path.join(ROOT, "reports"));
    const reportFile = writeReport(md, { now, mode });
    log.info(`日报: ${reportFile}`);

    const summary = {
      ok: true, runId, date: now.date, mode, session: session.reason,
      signals: signals.length,
      executed: executions.filter((e) => e.ok).length,
      failed: executions.filter((e) => !e.ok).length,
      skipped: skipped.length,
      orderIds: executions.filter((e) => e.orderId).map((e) => e.orderId),
      report: path.relative(ROOT, reportFile),
    };
    finishRun(db, runId, "ok", JSON.stringify(summary));
    console.log(`SUMMARY ${JSON.stringify(summary)}`);
    return 0;
  } catch (e) {
    const msg = e?.message || String(e);
    log.error("运行失败: " + msg);
    raiseAlert("run_failed", { zjzh: account.zjzh, mode, msg, stack: e?.stack?.split("\n").slice(0, 8) });
    try { finishRun(db, runId, "failed", msg.slice(0, 500)); } catch {}
    console.log(`SUMMARY ${JSON.stringify({ ok: false, runId, error: msg })}`);
    return 1;
  } finally {
    if (broker) await broker.close().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL", e?.stack || e);
    process.exit(1);
  });
