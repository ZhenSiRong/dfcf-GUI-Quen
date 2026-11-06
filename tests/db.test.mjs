import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDb, startRun, finishRun, logOrder, todayOrderCount,
  snapshotBalance, snapshotPositions, setKv, getKv,
  bumpFailure, getFailures, resetFailures, dailyReport,
} from "../src/store/db.mjs";
import { shanghaiNow } from "../src/util/time.mjs";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quan-db-"));
  return { db: openDb(path.join(dir, "t.db")), dir };
}

test("db: run 生命周期", () => {
  const { db } = tmpDb();
  const id = startRun(db, "dry-run");
  assert.ok(id > 0);
  finishRun(db, id, "ok", "done");
  const row = db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  assert.equal(row.status, "ok");
  assert.equal(row.mode, "dry-run");
});

test("db: 委托落库 + 当日真实委托计数（按北京时间切日）", () => {
  const { db } = tmpDb();
  logOrder(db, { zjzh: "Z1", code: "601398", side: "buy", price: 8.35, qty: 100, dryRun: false, status: "submitted" });
  logOrder(db, { zjzh: "Z1", code: "600028", side: "buy", price: 5.7, qty: 100, dryRun: true, status: "submitted" });

  const today = shanghaiNow().date;
  assert.equal(todayOrderCount(db, "Z1", today), 1, "dry-run 不计入真实笔数");
  assert.equal(todayOrderCount(db, "Z1", "1999-01-01"), 0);
});

test("db: 北京时间 00:30 的委托归属当天", () => {
  const { db } = tmpDb();
  db.prepare(
    "INSERT INTO orders (ts, zjzh, code, side, price, qty, status, dry_run) VALUES (?,?,?,?,?,?,?,?)",
  ).run("2026-11-05T16:30:00.000Z", "Z2", "601398", "buy", 8.35, 100, "submitted", 0);
  assert.equal(todayOrderCount(db, "Z2", "2026-11-06"), 1);
  assert.equal(todayOrderCount(db, "Z2", "2026-11-05"), 0);
});

test("db: 快照与日报", () => {
  const { db } = tmpDb();
  snapshotBalance(db, "Z1", { total: 1_000_000, cash: 900_000, marketValue: 100_000, frozen: 0 });
  snapshotPositions(db, "Z1", [
    { code: "601398", name: "工商银行", qty: 100, cost: 8.3, marketValue: 835, pnl: 5 },
  ]);
  const today = shanghaiNow().date;
  const r = dailyReport(db, today);
  assert.ok(Array.isArray(r.orders));
  assert.ok(Array.isArray(r.runs));
  const b = db.prepare("SELECT * FROM balance_snapshot").get();
  assert.equal(b.total, 1_000_000);
  const p = db.prepare("SELECT * FROM positions_snapshot").get();
  assert.equal(p.code, "601398");
});

test("db: kv 与连败计数", () => {
  const { db } = tmpDb();
  assert.equal(getKv(db, "missing", 42), 42);
  setKv(db, "k", { a: 1 });
  assert.deepEqual(getKv(db, "k"), { a: 1 });

  assert.equal(getFailures(db, "Z1"), 0);
  bumpFailure(db, "Z1");
  bumpFailure(db, "Z1");
  assert.equal(getFailures(db, "Z1"), 2);
  resetFailures(db, "Z1");
  assert.equal(getFailures(db, "Z1"), 0);
});
