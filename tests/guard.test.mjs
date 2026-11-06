import test from "node:test";
import assert from "node:assert/strict";
import { checkOrder, normalizeSellQty } from "../src/risk/guard.mjs";

const quote = { code: "601398", name: "工商银行", last: 8.35, prevClose: 8.41 };
const balance = { total: 1_000_000, cash: 1_000_000 };
const noPos = new Map();

function check(over = {}) {
  return checkOrder({
    side: "buy", code: "601398", price: 8.35, qty: 100,
    quote, balance, positions: noPos, todayOrders: 0, consecutiveFailures: 0,
    ...over,
  });
}

test("guard: 正常买入通过", () => {
  const r = check();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rule, "ok");
});

test("guard: 买入必须整手", () => {
  const r = check({ qty: 150 });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "lot_size");
});

test("guard: 单笔金额上限 5000", () => {
  const r = check({ qty: 600 }); // 5010 元
  assert.equal(r.ok, false);
  assert.equal(r.rule, "notional");
});

test("guard: 价格偏离最新价 > 3% 拒绝", () => {
  const r = check({ price: 8.62 });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "price_deviation");
});

test("guard: 价格超出涨跌停带优先拒绝", () => {
  const r = check({ price: 9.3 });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "limit_band");
});

test("guard: 可用资金不足", () => {
  const r = check({ balance: { total: 1_000_000, cash: 500 } });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "insufficient_cash");
});

test("guard: 单票集中度上限", () => {
  const r = check({ balance: { total: 1000, cash: 1000 } });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "concentration");
});

test("guard: 最低现金保留", () => {
  const r = check({ balance: { total: 1_000_000, cash: 5_100 } });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "cash_reserve");
});

test("guard: 卖出不得超过持仓", () => {
  const positions = new Map([["601398", { code: "601398", qty: 100, marketValue: 835 }]]);
  const r = check({ side: "sell", qty: 200, positions });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "insufficient_position");
});

test("guard: 卖出持仓内数量通过", () => {
  const positions = new Map([["601398", { code: "601398", qty: 100, marketValue: 835 }]]);
  const r = check({ side: "sell", qty: 100, positions });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("guard: 连败熔断", () => {
  const r = check({ consecutiveFailures: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "circuit_breaker");
});

test("guard: 单日笔数上限", () => {
  const r = check({ todayOrders: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "daily_limit");
});

test("guard: 非法方向/价格/数量", () => {
  assert.equal(check({ side: "hold" }).rule, "side");
  assert.equal(check({ price: NaN }).rule, "price");
  assert.equal(check({ qty: 0 }).rule, "qty");
});

test("guard: 无行情拒绝", () => {
  const r = check({ quote: null });
  assert.equal(r.ok, false);
  assert.equal(r.rule, "quote");
});

test("guard: 规则可显式覆盖单笔上限，默认仍是 5000", () => {
  const quote603259 = { code: "603259", name: "药明康德", last: 150.59, prevClose: 154.46 };
  const base = {
    side: "buy", code: "603259", price: 151.34, qty: 100,
    quote: quote603259, balance: { total: 1_000_000, cash: 1_000_000 },
    positions: new Map(), todayOrders: 0, consecutiveFailures: 0,
  };
  assert.equal(checkOrder(base).rule, "notional");
  const r = checkOrder({ ...base, cfg: { maxNotionalPerOrder: 16000 } });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("normalizeSellQty: 零股/整手/超量", () => {
  assert.equal(normalizeSellQty(150, 200), 150);
  assert.equal(normalizeSellQty(150, 200, { allowOdd: false }), 100);
  assert.equal(normalizeSellQty(300, 200), 200);
  assert.equal(normalizeSellQty(0, 200), 0);
});
