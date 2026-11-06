#!/usr/bin/env node
/**
 * verify_broker —— 重构后 WapBroker 的真实链路自检
 * ---------------------------------------------------------------
 * 步骤：
 *  1. health + 运行前快照（要求 0 未成交委托）
 *  2. place(live) 100 股 @ 跌停价（永不成交）
 *  3. orders() 确认委托存在
 *  4. cancel(dry-run) → 弹窗出现并取消，委托仍在
 *  5. cancel(live)   → 委托消失、冻结释放
 *
 * 任何一步失败都会尽力撤单；撤单失败则写告警并保留现场。
 *
 * ⚠️ 这是人工诊断工具：为了用「永不成交」的跌停价，它绕过了日常风控的
 *    3% 价格偏离限制。不要拿它当交易入口；日常交易走 src/runner.mjs。
 *
 * 用法：node scripts/verify_broker.mjs
 */
import { WapBroker } from "../src/broker/wap.mjs";
import { loadAccount } from "../src/config.mjs";
import { getQuote, limitPrices } from "../src/market/push2.mjs";
import { createLogger, raiseAlert } from "../src/util/log.mjs";

process.umask(0o077);

const log = createLogger("verify_broker");
const account = loadAccount();
const CODE = "601398";
const QTY = 100;

let broker;
let placedOrderId = null;
let cleaned = false;

async function readState() {
  const [bal, ord] = await Promise.all([broker.balance(account.zjzh), broker.orders(account.zjzh)]);
  return { bal, ord };
}

async function main() {
  broker = await WapBroker.create({ headless: true, log: (m) => log.info(m) });
  const h = await broker.health(account.zjzh);
  if (!h.ok) throw new Error("健康检查失败: " + JSON.stringify(h));
  if (broker.persist) await broker.persist();

  const before = await readState();
  log.info(`运行前 总资产=${before.bal.total} 可用=${before.bal.cash} 冻结=${before.bal.frozen} 委托=${before.ord.orders.length}`);
  if (before.ord.orders.length !== 0) {
    throw new Error("当前存在未成交委托，先人工清理后再跑本脚本");
  }

  const quote = await getQuote(CODE);
  if (!quote) throw new Error("无法取得行情");
  const lim = limitPrices(quote, CODE);
  const price = lim.down; // 跌停价：买价远低于现价，不会成交
  log.info(`行情 ${CODE} ${quote.name} last=${quote.last} prevClose=${quote.prevClose} 跌停=${price}`);

  // 1) 真实下单（跌停价，不会成交）
  const r = await broker.place({
    zjzh: account.zjzh,
    comboName: account.name,
    side: "buy",
    code: CODE,
    price,
    qty: QTY,
    dryRun: false,
  });
  log.info("place 返回: " + JSON.stringify(r));
  if (!r.ok || !r.orderId) throw new Error("下单失败: " + JSON.stringify(r.response));
  placedOrderId = r.orderId;

  // 2) 等待委托出现在可撤列表
  let mid = null;
  for (let i = 0; i < 6; i++) {
    mid = await readState();
    if (mid.ord.orders.some((o) => o.orderId === placedOrderId)) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!mid || !mid.ord.orders.some((o) => o.orderId === placedOrderId)) {
    throw new Error("委托未出现在可撤列表");
  }
  log.info(`✔ 委托已出现 ${placedOrderId}，冻结=${mid.bal.frozen}`);

  // 3) 撤单 dry-run：只到弹窗，不点确定
  const dry = await broker.cancel({
    zjzh: account.zjzh, comboName: account.name, orderId: placedOrderId, dryRun: true,
  });
  if (!dry.ok) throw new Error("撤单 dry-run 失败: " + JSON.stringify(dry));
  const still = await readState();
  if (!still.ord.orders.some((o) => o.orderId === placedOrderId)) {
    throw new Error("撤单 dry-run 不应真正撤销，但委托消失了");
  }
  log.info("✔ 撤单 dry-run：弹窗核对通过，委托仍在");

  // 4) 真正撤单
  const c = await broker.cancel({
    zjzh: account.zjzh, comboName: account.name, orderId: placedOrderId, dryRun: false,
  });
  if (!c.ok) throw new Error("真实撤单失败: " + JSON.stringify(c));
  cleaned = true;

  const after = await readState();
  if (after.ord.orders.some((o) => o.orderId === placedOrderId)) {
    throw new Error("撤单后委托仍存在");
  }
  if (Number(after.bal.frozen) !== 0) throw new Error("撤单后仍有冻结资金: " + after.bal.frozen);
  log.info(`✔ 撤单成功：委托消失，冻结=0，可用=${after.bal.cash}/${after.bal.initial}`);

  const summary = {
    ok: true, orderId: placedOrderId, price, qty: QTY,
    before: { total: before.bal.total, cash: before.bal.cash },
    after: { total: after.bal.total, cash: after.bal.cash, frozen: after.bal.frozen },
  };
  console.log("SUMMARY " + JSON.stringify(summary));
  return 0;
}

async function cleanup() {
  if (!placedOrderId || cleaned) return;
  try {
    log.warn("尝试清理遗留委托 " + placedOrderId);
    const c = await broker.cancel({
      zjzh: account.zjzh, comboName: account.name, orderId: placedOrderId, dryRun: false,
    });
    if (c.ok) {
      cleaned = true;
      log.info("清理成功");
    } else {
      throw new Error(JSON.stringify(c));
    }
  } catch (e) {
    log.error("清理失败，委托可能仍存在: " + (e?.message || e));
    raiseAlert("verify_broker_cleanup_failed", { orderId: placedOrderId, error: e?.message || String(e) });
  }
}

try {
  const code = await main();
  await broker?.close().catch(() => {});
  process.exit(code);
} catch (e) {
  log.error("FAILED: " + (e?.message || e));
  await cleanup();
  await broker?.close().catch(() => {});
  process.exit(1);
}
