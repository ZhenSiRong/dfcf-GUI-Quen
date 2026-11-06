/**
 * 行情源抽象：真实 push2 / 离线 fixture
 * ---------------------------------------------------------------
 * 返回统一结构，runner 与测试都不关心数据来源。
 */
import fs from "node:fs";
import { getQuotes } from "./push2.mjs";
import { getDailyBarsBatch } from "./history.mjs";
import { MARKET_FIXTURE } from "../config.mjs";

export function createMarket({ mock = false, fixture = MARKET_FIXTURE } = {}) {
  if (!mock) {
    return {
      mock: false,
      async quotes(codes) { return getQuotes(codes); },
      async bars(codes, limit = 90) { return getDailyBarsBatch(codes, limit); },
    };
  }

  if (!fs.existsSync(fixture)) throw new Error("缺少行情 fixture: " + fixture);
  const data = JSON.parse(fs.readFileSync(fixture, "utf8"));
  const qMap = new Map(Object.entries(data.quotes || {}));
  const bMap = new Map(Object.entries(data.bars || {}));
  return {
    mock: true,
    generatedAt: data.generatedAt,
    async quotes(codes) {
      const out = new Map();
      for (const c of codes) if (qMap.has(String(c))) out.set(String(c), { ...qMap.get(String(c)), ts: Date.now() });
      return out;
    },
    async bars(codes) {
      const out = new Map();
      for (const c of codes) if (bMap.has(String(c))) out.set(String(c), bMap.get(String(c)).map((b) => ({ ...b })));
      return out;
    },
  };
}
