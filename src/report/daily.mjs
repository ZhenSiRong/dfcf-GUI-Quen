/**
 * 日报渲染：Markdown（人看）+ 摘要对象（程序看）
 */
import fs from "node:fs";
import path from "node:path";
import { REPORT_DIR } from "../config.mjs";
import { shanghaiNow } from "../util/time.mjs";

const money = (x) =>
  x === null || x === undefined || !Number.isFinite(Number(x))
    ? "-"
    : Number(x).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const signed = (x) => (Number(x) >= 0 ? "+" + money(x) : money(x));

export function renderReport(ctx) {
  const {
    now = shanghaiNow(),
    mode,         // dry-run | live
    mock,
    account,
    session,
    before,
    after,
    signals = [],
    executions = [],
    skipped = [],
    openOrders = [],
  } = ctx;

  const L = [];
  L.push(`# 东方财富模拟盘 · 交易日报`);
  L.push("");
  L.push(`- 日期：${now.date} ${now.time}（Asia/Shanghai）`);
  L.push(`- 组合：${account.name}（${account.zjzh}）`);
  L.push(`- 模式：**${mode}**${mock ? "（mock 回放）" : ""}`);
  L.push(`- 时段判定：${session?.reason ?? "-"}（可下单=${session?.ok ? "是" : "否"}）`);
  L.push("");

  L.push(`## 资产`);
  L.push("");
  L.push(`| 项目 | 运行前 | 运行后 | 变化 |`);
  L.push(`|---|---:|---:|---:|`);
  const rows = [
    ["总资产", "total"],
    ["可用资金", "cash"],
    ["持仓市值", "marketValue"],
    ["冻结资金", "frozen"],
    ["当日盈亏", "pnlToday"],
  ];
  for (const [label, k] of rows) {
    const b = before?.balance?.[k];
    const a = after?.balance?.[k];
    L.push(`| ${label} | ${money(b)} | ${money(a)} | ${b != null && a != null ? signed(a - b) : "-"} |`);
  }
  L.push("");

  L.push(`## 信号`);
  L.push("");
  if (!signals.length) {
    L.push("无（股票池为空或行情缺失）");
  } else {
    L.push(`| 代码 | 名称 | 动作 | 理由 | 趋势 | SMA5 | SMA20 | 现价 |`);
    L.push(`|---|---|---|---|---|---:|---:|---:|`);
    for (const s of signals) {
      const m = s.meta || {};
      L.push(`| ${s.code} | ${s.name ?? "-"} | ${s.action} | ${s.reason} | ${m.trend ?? "-"} | ${m.smaShort ?? "-"} | ${m.smaLong ?? "-"} | ${m.last ?? "-"} |`);
    }
  }
  L.push("");

  L.push(`## 委托执行`);
  L.push("");
  if (!executions.length) {
    L.push("本次没有提交任何委托。");
  } else {
    L.push(`| 代码 | 方向 | 价格 | 数量 | 结果 | 合同编号 | 说明 |`);
    L.push(`|---|---|---:|---:|---|---|---|`);
    for (const e of executions) {
      L.push(`| ${e.code} | ${e.side} | ${e.price} | ${e.qty} | ${e.ok ? "✅ " + (e.dryRun ? "dry-run" : "已提交") : "❌ 失败"} | ${e.orderId ?? "-"} | ${e.message ?? ""} |`);
    }
  }
  L.push("");

  if (skipped.length) {
    L.push(`## 跳过 / 拒绝`);
    L.push("");
    L.push(`| 代码 | 动作 | 原因 |`);
    L.push(`|---|---|---|`);
    for (const s of skipped) L.push(`| ${s.code} | ${s.action ?? "-"} | ${s.reason} |`);
    L.push("");
  }

  if (openOrders.length) {
    L.push(`## 现存未成交委托`);
    L.push("");
    L.push(`| 代码 | 方向 | 价格 | 数量 | 状态 | 合同编号 |`);
    L.push(`|---|---|---:|---:|---|---|`);
    for (const o of openOrders) {
      L.push(`| ${o.code} | ${o.side} | ${o.price} | ${o.qty} | ${o.status} | ${o.orderId} |`);
    }
    L.push("");
  }

  L.push(`## 持仓`);
  L.push("");
  const pos = after?.positions?.positions || [];
  if (!pos.length) {
    L.push("空仓。");
  } else {
    L.push(`| 代码 | 名称 | 持仓 | 可用 | 成本 | 现价 | 市值 | 盈亏 |`);
    L.push(`|---|---|---:|---:|---:|---:|---:|---:|`);
    for (const p of pos) {
      L.push(`| ${p.code} | ${p.name} | ${p.qty} | ${p.available ?? "-"} | ${money(p.cost)} | ${money(p.last)} | ${money(p.marketValue)} | ${money(p.pnl)} |`);
    }
  }
  L.push("");
  L.push(`---`);
  L.push(`_由 quan 自动生成；交易全部通过东方财富移动版 H5 GUI 完成。_`);
  L.push("");

  return L.join("\n");
}

export function writeReport(markdown, { now = shanghaiNow(), mode = "dry-run" } = {}) {
  const dir = path.join(REPORT_DIR, now.date);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.time.replace(":", "");
  const file = path.join(dir, `${stamp}-${mode}.md`);
  fs.writeFileSync(file, markdown);
  fs.writeFileSync(path.join(REPORT_DIR, "latest.md"), markdown);
  return file;
}
