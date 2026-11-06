#!/usr/bin/env node
/**
 * doctor —— 无人值守巡检
 * ---------------------------------------------------------------
 * 检查：登录态有效期 / Broker 健康 / 账户快照 / 当前时段
 * 用法：node scripts/doctor.mjs
 * 退出码：0 健康；2 登录态失效；1 其他异常
 */
import fs from "node:fs";
import { WapBroker } from "../src/broker/wap.mjs";
import { STATE_FILE, loadAccount } from "../src/config.mjs";
import { shanghaiNow, sessionState } from "../src/util/time.mjs";
import { createLogger, raiseAlert } from "../src/util/log.mjs";

process.umask(0o077);

const log = createLogger("doctor");
const account = loadAccount();

function cookieReport() {
  if (!fs.existsSync(STATE_FILE)) return { ok: false, reason: "缺少登录态文件" };
  const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const cookies = st.cookies || [];
  const names = new Set(cookies.map((c) => c.name));
  const has = ["ct", "ut", "uidal"].every((n) => names.has(n));
  if (!has) return { ok: false, reason: "缺少 ct/ut/uidal" };

  const now = Date.now() / 1000;
  const ct = cookies.find((c) => c.name === "ct");
  const daysLeft = ct?.expires > 0 ? (ct.expires - now) / 86400 : null;
  return { ok: true, count: cookies.length, daysLeft };
}

function checkState() {
  const r = cookieReport();
  if (!r.ok) return r;
  if (r.daysLeft !== null && r.daysLeft < 7) {
    return { ...r, warn: `登录 cookie 仅剩 ${r.daysLeft.toFixed(1)} 天` };
  }
  return r;
}

async function main() {
  const now = shanghaiNow();
  log.info(`巡检 ${now.date} ${now.time}（周${"日一二三四五六"[now.weekday]}）组合 ${account.name}/${account.zjzh}`);

  const ck = checkState();
  if (!ck.ok) {
    log.error("登录态不可用: " + ck.reason);
    raiseAlert("login_state_missing", { reason: ck.reason });
    console.log("SUMMARY " + JSON.stringify({ ok: false, stage: "cookie", reason: ck.reason }));
    return 2;
  }
  log.info(`登录 cookie: ${ck.count} 个，ct 剩余 ${ck.daysLeft === null ? "未知" : ck.daysLeft.toFixed(1) + " 天"}`);
  if (ck.warn) {
    log.warn(ck.warn + "，请尽快重新登录续期");
    raiseAlert("login_expiring", { daysLeft: ck.daysLeft });
  }

  const s = sessionState(now);
  log.info(`时段: ${s.reason}（可下单=${s.ok}，可撤单=${s.canCancel}）`);

  let broker;
  try {
    broker = await WapBroker.create({ headless: true, log: (m) => log.info(m) });
    const h = await broker.health(account.zjzh);
    if (!h.ok) {
      log.error("Broker 健康检查失败: " + (h.reason || h.message));
      raiseAlert("login_expired_or_api_failed", { zjzh: account.zjzh, health: h });
      console.log("SUMMARY " + JSON.stringify({ ok: false, stage: "broker", health: h }));
      return 2;
    }
    if (broker.persist) await broker.persist();
    const [pos, orders] = await Promise.all([broker.positions(account.zjzh), broker.orders(account.zjzh)]);
    log.info(`账户: 总资产=${h.total} 可用=${h.cash} 持仓=${pos.positions.length} 未成交=${orders.orders.length}`);
    console.log("SUMMARY " + JSON.stringify({
      ok: true, zjzh: account.zjzh, total: h.total, cash: h.cash,
      positions: pos.positions.length, openOrders: orders.orders.length,
      session: s.reason, loginDaysLeft: ck.daysLeft,
    }));
    return 0;
  } catch (e) {
    log.error("巡检异常: " + (e?.message || e));
    raiseAlert("doctor_failed", { zjzh: account.zjzh, msg: e?.message || String(e) });
    console.log("SUMMARY " + JSON.stringify({ ok: false, stage: "exception", error: e?.message || String(e) }));
    return 1;
  } finally {
    if (broker) await broker.close().catch(() => {});
  }
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error("FATAL", e?.stack || e);
  process.exit(1);
});
