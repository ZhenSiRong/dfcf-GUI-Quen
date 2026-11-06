import test from "node:test";
import assert from "node:assert/strict";
import { sma, smaTrend, decide, decideAll } from "../src/strategy/sma.mjs";

const bars = (closes) => closes.map((close, i) => ({ date: `d${String(i).padStart(2, "0")}`, close }));
const up = Array.from({ length: 40 }, (_, i) => 10 + i * 0.05);
const down = Array.from({ length: 40 }, (_, i) => 12 - i * 0.05);
const flat = Array.from({ length: 40 }, () => 10);

test("sma: 最后 n 个值的均值", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
  assert.equal(sma([1, 2], 3), null);
});

test("smaTrend: 上涨 = bull，下跌 = bear，横盘 = neutral", () => {
  assert.equal(smaTrend(up).trend, "bull");
  assert.equal(smaTrend(down).trend, "bear");
  assert.equal(smaTrend(flat).trend, "neutral");
});

test("decide: 空仓 + 上涨趋势 → buy", () => {
  const s = decide({ code: "601398", bars: bars(up), positionQty: 0 });
  assert.equal(s.action, "buy");
  assert.equal(s.reason, "bull_trend");
});

test("decide: 持仓 + 下跌趋势 → sell", () => {
  const s = decide({ code: "601398", bars: bars(down), positionQty: 100 });
  assert.equal(s.action, "sell");
  assert.equal(s.reason, "bear_trend");
});

test("decide: 空仓 + 下跌趋势 → hold", () => {
  const s = decide({ code: "601398", bars: bars(down), positionQty: 0 });
  assert.equal(s.action, "hold");
  assert.equal(s.reason, "not_bull");
});

test("decide: 持仓 + 上涨趋势 → hold", () => {
  const s = decide({ code: "601398", bars: bars(up), positionQty: 100 });
  assert.equal(s.action, "hold");
  assert.equal(s.reason, "trend_intact");
});

test("decide: 历史不足 → hold", () => {
  const s = decide({ code: "601398", bars: bars(up.slice(0, 20)), positionQty: 0 });
  assert.equal(s.action, "hold");
  assert.equal(s.reason, "insufficient_bars");
});

test("decide: 金叉买入", () => {
  const closes = [...Array(39).fill(10), 10.6];
  const s = decide({ code: "601398", bars: bars(closes), positionQty: 0 });
  assert.equal(s.action, "buy");
  assert.equal(s.reason, "golden_cross");
});

test("decide: 死叉卖出", () => {
  const closes = [...Array(39).fill(10), 9.4];
  const s = decide({ code: "601398", bars: bars(closes), positionQty: 100 });
  assert.equal(s.action, "sell");
  assert.equal(s.reason, "death_cross");
});

test("decide: 不追高", () => {
  const closes = [...up, 13];
  const s = decide({ code: "601398", bars: bars(closes), positionQty: 0 });
  assert.equal(s.action, "hold");
  assert.equal(s.reason, "too_extended");
});

test("decideAll: 缺失行情的代码不报错", () => {
  const out = decideAll({
    universe: ["601398", "999999"],
    barsByCode: new Map([["601398", bars(up)]]),
    positionQtyByCode: {},
  });
  assert.equal(out.length, 2);
  assert.equal(out[1].reason, "no_bars");
});
