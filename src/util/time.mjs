/**
 * 时间与交易时段判断（全部按 Asia/Shanghai）
 * ---------------------------------------------------------------
 * 规则来源：东方财富官方帮助 Q037
 *  - 15:00—17:00 清算，不接受委托/撤单
 *  - 其他时间均可接受委托（含隔夜单）
 *  - 当日未成交委托在日中清算时自动撤销
 */
import { SESSIONS } from "../config.mjs";

const TZ = "Asia/Shanghai";

/** 返回上海时区的 {date:"2026-11-06", time:"09:30", minutes:570, weekday:1} */
export function shanghaiNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hh = Number(get("hour")) % 24;
  const mm = Number(get("minute"));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    minutes: hh * 60 + mm,
    weekday: weekdayMap[get("weekday")],
    iso: d.toISOString(),
  };
}

export function parseHHMM(s) {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function inRanges(minutes, ranges) {
  return ranges.some(([a, b]) => minutes >= parseHHMM(a) && minutes < parseHHMM(b));
}

/**
 * 当前是否允许「新开仓/新委托」。
 * 注意：清算期连撤单都不允许。
 */
export function sessionState(now = shanghaiNow()) {
  if (now.weekday === 0 || now.weekday === 6) {
    return { ok: false, reason: "weekend", canCancel: false };
  }
  if (inRanges(now.minutes, SESSIONS.clearing)) {
    return { ok: false, reason: "clearing_1500_1700", canCancel: false };
  }
  if (inRanges(now.minutes, SESSIONS.auction)) {
    return { ok: false, reason: "call_auction_0915_0930", canCancel: true };
  }
  if (!inRanges(now.minutes, SESSIONS.trading)) {
    return { ok: false, reason: "off_hours", canCancel: true };
  }
  if (now.minutes >= parseHHMM(SESSIONS.noNewOrderAfter)) {
    return { ok: false, reason: "too_close_to_close", canCancel: true };
  }
  return { ok: true, reason: "trading", canCancel: true };
}

/**
 * 是否允许「下单」——比 sessionState 更严格：
 * 隔夜单是官方允许的，但本项目只在交易时段开新仓（低频日终策略）。
 * 想放宽时把 allowOvernight 打开即可。
 */
export function canPlaceNewOrder(now = shanghaiNow(), { allowOvernight = false } = {}) {
  const s = sessionState(now);
  if (s.ok) return s;
  if (allowOvernight && (s.reason === "off_hours" || s.reason === "call_auction_0915_0930")) {
    return { ok: true, reason: "overnight_allowed", canCancel: true };
  }
  return s;
}

/** 下一个交易时段的开始时间（分钟数，跨日返回次日 9:30 的标记） */
export function nextTradingStart(now = shanghaiNow()) {
  const opens = [parseHHMM("09:30"), parseHHMM("13:00")];
  for (const o of opens) if (now.minutes < o) return { sameDay: true, minutes: o };
  return { sameDay: false, minutes: parseHHMM("09:30") };
}
