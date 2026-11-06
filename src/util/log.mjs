/**
 * 结构化日志：同时写控制台 + logs/*.jsonl
 */
import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "../config.mjs";

fs.mkdirSync(LOG_DIR, { recursive: true });

export function createLogger(name) {
  const file = path.join(LOG_DIR, `${name}.jsonl`);
  return {
    file,
    info(msg, data) {
      const rec = { ts: new Date().toISOString(), level: "info", msg, ...data };
      console.log(`[${rec.ts.slice(11, 19)}] ${msg}${data ? " " + JSON.stringify(data) : ""}`);
      fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    },
    warn(msg, data) {
      const rec = { ts: new Date().toISOString(), level: "warn", msg, ...data };
      console.warn(`[${rec.ts.slice(11, 19)}] ⚠ ${msg}${data ? " " + JSON.stringify(data) : ""}`);
      fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    },
    error(msg, data) {
      const rec = { ts: new Date().toISOString(), level: "error", msg, ...data };
      console.error(`[${rec.ts.slice(11, 19)}] ✖ ${msg}${data ? " " + JSON.stringify(data) : ""}`);
      fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    },
  };
}

/** 写告警文件（无人值守时人工巡检用） */
export function raiseAlert(title, detail) {
  const dir = path.join(LOG_DIR, "alerts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${title.replace(/[^\w\u4e00-\u9fa5-]/g, "_")}.json`);
  fs.writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), title, detail }, null, 2));
  return file;
}
