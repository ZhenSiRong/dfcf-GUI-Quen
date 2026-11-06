import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RISK } from "../src/config.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(f, out);
    else if (/\.(mjs|js|sh)$/.test(ent.name)) out.push(f);
  }
  return out;
}

test("safety: 代码中不得出现 PC 交易/私有协议端点", () => {
  const forbidden = [
    "jywg.18.cn",
    "spzhapi.dfcfs.cn",
    "simoper.eastmoney.com",
    "simqry2.eastmoney.com",
  ];
  const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))];
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const bad of forbidden) {
      assert.equal(text.includes(bad), false, `${path.relative(ROOT, f)} 出现了禁用端点 ${bad}`);
    }
  }
});

test("safety: 交易写入必须走 GUI（WapBroker 保留 DOM 按钮与弹窗）", () => {
  const text = fs.readFileSync(path.join(ROOT, "src/broker/wap.mjs"), "utf8");
  for (const needle of ["模拟买入", "模拟卖出", ".aui-dialog", "div.input.button", "快照核对", "弹窗二次核对"]) {
    assert.ok(text.includes(needle), "WapBroker 缺少 GUI 关键逻辑: " + needle);
  }
});

test("safety: runner 默认 dry-run，真实下单需 --live", () => {
  const text = fs.readFileSync(path.join(ROOT, "src/runner.mjs"), "utf8");
  assert.match(text, /live:\s*false/);
  assert.match(text, /dryRun:\s*!args\.live/);
  assert.match(text, /account\.sim !== true/);
});

test("safety: 冻结风控参数未被放宽", () => {
  assert.equal(RISK.maxOrdersPerDay, 20);
  assert.equal(RISK.maxNotionalPerOrder, 5000);
  assert.equal(RISK.maxPriceDeviation, 0.03);
  assert.equal(RISK.maxConsecutiveFailures, 3);
  assert.equal(RISK.lotSize, 100);
});
