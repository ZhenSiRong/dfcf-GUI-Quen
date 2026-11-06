import test from "node:test";
import assert from "node:assert/strict";
import { shanghaiNow, sessionState, canPlaceNewOrder } from "../src/util/time.mjs";

// 2026-11-06 是周五；UTC+8
const at = (iso) => shanghaiNow(new Date(iso));

test("time: 上海时区与工作日解析", () => {
  const n = at("2026-11-06T01:30:00Z"); // 09:30 北京
  assert.equal(n.date, "2026-11-06");
  assert.equal(n.time, "09:30");
  assert.equal(n.minutes, 570);
  assert.equal(n.weekday, 5);
});

test("time: 交易时段允许下单", () => {
  const s = sessionState(at("2026-11-06T02:00:00Z")); // 10:00
  assert.equal(s.ok, true);
  assert.equal(s.canCancel, true);
});

test("time: 午休不可下单但可撤单", () => {
  const s = sessionState(at("2026-11-06T04:00:00Z")); // 12:00
  assert.equal(s.ok, false);
  assert.equal(s.reason, "off_hours");
  assert.equal(s.canCancel, true);
});

test("time: 集合竞价不可下单", () => {
  const s = sessionState(at("2026-11-06T01:20:00Z")); // 09:20
  assert.equal(s.ok, false);
  assert.equal(s.reason, "call_auction_0915_0930");
  assert.equal(s.canCancel, true);
});

test("time: 清算期既不可下单也不可撤单", () => {
  const s = sessionState(at("2026-11-06T07:30:00Z")); // 15:30
  assert.equal(s.ok, false);
  assert.equal(s.reason, "clearing_1500_1700");
  assert.equal(s.canCancel, false);
});

test("time: 尾盘 14:56 停止开新仓", () => {
  const s = sessionState(at("2026-11-06T06:56:00Z")); // 14:56
  assert.equal(s.ok, false);
  assert.equal(s.reason, "too_close_to_close");
});

test("time: 周末拒绝", () => {
  const s = sessionState(at("2026-11-07T02:00:00Z")); // 周六 10:00
  assert.equal(s.ok, false);
  assert.equal(s.reason, "weekend");
});

test("time: allowOvernight 只放宽非清算时段", () => {
  const noon = canPlaceNewOrder(at("2026-11-06T04:00:00Z"), { allowOvernight: true });
  assert.equal(noon.ok, true);
  assert.equal(noon.reason, "overnight_allowed");

  const clearing = canPlaceNewOrder(at("2026-11-06T07:30:00Z"), { allowOvernight: true });
  assert.equal(clearing.ok, false);
});
