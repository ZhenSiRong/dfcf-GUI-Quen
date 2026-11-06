/**
 * 生成 fixtures/market.json（真实行情快照，供 --mock 端到端回放）
 * 用法：node tools/make_market_fixture.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { getQuotes } from "../src/market/push2.mjs";
import { getDailyBarsBatch } from "../src/market/history.mjs";
import { loadUniverse, MARKET_FIXTURE } from "../src/config.mjs";

const uni = loadUniverse();
const quotesMap = await getQuotes(uni.codes);
const barsMap = await getDailyBarsBatch(uni.codes, 90);

const quotes = {};
for (const [code, q] of quotesMap) quotes[code] = q;
const bars = {};
for (const [code, b] of barsMap) bars[code] = b;

fs.mkdirSync(path.dirname(MARKET_FIXTURE), { recursive: true });
fs.writeFileSync(MARKET_FIXTURE, JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: "真实行情回放，仅供 --mock 使用；不是实时数据",
  codes: uni.codes,
  quotes,
  bars,
}, null, 2));
console.log("written", MARKET_FIXTURE, "quotes=", Object.keys(quotes).length, "bars=", Object.keys(bars).length);
for (const c of uni.codes) {
  const q = quotes[c], b = bars[c];
  console.log(c, q?.name, "last=" + q?.last, "bars=" + (Array.isArray(b) ? b.length : String(b?.error)));
}
