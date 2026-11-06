/**
 * 全局配置
 * ---------------------------------------------------------------
 * 所有硬编码常量集中在这里。风控阈值不允许在别处覆盖。
 */
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

// ---------- 通道 ----------
export const CHROME = "/opt/google/chrome/chrome";
export const H5_BASE = "https://groupwap.eastmoney.com";
export const API_URL = "https://emstockdiag.eastmoney.com/apistock/tran/getJson";
export const API_PATH = "zuheV64/JS.aspx";

// 本机 Chrome 与国内站点 TLS1.3 握手会卡死 30s（curl/node 正常）→ 强制 1.2
export const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--ssl-version-max=tls1.2",
];

// ---------- 行情 ----------
export const PUSH2 = "https://push2.eastmoney.com/api/qt/stock/get";
export const PUSH2_UT = "b2884a393a59ad64002292a3e90d46a5";

// ---------- 路径 ----------
export const STATE_FILE = path.join(ROOT, "state/storage_state.json");
export const ACCOUNT_FILE = path.join(ROOT, "state/account.json");
export const UNIVERSE_FILE = path.join(ROOT, "state/universe.json");
export const RULE_DIR = path.join(ROOT, "state/rules");
export const VIDEO_DIR = path.join(ROOT, "reports/video");
export const DB_FILE = process.env.QUAN_DB_FILE || path.join(ROOT, "data/trading.db");
export const LOG_DIR = process.env.QUAN_LOG_DIR || path.join(ROOT, "logs");
export const REPORT_DIR = process.env.QUAN_REPORT_DIR || path.join(ROOT, "reports");
export const FIXTURE_DIR = path.join(ROOT, "fixtures");
export const MARKET_FIXTURE = path.join(FIXTURE_DIR, "market.json");
export const SNAPSHOT_FIXTURE = path.join(FIXTURE_DIR, "snapshot_real.json");

// ---------- 风控（冻结参数，代码内不可绕过） ----------
export const RISK = {
  maxOrdersPerDay: 20,          // 单日真实下单上限
  maxNotionalPerOrder: 5000,    // 单笔金额上限（元）
  maxPriceDeviation: 0.03,      // 限价与最新价偏离 >3% 拒单
  maxConsecutiveFailures: 3,    // 连败熔断
  maxPositionRatioPerStock: 0.3,// 单票市值占总资产上限
  minCashReserveRatio: 0.05,    // 最低现金保留比例
  lotSize: 100,                 // 买入整手
};

// ---------- 交易时段（官方 Q037） ----------
export const SESSIONS = {
  clearing: [["15:00", "17:00"]], // 清算，不接受委托
  auction: [["09:15", "09:30"]],  // 集合竞价，避免下单
  trading: [
    ["09:30", "11:30"],
    ["13:00", "15:00"],
  ],
  noNewOrderAfter: "14:55",       // 收盘前 5 分钟停止开新仓
};

// ---------- 账号 ----------
export function loadAccount() {
  if (!fs.existsSync(ACCOUNT_FILE)) {
    throw new Error("缺少 state/account.json。请复制 state/account.example.json 并填入模拟组合 zjzh");
  }
  const raw = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
  const envZh = process.env.POC_ZH;
  if (envZh) {
    const found = (raw.all || []).find((a) => String(a.zjzh) === String(envZh));
    return {
      zjzh: String(envZh),
      name: process.env.POC_NAME || found?.name || raw.active.name,
      sim: found?.sim === true,
    };
  }
  return raw.active;
}

// ---------- 股票池 ----------
const DEFAULT_UNIVERSE = {
  note: "日线 SMA 策略股票池。价格必须满足 1 手 <= RISK.maxNotionalPerOrder。",
  codes: ["601398", "600028", "000001", "600036", "601088", "600030"],
  params: { short: 5, long: 20, band: 0.005, minBars: 30, maxChasePct: 0.05 },
};

export function loadUniverse() {
  if (!fs.existsSync(UNIVERSE_FILE)) return { ...DEFAULT_UNIVERSE };
  const raw = JSON.parse(fs.readFileSync(UNIVERSE_FILE, "utf8"));
  return {
    ...DEFAULT_UNIVERSE,
    ...raw,
    codes: (raw.codes || DEFAULT_UNIVERSE.codes).map(String),
    params: { ...DEFAULT_UNIVERSE.params, ...(raw.params || {}) },
  };
}
