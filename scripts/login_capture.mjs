/**
 * 一次性人工登录捕获（带实时监控）
 * ---------------------------------------------------------------
 * 打开一个可见的 Chrome 窗口，让用户手动登录东方财富通行证。
 * 登录成功后自动导出 storage_state.json，供后续所有自动化复用。
 *
 * 为什么有这些奇怪的启动参数：
 *  - --ssl-version-max=tls1.2  本机 Chrome 与国内站点做 TLS1.3 握手会卡 30s
 *  - --ozone-platform=x11      保证窗口走 X11（ToDesk 可见）
 *
 * 监控产物：
 *  - logs/live/frame-XXXX.png   每 5 秒一帧，卡死时能看出停在哪一步
 *  - logs/login_capture.log     时间线日志（含心跳/RENDERER HUNG 告警）
 *
 * 用法： node scripts/login_capture.mjs
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const CHROME = "/opt/google/chrome/chrome";
const ROOT = path.resolve(import.meta.dirname, "..");
const PROFILE = path.join(ROOT, "state/chrome-profile");
const STATE = path.join(ROOT, "state/storage_state.json");
const LOG = path.join(ROOT, "logs/login_capture.log");
const LIVE = path.join(ROOT, "logs/live");

const BACKURL = "https://groupwap.eastmoney.com/group/simulation/hold.html";
const LOGIN_URL =
  "https://mpassport2.eastmoney.com/login?backurl=" + encodeURIComponent(BACKURL);

fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.rmSync(LIVE, { recursive: true, force: true });
fs.mkdirSync(LIVE, { recursive: true });

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
};

const SESSION_COOKIES = ["ct", "ut"];

async function hasSession(ctx) {
  const cookies = await ctx.cookies();
  const names = new Set(cookies.map((c) => c.name));
  return { ok: SESSION_COOKIES.every((n) => names.has(n)), names: [...names] };
}

async function main() {
  log("启动可见 Chrome（X11 + TLS1.2）…");
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=500,940",
      "--window-position=60,40",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--ozone-platform=x11",
      "--ssl-version-max=tls1.2",
    ],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on("console", (m) => {
    if (m.type() === "error") log("page-error: " + m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => log("page-exception: " + String(e).slice(0, 200)));
  page.on("requestfailed", (r) =>
    log("reqfail: " + r.url().slice(0, 100) + " " + (r.failure()?.errorText || "")),
  );

  log("打开登录页: " + LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // 心跳探针：renderer 主线程卡死时 evaluate 会超时
  await page.evaluate(() => {
    window.__hb = 0;
    setInterval(() => window.__hb++, 250);
  });

  let st = await hasSession(ctx);
  if (st.ok) {
    log("检测到已存在的登录态（ct/ut 已就绪）");
  } else {
    log("等待人工登录… 请在浏览器窗口内完成登录（短信验证码 / 账号密码均可）");
    const deadline = Date.now() + 25 * 60 * 1000;
    let lastReport = 0;
    let frame = 0;
    let hungCount = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2500);
      st = await hasSession(ctx);
      if (st.ok) break;

      // 每 5 秒一帧
      if (Date.now() - lastReport > 5000) {
        frame++;
        lastReport = Date.now();
        const file = path.join(LIVE, `frame-${String(frame).padStart(4, "0")}.png`);
        let hb = "?";
        try {
          hb = await page.evaluate(() => window.__hb, { timeout: 4000 });
          hungCount = 0;
        } catch {
          hungCount++;
          hb = "HUNG";
          log(`⚠ renderer 主线程无响应（第 ${hungCount} 次）`);
        }
        try {
          await page.screenshot({ path: file, timeout: 6000 });
          log(`心跳=${hb} 帧=${path.basename(file)} url=${page.url().slice(0, 80)}`);
        } catch (e) {
          log(`心跳=${hb} 截图失败: ${e.message.split("\n")[0]}`);
        }
      }
    }
    if (!st.ok) {
      log("超时未完成登录，退出。");
      await ctx.close();
      process.exit(2);
    }
  }

  log("登录成功！cookie: " + st.names.join(","));
  await ctx.storageState({ path: STATE });
  try { fs.chmodSync(STATE, 0o600); } catch {}
  log("已保存 storage_state -> " + STATE);

  try {
    await page.goto(BACKURL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    const bodyTxt = (await page.$eval("body", (e) => e.innerText)).replace(/\n{2,}/g, "\n");
    log("持仓页文本片段: " + bodyTxt.slice(0, 300).replace(/\n/g, " | "));
    await page.screenshot({ path: path.join(ROOT, "logs/login_hold.png") });
    log("截图 -> logs/login_hold.png");
  } catch (e) {
    log("进入持仓页失败（不影响登录态保存）: " + e.message);
  }

  const cookies = await ctx.cookies();
  const cookieFile = path.join(ROOT, "state/cookies.json");
  fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
  try { fs.chmodSync(cookieFile, 0o600); } catch {}
  log("已保存 cookies -> state/cookies.json");

  log("完成。浏览器保持打开 20 秒供确认…");
  await page.waitForTimeout(20000);
  await ctx.close();
  log("浏览器已关闭。");
}

main().catch((e) => {
  log("FATAL " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
