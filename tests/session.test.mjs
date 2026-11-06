import test from "node:test";
import assert from "node:assert/strict";
import { decideSession } from "../src/scheduler/session.mjs";
import { shanghaiNow } from "../src/util/time.mjs";

const at = (iso) => shanghaiNow(new Date(iso));

test("session: 交易时段 live 允许", () => {
  const s = decideSession({ now: at("2026-11-06T02:00:00Z"), live: true });
  assert.equal(s.run, true);
  assert.equal(s.reason, "trading");
});

test("session: dry-run 非交易时段也允许", () => {
  const s = decideSession({ now: at("2026-11-06T04:00:00Z"), live: false });
  assert.equal(s.run, true);
  assert.equal(s.reason, "dry_run_anytime");
});

test("session: live + 非交易时段默认拒绝", () => {
  const s = decideSession({ now: at("2026-11-06T04:00:00Z"), live: true });
  assert.equal(s.run, false);
  assert.equal(s.reason, "off_hours");
});

test("session: live + 非交易时段 + force 允许", () => {
  const s = decideSession({ now: at("2026-11-06T04:00:00Z"), live: true, force: true });
  assert.equal(s.run, true);
  assert.equal(s.reason, "forced_live_off_hours");
});

test("session: 清算期 live 即使 force 也拒绝", () => {
  const s = decideSession({ now: at("2026-11-06T07:30:00Z"), live: true, force: true });
  assert.equal(s.run, false);
  assert.equal(s.reason, "clearing_1500_1700");
});

test("session: 周末 live 即使 force 也拒绝", () => {
  const s = decideSession({ now: at("2026-11-07T02:00:00Z"), live: true, force: true });
  assert.equal(s.run, false);
  assert.equal(s.reason, "weekend");
});
