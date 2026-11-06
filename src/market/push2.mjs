/**
 * 行情源：push2.eastmoney.com（直连，无需浏览器）
 * ---------------------------------------------------------------
 * 只读取原始数据，不做任何交易决策。
 * 价格单位：push2 返回的是「分」，这里统一转成元。
 */
import { PUSH2, PUSH2_UT } from "../config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, { timeout = 10000, retries = 3 } = {}) {
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

/** 6 位代码 → push2 secid。沪=1，深/北=0 */
export function secidOf(code) {
  const c = String(code).padStart(6, "0");
  if (/^(6|5|9)/.test(c)) return "1." + c;
  return "0." + c;
}

function normalize(d) {
  if (!d || d.f43 === undefined || d.f43 === "-") return null;
  const scale = 100;
  return {
    code: d.f57,
    name: d.f58,
    last: Number(d.f43) / scale,
    prevClose: Number(d.f60) / scale,
    changePct: d.f170 === undefined ? null : Number(d.f170) / 100,
    high: d.f44 !== undefined && d.f44 !== "-" ? Number(d.f44) / scale : null,
    low: d.f45 !== undefined && d.f45 !== "-" ? Number(d.f45) / scale : null,
    open: d.f46 !== undefined && d.f46 !== "-" ? Number(d.f46) / scale : null,
    volume: d.f47 ?? null,
    amount: d.f48 ?? null,
    quoteTime: d.f86 ? Number(d.f86) : null, // 交易所最后更新时间（秒）
    ts: Date.now(),
  };
}

/** 单只行情 */
export async function getQuote(code) {
  const url = `${PUSH2}?secid=${secidOf(code)}&ut=${PUSH2_UT}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f170`;
  const j = await getJSON(url);
  return normalize(j?.data);
}

/** 批量行情（一次最多 50 只） */
export async function getQuotes(codes) {
  const out = new Map();
  const chunks = [];
  const list = [...new Set(codes.map((c) => String(c).padStart(6, "0")))];
  for (let i = 0; i < list.length; i += 50) chunks.push(list.slice(i, i + 50));

  for (const chunk of chunks) {
    const secids = chunk.map(secidOf).join(",");
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&ut=${PUSH2_UT}&fields=f2,f12,f13,f14,f18,f15,f16,f17`;
    const j = await getJSON(url);
    for (const d of j?.data?.diff || []) {
      const last = Number(d.f2) / 100;
      const prevClose = Number(d.f18) / 100;
      if (!Number.isFinite(last) || last <= 0 || !Number.isFinite(prevClose) || prevClose <= 0) continue;
      out.set(d.f12, {
        code: d.f12,
        name: d.f14,
        last,
        prevClose,
        high: Number(d.f15) / 100,
        low: Number(d.f16) / 100,
        open: Number(d.f17) / 100,
        ts: Date.now(),
      });
    }
  }
  return out;
}

/**
 * 涨跌停价。
 * 主板 ±10%，创业板/科创板 ±20%，北交所 ±30%，ST ±5%。
 * 这里只做保守估算，用于「永不成交」的下单价与风控校验。
 */
export function limitPrices(quote, code) {
  const c = String(code);
  let pct = 0.1;
  if (/^(300|301|688|689)/.test(c)) pct = 0.2;
  else if (/^(8|4|92)/.test(c)) pct = 0.3;
  if (/ST/i.test(String(quote?.name || ""))) pct = 0.05;
  const base = quote?.prevClose || quote?.last;
  if (!base) return null;
  const round2 = (x) => Math.round(x * 100) / 100;
  return { up: round2(base * (1 + pct)), down: round2(base * (1 - pct)), pct };
}
