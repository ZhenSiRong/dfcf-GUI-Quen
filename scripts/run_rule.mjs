#!/usr/bin/env node
/**
 * 一次性规则执行器（带视频）
 * ---------------------------------------------------------------
 * 读取 state/rules/<id>.json，按规则在指定时间买入固定数量，
 * 全程通过 H5 GUI 提交，并用 Playwright 录屏。
 *
 * 用法：
 *   node scripts/run_rule.mjs --id buy-603259-one-lot-20261106            # dry-run 预览（随时可跑）
 *   node scripts/run_rule.mjs --id buy-603259-one-lot-20261106 --live     # 真实下单（按规则时间）
 *
 * 安全：
 *  - 规则必须 enabled、当天、在 executeAfter 之后、expiresAt 之前
 *  - 仅本次允许 rule.maxNotional 覆盖单笔 5000 上限（硬顶 20000）
 *  - 其他风控（现金、集中度、偏离、涨跌停、单日笔数、熔断）仍全部生效
 *  - 已有同代码未成交委托 → 拒绝，避免重复
 *  - 提交成功后立即把规则状态写回文件，防止二次执行
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  RISK, ROOT, RULE_DIR, VIDEO_DIR, loadAccount,
} from "../src/config.mjs";
import { createLogger, raiseAlert } from "../src/util/log.mjs";
import { shanghaiNow, parseHHMM, canPlaceNewOrder } from "../src/util/time.mjs";
import { getQuote, limitPrices } from "../src/market/push2.mjs";
import { checkOrder } from "../src/risk/guard.mjs";
import { WapBroker } from "../src/broker/wap.mjs";
import {
  openDb, startRun, finishRun, logOrder, todayOrderCount,
  getFailures, bumpFailure, resetFailures,
} from "../src/store/db.mjs";

process.umask(0o077);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;
const RULE_MAX_NOTIONAL_HARD_CAP = 20000;

function parseArgs(argv) {
  const out = { id: null, live: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") out.id = argv[++i] || null;
    else if (a === "--live") out.live = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error("未知参数: " + a);
  }
  return out;
}

const HELP = `一次性规则执行器
  --id <id>   规则文件名（不含 .json）
  --live      真实下单（默认 dry-run，只到确认弹窗后取消）
  --help      显示帮助
`;

function loadRule(id) {
  const file = path.join(RULE_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error("规则不存在: " + file);
  return { file, rule: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function saveRule(file, rule) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rule, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function validateRule(rule) {
  if (!rule || typeof rule !== "object") return "规则格式错误";
  if (rule.enabled !== true) return "规则未启用";
  if (rule.side !== "buy") return "目前只支持 buy";
  if (!/^\d{6}$/.test(String(rule.code))) return "code 必须是 6 位数字";
  if (!Number.isInteger(rule.qty) || rule.qty <= 0) return "qty 必须是正整数";
  if (rule.qty % RISK.lotSize !== 0) return `qty 必须是 ${RISK.lotSize} 股整数倍`;
  if (!Number.isFinite(rule.maxNotional) || rule.maxNotional <= 0) return "maxNotional 非法";
  if (rule.maxNotional > RULE_MAX_NOTIONAL_HARD_CAP) {
    return `maxNotional ${rule.maxNotional} > 硬顶 ${RULE_MAX_NOTIONAL_HARD_CAP}`;
  }
  const off = rule.price?.offsetPct ?? 0.005;
  if (!Number.isFinite(off) || off < 0 || off > RISK.maxPriceDeviation) {
    return `price.offsetPct 必须在 0~${RISK.maxPriceDeviation} 之间`;
  }
  return null;
}

function computePrice(quote, code, offsetPct = 0.005) {
  if (!quote || !Number.isFinite(quote.last) || quote.last <= 0) throw new Error("无有效行情");
  let p = round2(quote.last * (1 + offsetPct));
  const lim = limitPrices(quote, code);
  if (lim) p = Math.min(Math.max(p, lim.down), lim.up);
  return round2(p);
}

function findVideo(videoDir, baseName) {
  try {
    if (!fs.existsSync(videoDir)) return { webm: null, mp4: null };
    const files = fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
    if (!files.length) return { webm: null, mp4: null };
    files.sort((a, b) => fs.statSync(path.join(videoDir, b)).size - fs.statSync(path.join(videoDir, a)).size);
    const src = path.join(videoDir, files[0]);
    const webm = path.join(VIDEO_DIR, baseName + ".webm");
    const mp4 = path.join(VIDEO_DIR, baseName + ".mp4");
    fs.renameSync(src, webm);
    try {
      execFileSync("ffmpeg", [
        "-y", "-loglevel", "error", "-i", webm,
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", mp4,
      ], { timeout: 120000 });
      return { webm, mp4 };
    } catch (e) {
      return { webm, mp4: null, error: (e?.message || String(e)).split("\n")[0] };
    }
  } catch (e) {
    return { webm: null, mp4: null, error: (e?.message || String(e)).split("\n")[0] };
  }
}

function renderReport(ctx) {
  const money = (x) => (Number.isFinite(Number(x))
    ? Number(x).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "-");
  const L = [];
  L.push("# 一次性规则执行报告");
  L.push("");
  L.push(`- 规则：\`${ctx.rule.id}\``);
  L.push(`- 时间：${ctx.now.date} ${ctx.now.time}（Asia/Shanghai）`);
  L.push(`- 模式：**${ctx.live ? "live" : "dry-run"}**`);
  L.push(`- 标的：${ctx.quote.name}（${ctx.rule.code}）`);
  L.push(`- 方向 / 数量：买入 ${ctx.qty} 股`);
  L.push(`- 最新价：${money(ctx.quote.last)}；限价：${money(ctx.price)}（+${((ctx.price / ctx.quote.last - 1) * 100).toFixed(3)}%）`);
  L.push(`- 金额：${money(ctx.notional)} 元（规则上限 ${money(ctx.rule.maxNotional)} 元）`);
  L.push("");
  L.push("## 结果");
  L.push("");
  if (ctx.ok) {
    if (ctx.live) {
      L.push(`- 委托：✅ 已提交（合同编号 \`${ctx.orderId || "-"}\`）`);
      const c = ctx.confirm || {};
      if (c.type === "filled") L.push(`- 成交确认：✅ 持仓已出现 ${c.position?.qty ?? "?"} 股，可用 ${c.position?.available ?? "?"} 股`);
      else if (c.type === "open") L.push(`- 成交确认：⏳ 委托仍在队列（${c.order?.status || "未成交"}），可在 H5「委托成交」查看`);
      else L.push("- 成交确认：未在 12 秒内读到持仓/委托，请以 H5 为准");
      L.push(`- 运行后：总资产 ${money(ctx.after?.total)}，可用 ${money(ctx.after?.cash)}`);
    } else {
      L.push("- 结果：✅ 已到确认弹窗并点击「取消」，未提交任何委托");
      L.push("- 说明：这是 dry-run 预览视频");
    }
  } else {
    L.push(`- 结果：❌ 失败`);
    L.push(`- 原因：${ctx.error}`);
  }
  L.push("");
  if (ctx.video?.mp4 || ctx.video?.webm) {
    L.push("## 视频");
    L.push("");
    if (ctx.video.mp4) L.push(`- MP4：\`${path.relative(ROOT, ctx.video.mp4)}\``);
    if (ctx.video.webm) L.push(`- WebM：\`${path.relative(ROOT, ctx.video.webm)}\``);
    L.push("");
  }
  L.push("---");
  L.push("_由 quan 自动生成；下单全部通过东方财富移动版 H5 GUI 完成。_");
  L.push("");
  return L.join("\n");
}

function writeReports(ctx) {
  const dir = path.join(ROOT, "reports/rules");
  fs.mkdirSync(dir, { recursive: true });
  const md = renderReport(ctx);
  // dry-run 预览不能覆盖真实执行报告
  const f = path.join(dir, `${ctx.rule.id}${ctx.live ? "" : "-dry-run"}.md`);
  fs.writeFileSync(f, md);
  if (ctx.live) fs.writeFileSync(path.join(dir, "latest.md"), md);
  return f;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  if (!args.id) { console.error(HELP); return 1; }

  const log = createLogger("rule");
  const now = shanghaiNow();
  const mode = args.live ? "live" : "dry-run";
  const { file: ruleFile, rule: loaded } = loadRule(args.id);
  let rule = loaded;

  log.info(`规则 ${rule.id} mode=${mode} ${now.date} ${now.time} (${now.weekday})`);
  const invalid = validateRule(rule);
  if (invalid) {
    log.error("规则校验失败: " + invalid);
    console.log("SUMMARY " + JSON.stringify({ ok: false, reason: "invalid_rule", detail: invalid }));
    return 1;
  }

  if (args.live) {
    if (rule.status !== "pending") {
      log.warn(`规则状态=${rule.status}，跳过（防止重复执行）`);
      console.log("SUMMARY " + JSON.stringify({ ok: true, skipped: true, reason: "already_" + rule.status }));
      return 0;
    }
    if (rule.executeOn !== now.date) {
      log.warn(`规则执行日=${rule.executeOn}，今天=${now.date}，跳过`);
      console.log("SUMMARY " + JSON.stringify({ ok: true, skipped: true, reason: "not_today" }));
      return 0;
    }
    if (now.minutes < parseHHMM(rule.executeAfter)) {
      log.warn(`未到执行时间 ${rule.executeAfter}，跳过`);
      console.log("SUMMARY " + JSON.stringify({ ok: true, skipped: true, reason: "too_early" }));
      return 0;
    }
    if (now.minutes > parseHHMM(rule.expiresAt)) {
      log.warn(`已过规则有效期 ${rule.expiresAt}，跳过`);
      console.log("SUMMARY " + JSON.stringify({ ok: true, skipped: true, reason: "expired" }));
      return 0;
    }
    const s = canPlaceNewOrder(now);
    if (!s.ok) {
      log.warn(`当前时段 ${s.reason}，不允许下单，跳过`);
      console.log("SUMMARY " + JSON.stringify({ ok: true, skipped: true, reason: s.reason }));
      return 0;
    }
  }

  const account = loadAccount();
  if (args.live && account.sim !== true && process.env.QUAN_ALLOW_NON_SIM !== "1") {
    throw new Error(`拒绝真实下单：${account.zjzh} 未被标记为 sim=true`);
  }

  const stamp = `${now.date}-${now.time.replace(":", "")}`;
  const baseName = `${rule.id}-${stamp}-${mode}`;
  const videoDir = path.join(VIDEO_DIR, baseName);
  fs.mkdirSync(videoDir, { recursive: true });

  const db = openDb();
  const runId = startRun(db, `rule-${mode}`);
  let broker = null;
  let orderId = null;
  let quote = null;
  let price = null;
  let qty = rule.qty;
  let notional = null;
  let before = null;
  let after = null;
  let confirm = null;
  let video = null;
  let reportFile = null;

  const finish = async (ok, error) => {
    if (broker) { await broker.close().catch(() => {}); broker = null; }
    await sleep(900);
    video = findVideo(videoDir, baseName);
    const ctx = {
      rule, now, live: args.live, ok, error, quote, price, qty, notional,
      before, after, orderId, confirm, video,
    };
    reportFile = writeReports(ctx);
    if (video?.mp4) log.info("视频: " + video.mp4);
    else if (video?.webm) log.info("视频(webm): " + video.webm);
    else log.warn("未找到录屏文件: " + videoDir);
    log.info("报告: " + reportFile);
    return ctx;
  };

  try {
    broker = await WapBroker.create({
      headless: true,
      log: (m) => log.info(m),
      recordVideo: rule.video === false ? null : { dir: videoDir, size: { width: 430, height: 900 } },
    });

    const health = await broker.health(account.zjzh);
    if (!health.ok) throw new Error("Broker 健康检查失败: " + JSON.stringify(health));
    await broker.persist();

    const [bal, pos, openOrders] = await Promise.all([
      broker.balance(account.zjzh),
      broker.positions(account.zjzh),
      broker.orders(account.zjzh),
    ]);
    if (!bal.ok || !pos.ok) throw new Error("无法读取账户快照");
    before = bal;
    log.info(`运行前: 总资产=${bal.total} 可用=${bal.cash} 持仓=${pos.positions.length} 未成交=${openOrders.orders.length}`);

    if (openOrders.orders.some((o) => String(o.code) === String(rule.code))) {
      throw new Error(`已存在 ${rule.code} 的未成交委托，拒绝重复下单`);
    }

    quote = await getQuote(rule.code);
    if (!quote) throw new Error("无法取得行情: " + rule.code);
    if (args.live) {
      const qDate = quote.quoteTime ? shanghaiNow(new Date(quote.quoteTime * 1000)).date : null;
      if (qDate !== now.date) {
        throw new Error(`行情最后更新时间=${qDate || "unknown"}，今天=${now.date}（可能休市）`);
      }
    }
    log.info(`行情 ${quote.code} ${quote.name} last=${quote.last} prevClose=${quote.prevClose} 更新时间=${quote.quoteTime ? shanghaiNow(new Date(quote.quoteTime * 1000)).time : "-"}`);

    price = computePrice(quote, rule.code, rule.price?.offsetPct ?? 0.005);
    notional = round2(price * qty);
    if (notional > rule.maxNotional) {
      throw new Error(`金额 ${notional} 超过规则上限 ${rule.maxNotional}`);
    }

    const positionsMap = new Map(pos.positions.map((p) => [String(p.code), p]));
    const guard = checkOrder({
      side: rule.side,
      code: String(rule.code),
      price,
      qty,
      quote,
      balance: { total: bal.total, cash: bal.cash },
      positions: positionsMap,
      todayOrders: todayOrderCount(db, account.zjzh, now.date),
      consecutiveFailures: getFailures(db, account.zjzh),
      // 仅本次规则显式放宽单笔金额；其他阈值不变
      cfg: { maxNotionalPerOrder: rule.maxNotional },
    });
    if (!guard.ok) throw new Error(`风控[${guard.rule}] ${guard.detail}`);

    log.info(`下单参数: 买入 ${quote.name} ${qty} 股 @ ${price}（约 ${notional} 元）`);

    const banner = args.live
      ? `自动化规则 · 实盘买入 · ${quote.name}(${rule.code}) ${qty} 股`
      : `自动化规则演示（不提交）· ${quote.name}(${rule.code}) ${qty} 股`;

    const res = await broker.place({
      zjzh: account.zjzh,
      comboName: account.name,
      side: rule.side,
      code: String(rule.code),
      price,
      qty,
      dryRun: !args.live,
      banner,
    });
    if (!res.ok) throw new Error("委托失败: " + (res.response?.message || res.response?.raw || "unknown"));
    orderId = res.orderId || null;
    log.info(`委托成功 orderId=${orderId || "-"}${args.live ? "" : "（dry-run）"}`);

    if (args.live) {
      rule = {
        ...rule,
        status: "submitted",
        executedAt: new Date().toISOString(),
        orderId,
        price,
        qty,
        notional,
        quoteName: quote.name,
        last: quote.last,
      };
      saveRule(ruleFile, rule);
      resetFailures(db, account.zjzh);
      log.info("规则状态已写回: submitted");
    }

    // dry-run 不提交，不能拿现有持仓当成本次成交；只在 live 时等成交/委托
    if (args.live) {
      for (let i = 0; i < 8; i++) {
        const [p2, o2] = await Promise.all([
          broker.positions(account.zjzh),
          broker.orders(account.zjzh),
        ]);
        const held = (p2.positions || []).find((p) => String(p.code) === String(rule.code) && Number(p.qty) > 0);
        const open = (o2.orders || []).find((o) => String(o.code) === String(rule.code));
        if (held) { confirm = { type: "filled", position: held }; break; }
        if (open) { confirm = { type: "open", order: open }; break; }
        await sleep(1500);
      }
      if (confirm?.type === "filled") log.info(`已成交/持仓: ${confirm.position.qty} 股，可用 ${confirm.position.available}`);
      else if (confirm?.type === "open") log.info(`委托仍在队列: ${confirm.order.orderId} ${confirm.order.status}`);
      else log.warn("未在 12 秒内读到持仓/委托，以 H5 为准");
    }

    after = await broker.balance(account.zjzh).catch(() => null);

    logOrder(db, {
      zjzh: account.zjzh,
      orderId,
      code: String(rule.code),
      name: quote.name,
      side: rule.side,
      price,
      qty,
      status: args.live ? "submitted" : "dry_run",
      dryRun: !args.live,
      response: res.response || null,
    });

    const ctx = await finish(true, null);
    const summary = {
      ok: true, ruleId: rule.id, mode, code: rule.code, name: quote.name,
      qty, price, notional, orderId,
      confirm: confirm?.type || "none",
      positionQty: confirm?.type === "filled" ? confirm.position.qty : 0,
      report: path.relative(ROOT, reportFile),
      video: video?.mp4 ? path.relative(ROOT, video.mp4) : (video?.webm ? path.relative(ROOT, video.webm) : null),
      total: ctx.after?.total ?? null,
      cash: ctx.after?.cash ?? null,
    };
    finishRun(db, runId, "ok", JSON.stringify(summary));
    console.log("SUMMARY " + JSON.stringify(summary));
    return 0;
  } catch (e) {
    const msg = (e?.message || String(e)).split("\n")[0];
    log.error("规则执行失败: " + msg);

    // 下单响应丢失时，先查委托，避免误标 failed 后重试造成重复买入
    if (args.live && broker && !orderId) {
      try {
        const o = await broker.orders(account.zjzh);
        const found = (o.orders || []).find((x) => String(x.code) === String(rule.code));
        if (found) {
          orderId = found.orderId;
          rule = { ...rule, status: "submitted", executedAt: new Date().toISOString(), orderId, price, qty, notional };
          saveRule(ruleFile, rule);
          log.warn("在委托列表中发现了同代码委托，按 submitted 处理: " + orderId);
        }
      } catch {}
    }
    if (args.live && !orderId) {
      rule = { ...rule, status: "failed", executedAt: new Date().toISOString(), error: msg, price, qty, notional };
      saveRule(ruleFile, rule);
      bumpFailure(db, account.zjzh);
    }
    raiseAlert("rule_failed", { ruleId: rule.id, mode, code: rule.code, msg, orderId });
    try { await finish(false, msg); } catch {}
    finishRun(db, runId, "failed", msg.slice(0, 500));
    console.log("SUMMARY " + JSON.stringify({
      ok: false, ruleId: rule.id, mode, error: msg, orderId,
      report: reportFile ? path.relative(ROOT, reportFile) : null,
      video: video?.mp4 ? path.relative(ROOT, video.mp4) : (video?.webm ? path.relative(ROOT, video.webm) : null),
    }));
    return 1;
  } finally {
    if (broker) await broker.close().catch(() => {});
    db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL", e?.stack || e);
    process.exit(1);
  });
