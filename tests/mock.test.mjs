import test from "node:test";
import assert from "node:assert/strict";
import { MockBroker } from "../src/broker/mock.mjs";

const fresh = () => new MockBroker({ cash: 100_000, positions: [{ code: "600028", name: "中国石化", qty: 1000, available: 1000, cost: 5.5, last: 5.7 }] });

test("mock: dry-run 不改变任何状态", async () => {
  const b = fresh();
  const before = await b.balance();
  const r = await b.place({ side: "buy", code: "601398", price: 8.35, qty: 100, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  const after = await b.balance();
  assert.equal(after.cash, before.cash);
  assert.equal(after.frozen, before.frozen);
  assert.equal((await b.orders()).orders.length, 0);
});

test("mock: 真实买入冻结资金，撤单后完全释放", async () => {
  const b = fresh();
  const before = await b.balance();
  const r = await b.place({ side: "buy", code: "601398", price: 8.35, qty: 100, dryRun: false });
  assert.equal(r.ok, true);
  assert.match(r.orderId, /^MOCK/);

  const mid = await b.balance();
  assert.ok(mid.cash < before.cash);
  assert.ok(mid.frozen > 0);
  assert.equal(mid.total.toFixed(2), before.total.toFixed(2));

  const c = await b.cancel({ orderId: r.orderId, dryRun: false });
  assert.equal(c.ok, true);
  const after = await b.balance();
  assert.equal(after.cash.toFixed(3), before.cash.toFixed(3));
  assert.equal(after.frozen, 0);
  assert.equal((await b.orders()).orders.length, 0);
});

test("mock: 卖出减少持仓，撤单恢复", async () => {
  const b = fresh();
  const r = await b.place({ side: "sell", code: "600028", price: 5.7, qty: 400, dryRun: false });
  assert.equal(r.ok, true);
  let pos = (await b.positions()).positions.find((p) => p.code === "600028");
  assert.equal(pos.qty, 600);
  assert.equal(pos.available, 600);

  await b.cancel({ orderId: r.orderId, dryRun: false });
  pos = (await b.positions()).positions.find((p) => p.code === "600028");
  assert.equal(pos.qty, 1000);
});

test("mock: 资金不足/持仓不足拒绝", async () => {
  const b = fresh();
  const buy = await b.place({ side: "buy", code: "601398", price: 8.35, qty: 100_000, dryRun: false });
  assert.equal(buy.ok, false);
  const sell = await b.place({ side: "sell", code: "600028", price: 5.7, qty: 10_000, dryRun: false });
  assert.equal(sell.ok, false);
});

test("mock: 从脱敏快照回放", async () => {
  const b = MockBroker.fromSnapshot("fixtures/snapshot_demo.json", "demo");
  const bal = await b.balance();
  assert.equal(bal.total, 1_000_000);
  assert.equal((await b.positions()).positions.length, 0);
});
