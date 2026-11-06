/**
 * 调度：决定「这一次是否应该真的执行交易」。
 * ---------------------------------------------------------------
 * 与 time.mjs 的分工：
 *  - time.mjs 只回答「现在是不是交易时段」
 *  - 这里回答「这一次运行要不要下单」，并区分 dry-run / live
 */
import { canPlaceNewOrder, shanghaiNow } from "../util/time.mjs";

/**
 * @param {object} o
 * @param {object} [o.now] shanghaiNow() 的返回值
 * @param {boolean} [o.live] 是否真实下单
 * @param {boolean} [o.force] 人工强制执行（跳过时段检查）
 */
export function decideSession({ now = shanghaiNow(), live = false, force = false } = {}) {
  const s = canPlaceNewOrder(now);
  const base = { live, force, session: s, now };

  // 周末 / 清算期：任何情况下都不执行真实交易
  if (live && (s.reason === "weekend" || s.reason === "clearing_1500_1700")) {
    return { ...base, run: false, reason: s.reason };
  }

  // dry-run 随时可跑（只读 + 模拟）
  if (!live) {
    return { ...base, run: true, reason: s.ok ? s.reason : "dry_run_anytime" };
  }

  if (s.ok) return { ...base, run: true, reason: s.reason };

  if (force) return { ...base, run: true, reason: "forced_live_" + s.reason };

  return { ...base, run: false, reason: s.reason };
}

/**
 * 同一交易日内是否已经跑过 live。
 * 返回 null 表示没跑过；否则返回最后一次运行记录。
 */
export function findTodayLiveRun(db, date = shanghaiNow().date) {
  const row = db
    .prepare("SELECT * FROM runs WHERE date(ts, '+8 hours')=? AND mode='live' AND status='ok' ORDER BY id DESC LIMIT 1")
    .get(date);
  return row || null;
}
