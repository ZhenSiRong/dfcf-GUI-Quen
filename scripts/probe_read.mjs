/**
 * 只读探针（新版，复用 WapBroker）
 * ---------------------------------------------------------------
 * 用法：node scripts/probe_read.mjs [zjzh] [--save]
 *  - 默认读 state/account.json 的 active 组合
 *  - --save 把本次快照写入 fixtures/probe_<时间>.json
 * 全程只读，不产生任何委托。
 */
import fs from "node:fs";
import path from "node:path";
import { WapBroker } from "../src/broker/wap.mjs";
import { ROOT, loadAccount } from "../src/config.mjs";

const args = process.argv.slice(2);
const save = args.includes("--save");
const zjzhArg = args.find((a) => /^\d+$/.test(a));
const account = loadAccount();
const zjzh = zjzhArg || account.zjzh;

const broker = await WapBroker.create({ headless: true });
try {
  const health = await broker.health(zjzh);
  console.log("health:", JSON.stringify(health));
  if (!health.ok) process.exitCode = 2;

  const [balance, positions, orders] = await Promise.all([
    broker.balance(zjzh),
    broker.positions(zjzh),
    broker.orders(zjzh),
  ]);
  console.log("balance:", JSON.stringify(balance));
  console.log("positions:", JSON.stringify(positions.positions));
  console.log("orders:", JSON.stringify(orders.orders));

  if (save) {
    const dir = path.join(ROOT, "fixtures");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `probe_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify({ zjzh, at: new Date().toISOString(), health, balance, positions, orders }, null, 2));
    console.log("saved:", file);
  }
} finally {
  await broker.close();
}
