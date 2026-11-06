import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");

function run(args, env = {}) {
  const out = execFileSync(process.execPath, ["src/runner.mjs", ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  const line = out.split("\n").find((l) => l.startsWith("SUMMARY "));
  assert.ok(line, "缺少 SUMMARY 行:\n" + out);
  return { summary: JSON.parse(line.slice(8)), out };
}

test("runner: --mock dry-run 端到端", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quan-run-"));
  const env = {
    QUAN_DB_FILE: path.join(dir, "t.db"),
    QUAN_REPORT_DIR: path.join(dir, "reports"),
  };

  const { summary, out } = run(["--mock", "--at", "2026-11-06T14:50:00+08:00"], env);
  assert.equal(summary.ok, true, out);
  assert.equal(summary.mode, "dry-run");
  assert.ok(summary.executed >= 1, "至少应有一个 dry-run 委托");
  assert.equal(summary.failed, 0);

  const report = path.join(ROOT, summary.report);
  assert.ok(fs.existsSync(report), "日报不存在: " + report);
  const md = fs.readFileSync(report, "utf8");
  assert.match(md, /交易日报/);
  assert.match(md, /dry-run/);

  // DB 中只应有 dry_run=1
  const db = new DatabaseSync(path.join(dir, "t.db"));
  const rows = db.prepare("SELECT dry_run, COUNT(*) AS n FROM orders GROUP BY dry_run").all();
  assert.deepEqual(rows.map((r) => ({ dry_run: r.dry_run, n: r.n })), [{ dry_run: 1, n: summary.executed }]);
  db.close();
});

test("runner: --mock --live 走真实提交路径（内存账户）+ --max-orders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quan-run-live-"));
  const env = {
    QUAN_DB_FILE: path.join(dir, "t.db"),
    QUAN_REPORT_DIR: path.join(dir, "reports"),
  };

  const { summary, out } = run(
    ["--mock", "--live", "--force", "--max-orders", "1", "--at", "2026-11-06T14:50:00+08:00"],
    env,
  );
  assert.equal(summary.ok, true, out);
  assert.equal(summary.mode, "live");
  assert.equal(summary.executed, 1, "max-orders 应限制为 1 笔");
  assert.equal(summary.failed, 0);
  assert.equal(summary.orderIds.length, 1);

  const db = new DatabaseSync(path.join(dir, "t.db"));
  const rows = db.prepare("SELECT * FROM orders WHERE dry_run=0").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "submitted");
  assert.ok(rows[0].order_id.startsWith("MOCK"));
  db.close();
});
