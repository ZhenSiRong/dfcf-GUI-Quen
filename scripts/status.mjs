#!/usr/bin/env node
/**
 * status —— 终端查看运行状态（不依赖 sqlite3 CLI）
 * 用法：node scripts/status.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROOT, DB_FILE } from "../src/config.mjs";
import { shanghaiNow } from "../src/util/time.mjs";

if (!fs.existsSync(DB_FILE)) {
  console.log("尚无数据库: " + DB_FILE);
  process.exit(0);
}

const db = new DatabaseSync(DB_FILE);
const today = shanghaiNow().date;

const runs = db.prepare("SELECT id,ts,mode,status,detail FROM runs ORDER BY id DESC LIMIT 5").all();
const orders = db.prepare(
  "SELECT code,side,price,qty,status,dry_run,order_id,ts FROM orders WHERE date(ts,'+8 hours')=? ORDER BY id DESC",
).all(today);
const signals = db.prepare(
  "SELECT action, COUNT(*) AS n FROM signals WHERE date(ts,'+8 hours')=? GROUP BY action",
).all(today);

console.log(`=== quan status ${today} ===\n`);
console.log("最近运行：");
for (const r of runs) console.log(`  #${r.id} ${r.ts} ${r.mode} ${r.status} ${r.detail ? String(r.detail).slice(0, 90) : ""}`);

console.log("\n今日信号：");
if (!signals.length) console.log("  （无）");
for (const s of signals) console.log(`  ${s.action}: ${s.n}`);

console.log("\n今日委托：");
if (!orders.length) console.log("  （无）");
for (const o of orders) {
  const kind = o.dry_run ? "dry-run" : "LIVE";
  console.log(`  ${o.ts} ${kind} ${o.side} ${o.code} ${o.qty}@${o.price} ${o.status} ${o.order_id || ""}`);
}

const alertDir = path.join(ROOT, "logs/alerts");
if (fs.existsSync(alertDir)) {
  const alerts = fs.readdirSync(alertDir).sort().slice(-10);
  console.log(`\n最近告警（${alerts.length}）：`);
  for (const a of alerts) console.log("  " + a);
}

const latest = path.join(ROOT, "reports/latest.md");
if (fs.existsSync(latest)) console.log("\n最新日报: " + latest);
db.close();
