/**
 * 持久层：SQLite（Node 24 内置 node:sqlite，零依赖）
 * ---------------------------------------------------------------
 * 记录：信号 / 委托 / 成交 / 持仓快照 / 资金快照 / 运行记录 / 计数器
 * 目的：GUI 自动化的每一步都可审计、可复盘。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE, LOG_DIR } from "../config.mjs";
import { shanghaiNow } from "../util/time.mjs";
import { raiseAlert } from "../util/log.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  mode TEXT NOT NULL,          -- dry-run | live
  status TEXT NOT NULL,        -- running | ok | failed
  detail TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  strategy TEXT,
  code TEXT,
  action TEXT,                 -- buy | sell | hold
  target_qty INTEGER,
  reason TEXT,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  zjzh TEXT NOT NULL,
  order_id TEXT,
  code TEXT,
  name TEXT,
  side TEXT,                   -- buy | sell
  price REAL,
  qty INTEGER,
  status TEXT,                 -- submitted | failed | cancelled | filled
  dry_run INTEGER NOT NULL DEFAULT 1,
  response TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(ts, zjzh, side);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  order_id TEXT,
  code TEXT,
  name TEXT,
  side TEXT,
  price REAL,
  qty INTEGER
);

CREATE TABLE IF NOT EXISTS positions_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  zjzh TEXT NOT NULL,
  code TEXT,
  name TEXT,
  qty REAL,
  cost REAL,
  market_value REAL,
  pnl REAL
);

CREATE TABLE IF NOT EXISTS balance_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  zjzh TEXT NOT NULL,
  total REAL,
  cash REAL,
  market_value REAL,
  frozen REAL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
`;

export function openDb(file = DB_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try { if (file !== ":memory:") fs.chmodSync(file, 0o600); } catch {}
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

export function startRun(db, mode) {
  const ts = new Date().toISOString();
  const r = db.prepare("INSERT INTO runs (ts, mode, status) VALUES (?,?,?)").run(ts, mode, "running");
  return Number(r.lastInsertRowid);
}

export function finishRun(db, id, status, detail) {
  db.prepare("UPDATE runs SET status=?, detail=? WHERE id=?").run(status, detail || null, id);
}

export function logSignal(db, s) {
  db.prepare(
    "INSERT INTO signals (ts, strategy, code, action, target_qty, reason, payload) VALUES (?,?,?,?,?,?,?)",
  ).run(new Date().toISOString(), s.strategy || null, s.code || null, s.action || null,
        s.targetQty ?? null, s.reason || null, s.payload ? JSON.stringify(s.payload) : null);
}

export function logOrder(db, o) {
  const r = db.prepare(
    "INSERT INTO orders (ts, zjzh, order_id, code, name, side, price, qty, status, dry_run, response) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(new Date().toISOString(), o.zjzh, o.orderId || null, o.code, o.name || null, o.side,
        o.price ?? null, o.qty ?? null, o.status || "submitted", o.dryRun ? 1 : 0,
        o.response ? JSON.stringify(o.response) : null);
  return Number(r.lastInsertRowid);
}

export function updateOrderStatus(db, id, status, response) {
  db.prepare("UPDATE orders SET status=?, response=COALESCE(?, response) WHERE id=?")
    .run(status, response ? JSON.stringify(response) : null, id);
}

export function snapshotPositions(db, zjzh, positions) {
  const ts = new Date().toISOString();
  const stmt = db.prepare(
    "INSERT INTO positions_snapshot (ts, zjzh, code, name, qty, cost, market_value, pnl) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const p of positions) {
    stmt.run(ts, zjzh, p.code, p.name || null, p.qty ?? null, p.cost ?? null, p.marketValue ?? null, p.pnl ?? null);
  }
  return ts;
}

export function snapshotBalance(db, zjzh, b) {
  db.prepare(
    "INSERT INTO balance_snapshot (ts, zjzh, total, cash, market_value, frozen) VALUES (?,?,?,?,?,?)",
  ).run(new Date().toISOString(), zjzh, b.total ?? null, b.cash ?? null, b.marketValue ?? null, b.frozen ?? null);
}

/** 当日已提交的真实委托笔数（dry-run 不计；按北京时间切日） */
export function todayOrderCount(db, zjzh, date = shanghaiNow().date) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE zjzh=? AND dry_run=0 AND date(ts, '+8 hours')=? AND status IN ('submitted','filled')",
  ).get(zjzh, date);
  return Number(row?.n || 0);
}

export function getKv(db, key, def = null) {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
  return row ? JSON.parse(row.value) : def;
}

export function setKv(db, key, value) {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

/** 连败计数：key 按天重置 */
export function bumpFailure(db, zjzh, delta = 1) {
  const key = `fail:${zjzh}:${shanghaiNow().date}`;
  const n = (getKv(db, key, 0) || 0) + delta;
  setKv(db, key, n);
  if (n >= 3) {
    raiseAlert("circuit_breaker", { zjzh, consecutiveFailures: n });
  }
  return n;
}

export function resetFailures(db, zjzh) {
  setKv(db, `fail:${zjzh}:${shanghaiNow().date}`, 0);
}

export function getFailures(db, zjzh) {
  return getKv(db, `fail:${zjzh}:${shanghaiNow().date}`, 0) || 0;
}

export function recentOrders(db, limit = 20) {
  return db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ?").all(limit);
}

export function dailyReport(db, date = shanghaiNow().date) {
  const orders = db.prepare("SELECT * FROM orders WHERE date(ts, '+8 hours')=? ORDER BY id").all(date);
  const runs = db.prepare("SELECT * FROM runs WHERE date(ts, '+8 hours')=? ORDER BY id").all(date);
  return { date, orders, runs };
}
