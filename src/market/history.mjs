/**
 * 日 K 历史：push2his.eastmoney.com（直连，无需浏览器）
 * ---------------------------------------------------------------
 * 用于日线 SMA 策略。返回按时间升序的 bar 数组。
 */
import { secidOf } from "./push2.mjs";

const PUSH2HIS = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const UT = "b2884a393a59ad64002292a3e90d46a5";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, { timeout = 12000, retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(300 * 2 ** i);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/**
 * 取日 K（前复权）。
 * @param {string} code 6 位代码
 * @param {number} limit 取最近多少根
 * @returns {Promise<Array<{date:string, open:number, close:number, high:number, low:number, volume:number}>>}
 */
export async function getDailyBars(code, limit = 120) {
  const secid = secidOf(code);
  const url =
    `${PUSH2HIS}?secid=${secid}&ut=${UT}` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58` +
    `&klt=101&fqt=1&lmt=${Math.max(30, Math.min(1000, limit))}&end=20500101`;
  const j = await getJSON(url);
  const rows = j?.data?.klines || [];
  return rows.map((line) => {
    const [date, open, close, high, low, volume] = line.split(",");
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
    };
  }).filter((b) => Number.isFinite(b.close));
}

/** 批量取日 K，顺序执行避免触发限流 */
export async function getDailyBarsBatch(codes, limit = 120) {
  const out = new Map();
  for (const code of codes) {
    try {
      out.set(String(code), await getDailyBars(code, limit));
    } catch (e) {
      out.set(String(code), { error: e.message.split("\n")[0] });
    }
    await sleep(120);
  }
  return out;
}
