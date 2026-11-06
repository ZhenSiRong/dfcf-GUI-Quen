/**
 * WapBroker —— 东方财富移动版 H5 模拟盘适配器
 * ---------------------------------------------------------------
 * 读：直接调用页面自己用的 getJson 接口（带登录 cookie，快且稳）
 * 写：**必须**通过 Playwright 操作 DOM 按钮（填单 → 确认弹窗 → 确定）
 *
 * 交易安全：
 *  - 下单前「快照核对」：读回输入框值，与调用方期望值逐项比对
 *  - 确认弹窗二次核对：弹窗复述的代码/价格/数量/方向必须一致
 *  - 任何不一致立即中止，绝不点「确定」
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import {
  API_URL, API_PATH, CHROME, CHROME_ARGS, H5_BASE, STATE_FILE, LOG_DIR,
} from "../config.mjs";

const ORDER_SHOT_DIR = path.join(LOG_DIR, "orders");

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

/**
 * 持仓行解析（纯函数，便于回归测试）。
 * 注意：holdPos 是仓位占比（0.0150 = 1.5%），不是股数；zqsl 才是总股数。
 */
export function parsePositionRows(rows = []) {
  return rows.map((d) => ({
    code: d.__code,
    name: d.__name,
    qty: num(d.zqsl) ?? 0,
    available: num(d.kysl) ?? 0,
    cost: num(d.cbj),
    last: num(d.__zxjg),
    marketValue: num(d.mktVal),
    pnl: num(d.webYk),
    pnlRate: num(d.webYkRate),
    dayPnl: num(d.dayYk),
  }));
}

export class WapBroker {
  constructor(browser, ctx, opts = {}) {
    this.browser = browser;
    this.ctx = ctx;
    this.headless = opts.headless ?? true;
    this.log = opts.log || ((m) => console.log(m));
    this.videoDir = opts.videoDir || null;
    this.clickMarker = opts.clickMarker ?? !!opts.videoDir;
    fs.mkdirSync(ORDER_SHOT_DIR, { recursive: true });
  }

  static async create({
    headless = true, storageState = STATE_FILE, log, recordVideo = null, clickMarker = null,
  } = {}) {
    if (!fs.existsSync(storageState)) throw new Error("缺少登录态: " + storageState);
    if (recordVideo?.dir) fs.mkdirSync(recordVideo.dir, { recursive: true });
    const browser = await chromium.launch({ executablePath: CHROME, headless, args: CHROME_ARGS });
    const ctx = await browser.newContext({
      storageState,
      locale: "zh-CN",
      viewport: { width: 430, height: 900 },
      ...(recordVideo?.dir
        ? { recordVideo: { dir: recordVideo.dir, size: recordVideo.size || { width: 430, height: 900 } } }
        : {}),
    });
    return new WapBroker(browser, ctx, {
      headless,
      log,
      videoDir: recordVideo?.dir || null,
      clickMarker: clickMarker ?? !!recordVideo?.dir,
    });
  }

  async close() {
    await this.browser.close();
  }

  /**
   * 把当前上下文的 cookie/localStorage 回写到登录态文件。
   * 仅在健康检查通过后调用，避免把“已登出”的游客态覆盖到好状态上。
   */
  async persist(file = STATE_FILE) {
    try {
      await this.ctx.storageState({ path: file });
      try { fs.chmodSync(file, 0o600); } catch {}
      this.log("登录态已刷新 -> " + file);
      return true;
    } catch (e) {
      this.log("登录态回写失败: " + e.message.split("\n")[0]);
      return false;
    }
  }

  // ---------------- 只读 ----------------

  async _api(pageUrl, urlParm, { retries = 2 } = {}) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const r = await this.ctx.request.post(API_URL, {
          form: { path: API_PATH, pageUrl, urlParm: JSON.stringify(urlParm) },
          headers: { Referer: pageUrl, Origin: H5_BASE },
          timeout: 25000,
        });
        const text = await r.text();
        try { return JSON.parse(text); } catch { return { result: "-1", message: "非 JSON 响应", raw: text.slice(0, 300) }; }
      } catch (e) {
        lastErr = e;
        if (i < retries - 1) await new Promise((res) => setTimeout(res, 600 * 2 ** i));
      }
    }
    return { result: "-1", message: "请求失败: " + String(lastErr?.message || lastErr).split("\n")[0], raw: null };
  }

  _pageUrl(zjzh) {
    return `${H5_BASE}/group/simulation/hold.html?zh=${zjzh}`;
  }

  async balance(zjzh) {
    const j = await this._api(this._pageUrl(zjzh), [
      { type: "user_infos" }, { infoType: "zuhe_bal_info" }, { zh: zjzh }, { appVer: "9001000" },
    ]);
    const d = j?.listData?.[0] || {};
    return {
      ok: j?.result === "0",
      message: j?.message,
      total: num(d.zzc),
      cash: num(d.kyye),
      marketValue: num(d.mktValue),
      frozen: num(d.sdje),
      initial: num(d.csje),
      pnlToday: num(d.ykToday),
      pnlHolding: num(d.ykHold),
      raw: d,
    };
  }

  async positions(zjzh) {
    const j = await this._api(this._pageUrl(zjzh), [
      { type: "hold" }, { recIdx: 0 }, { zh: zjzh }, { recCnt: 100 }, { appVer: "9001000" },
    ]);
    const rows = j?.listData || [];
    return {
      ok: j?.result === "0",
      message: j?.message,
      positions: parsePositionRows(rows),
      raw: rows,
    };
  }

  async orders(zjzh) {
    const j = await this._api(this._pageUrl(zjzh), [
      { type: "orders_valid" }, { recIdx: 0 }, { zh: zjzh }, { recCnt: 100 }, { appVer: "9001000" },
    ]);
    const rows = j?.listData || [];
    return {
      ok: j?.result === "0",
      message: j?.message,
      orders: rows.map((d) => ({
        orderId: d.wth,
        code: d.__code,
        name: d.__name,
        side: d.mmflag === "买入" ? "buy" : "sell",
        price: num(d.wtjg),
        qty: num(d.wtsl),
        filledQty: num(d.cjsl) ?? 0,
        filledPrice: num(d.cjjg),
        status: d.ztflag,
        canCancel: String(d.canCancel) === "1",
        date: d.wtrq,
        time: d.wtsj,
        mktAndCode: d.mktAndCode,
      })),
      raw: rows,
    };
  }

  /** 会话是否仍然有效（ct/ut 存在 + 一次只读调用返回 result=0） */
  async health(zjzh) {
    const cookies = await this.ctx.cookies();
    const names = new Set(cookies.map((c) => c.name));
    const hasToken = names.has("ct") && names.has("ut");
    if (!hasToken) return { ok: false, reason: "missing_ct_ut" };
    const b = await this.balance(zjzh);
    if (!b.ok) return { ok: false, reason: "api_failed", message: b.message };
    return { ok: true, total: b.total, cash: b.cash };
  }

  // ---------------- 写（GUI） ----------------

  async _newPage() {
    const page = await this.ctx.newPage();
    page.setDefaultTimeout(20000);
    return page;
  }

  /** 导航重试：只用于“任何交易动作之前”，提交后绝不重试 */
  async _goto(page, url) {
    let last;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
        return;
      } catch (e) {
        last = e;
        this.log(`页面加载失败(${attempt}/2): ${e.message.split("\n")[0]}`);
        if (attempt < 2) await page.waitForTimeout(1200);
      }
    }
    throw last;
  }

  async _shot(page, tag) {
    const f = path.join(ORDER_SHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}.png`);
    try { await page.screenshot({ path: f }); } catch {}
    return f;
  }

  /** 与截图同名的 .json 审计记录（E4：填单值 + 期望值 + 弹窗 + 响应） */
  _saveMeta(shotPath, data) {
    try {
      const f = shotPath.replace(/\.png$/, ".json");
      fs.writeFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...data }, null, 2));
      return f;
    } catch { return null; }
  }

  /**
   * 录屏用点击可视化：跟随鼠标的红圈 + 点击涟漪。
   * 只在页面内绘制，pointer-events:none，不影响任何真实点击。
   */
  async _installClickMarker(page) {
    try {
      await page.evaluate(() => {
        if (window.__quanClickMarker) return;
        window.__quanClickMarker = true;

        const ring = document.createElement("div");
        ring.id = "__quan_cursor";
        ring.style.cssText = [
          "position:fixed", "left:-40px", "top:-40px", "width:18px", "height:18px",
          "border:2px solid #ff1f1f", "border-radius:50%",
          "background:radial-gradient(circle,#ff1f1f 0 2px,transparent 2.5px)",
          "box-shadow:0 0 0 2px rgba(255,31,31,.25)",
          "transform:translate(-50%,-50%)", "pointer-events:none",
          "z-index:2147483646",
        ].join(";");
        document.documentElement.appendChild(ring);

        const moveTo = (x, y) => {
          ring.style.left = x + "px";
          ring.style.top = y + "px";
        };

        const pulse = (x, y) => {
          const r = document.createElement("div");
          r.style.cssText = [
            "position:fixed", `left:${x}px`, `top:${y}px`, "width:20px", "height:20px",
            "border:3px solid #ff1f1f", "border-radius:50%",
            "transform:translate(-50%,-50%)", "pointer-events:none",
            "z-index:2147483645",
          ].join(";");
          document.documentElement.appendChild(r);
          try {
            const anim = r.animate(
              [
                { transform: "translate(-50%,-50%) scale(.45)", opacity: 1 },
                { transform: "translate(-50%,-50%) scale(3.2)", opacity: 0 },
              ],
              { duration: 780, easing: "ease-out" },
            );
            anim.onfinish = () => r.remove();
          } catch {
            setTimeout(() => r.remove(), 800);
          }
        };

        // 供「fill 类操作」手动画落点，不依赖元素是否可点击
        window.__quanMove = moveTo;
        window.__quanPulse = pulse;
        window.addEventListener("mousemove", (e) => moveTo(e.clientX, e.clientY), true);
        window.addEventListener("mousedown", (e) => pulse(e.clientX, e.clientY), true);
      });
    } catch (e) {
      this.log("点击标记注入失败: " + (e?.message || String(e)).split("\n")[0]);
    }
  }

  /** 在输入框中心画一个点击落点（只用于录屏，不真正点击） */
  async _pulseAt(page, locator) {
    try {
      const box = await locator.boundingBox();
      if (!box) return;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.evaluate(([px, py]) => {
        window.__quanMove?.(px, py);
        window.__quanPulse?.(px, py);
      }, [x, y]);
      await page.waitForTimeout(350);
    } catch (e) {
      this.log("点击落点绘制失败: " + (e?.message || String(e)).split("\n")[0]);
    }
  }

  /**
   * 选中股票后强制收起建议下拉。
   * 偶发：行点击成功但 div.list 没关，会盖住「模拟买入」按钮导致点击超时。
   */
  async _closeSuggest(page) {
    try {
      await page.evaluate(() => {
        const row = document.querySelector("tr[data-code]");
        let el = row;
        while (el && el !== document.body) {
          if (el.classList?.contains("list")) {
            el.style.display = "none";
            break;
          }
          el = el.parentElement;
        }
      });
      await page.waitForTimeout(300);
    } catch (e) {
      this.log("收起点选列表失败: " + (e?.message || String(e)).split("\n")[0]);
    }
  }

  async _selectStock(page, code) {
    const input = page.locator('input[placeholder="请输入代码或简称"]');
    await input.click();
    await input.fill("");
    await page.keyboard.type(String(code), { delay: 90 });
    const row = page.locator(`tr[data-code="${code}"]`).first();
    await row.waitFor({ state: "visible", timeout: 12000 });
    const name = (await row.getAttribute("data-name")) || "";
    await row.click();
    await page.waitForTimeout(1500);
    await this._closeSuggest(page);
    return name;
  }

  /**
   * 下单（GUI）
   * @returns {{dryRun:boolean, ok:boolean, orderId?:string, name:string, dialogText:string, response?:object, screenshot:string}}
   */
  async place({ zjzh, comboName = "", side, code, price, qty, dryRun = true, banner = "" }) {
    if (!["buy", "sell"].includes(side)) throw new Error("side 必须是 buy/sell");
    const page = await this._newPage();
    const action = side === "buy" ? "buy" : "sell";
    const btnText = side === "buy" ? "模拟买入" : "模拟卖出";
    const pageUrl = `${H5_BASE}/group/simulation/${action}.html?zh=${zjzh}&name=${encodeURIComponent(comboName)}`;

    try {
      await this._goto(page, pageUrl);
      await page.waitForTimeout(2500);
      if (this.clickMarker) await this._installClickMarker(page);

      const stockName = await this._selectStock(page, code);

      // 录制视频时在页面顶部加一条说明（不影响任何点击）
      if (this.videoDir && banner) {
        await page.evaluate((text) => {
          const d = document.createElement("div");
          d.textContent = text;
          d.style.cssText =
            "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
            "background:#c00000;color:#fff;font:600 15px/38px system-ui,sans-serif;" +
            "text-align:center;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35)";
          document.body.appendChild(d);
        }, banner);
        await page.waitForTimeout(500);
      }

      // 填价 / 填量（先点击，录屏里能看到落点）
      const priceInput = page.locator("#price");
      await this._pulseAt(page, priceInput);
      await priceInput.fill(String(price));
      const qtyInput = page.locator(`input[placeholder="${side === "buy" ? "买入" : "卖出"}数量"]`);
      await this._pulseAt(page, qtyInput);
      await qtyInput.fill(String(qty));
      await page.waitForTimeout(600);

      // 快照核对
      const snap = {
        code: await page.locator('input[placeholder="请输入代码或简称"]').inputValue(),
        price: await priceInput.inputValue(),
        qty: await qtyInput.inputValue(),
      };
      const expect = { code: String(code), price: String(price), qty: String(qty) };
      for (const k of ["code", "price", "qty"]) {
        if (Number(snap[k]) !== Number(expect[k]) && snap[k] !== expect[k]) {
          const shot = await this._shot(page, "snapshot-mismatch");
          throw new Error(`快照核对失败 ${k}: 输入框=${snap[k]} 期望=${expect[k]} (${shot})`);
        }
      }
      this.log(`快照核对通过 ${JSON.stringify(snap)}`);

      // 点下单按钮
      await page.locator("div.input.button", { hasText: btnText }).click();
      await page.waitForTimeout(1200);

      const dialogText = await page.evaluate(
        () => document.querySelector(".aui-dialog")?.innerText || "",
      );
      if (!dialogText) {
        const shot = await this._shot(page, "no-dialog");
        throw new Error("确认弹窗未出现 (" + shot + ")");
      }

      // 弹窗二次核对
      const checks = [
        [dialogText.includes(String(code)), `弹窗缺少代码 ${code}`],
        [dialogText.includes(String(price)), `弹窗缺少价格 ${price}`],
        [dialogText.includes(String(qty)), `弹窗缺少数量 ${qty}`],
        [dialogText.includes(side === "buy" ? "买入" : "卖出"), "弹窗方向不符"],
      ];
      for (const [ok, msg] of checks) {
        if (!ok) {
          const shot = await this._shot(page, "dialog-mismatch");
          throw new Error(msg + " (" + shot + ")");
        }
      }

      const before = await this._shot(page, `${action}-dialog`);
      const audit = { zjzh, comboName, side, code: String(code), price, qty, snap, expect, dialogText };
      this._saveMeta(before, { stage: "dialog", ...audit });

      if (dryRun) {
        await page.locator(".aui-dialog").getByText("取消", { exact: true }).click();
        await page.waitForTimeout(600);
        const stillVisible = await page.locator(".aui-dialog").first().isVisible().catch(() => false);
        if (stillVisible) {
          const shot = await this._shot(page, "dryrun-dialog-stuck");
          throw new Error("dry-run 点击取消后确认弹窗仍存在 (" + shot + ")");
        }
        this._saveMeta(before, { stage: "dry-run-cancelled", ...audit });
        return { dryRun: true, ok: true, name: stockName, dialogText, screenshot: before };
      }

      // 真下单：先挂响应监听，再点确定
      const respPromise = page.waitForResponse(
        (r) => r.url().includes("emstockdiag") && (r.request().postData() || "").includes("add_order"),
        { timeout: 40000 },
      );
      await page.locator(".aui-dialog").getByText("确定", { exact: true }).click();
      const resp = await respPromise;
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const after = await this._shot(page, `${action}-after`);
      const response = json || { raw: text.slice(0, 500) };
      this._saveMeta(after, {
        stage: json?.result === "0" ? "submitted" : "rejected",
        ...audit, orderId: json?.data?.orderId || null, response,
      });

      // 让视频多停留一会儿，清楚展示提交后的页面
      await page.waitForTimeout(1500);

      return {
        dryRun: false,
        ok: json?.result === "0",
        orderId: json?.data?.orderId,
        name: stockName,
        dialogText,
        response,
        screenshot: after,
      };
    } catch (e) {
      await this._shot(page, `${action}-error`).catch(() => {});
      throw e;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * 撤单（GUI）
   */
  async cancel({ zjzh, comboName = "", orderId, dryRun = true }) {
    const page = await this._newPage();
    const pageUrl = `${H5_BASE}/group/simulation/cancel.html?zh=${zjzh}&name=${encodeURIComponent(comboName)}`;
    try {
      await this._goto(page, pageUrl);
      await page.waitForTimeout(2500);
      if (this.clickMarker) await this._installClickMarker(page);

      const btn = page.locator(`button[onclick*="${orderId}"]`).first();
      if ((await btn.count()) === 0) {
        return { dryRun, ok: false, reason: "not_found", message: "撤单页未找到该委托" };
      }
      const onclick = await btn.getAttribute("onclick");

      await btn.click();
      await page.waitForTimeout(1200);
      const dialogText = await page.evaluate(
        () => document.querySelector(".aui-dialog")?.innerText || "",
      );
      if (!dialogText) throw new Error("撤单确认弹窗未出现");
      if (!dialogText.includes(String(orderId))) throw new Error("撤单弹窗合同编号不符");

      const shot = await this._shot(page, "cancel-dialog");
      const audit = { zjzh, comboName, orderId: String(orderId), onclick, dialogText };
      this._saveMeta(shot, { stage: "cancel-dialog", ...audit });

      if (dryRun) {
        await page.locator(".aui-dialog").getByText("取消", { exact: true }).click();
        await page.waitForTimeout(600);
        const stillVisible = await page.locator(".aui-dialog").first().isVisible().catch(() => false);
        if (stillVisible) throw new Error("撤单 dry-run 点击取消后弹窗仍存在");
        this._saveMeta(shot, { stage: "cancel-dry-run-cancelled", ...audit });
        return { dryRun: true, ok: true, dialogText, onclick, screenshot: shot };
      }

      const respPromise = page.waitForResponse(
        (r) => r.url().includes("emstockdiag") && (r.request().postData() || "").includes("cancel_order"),
        { timeout: 40000 },
      );
      await page.locator(".aui-dialog").getByText("确定", { exact: true }).click();
      const resp = await respPromise;
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const afterShot = await this._shot(page, "cancel-after");
      const response = json || { raw: text.slice(0, 300) };
      this._saveMeta(afterShot, { stage: "cancelled", ...audit, response });
      return { dryRun: false, ok: json?.result === "0", orderId, dialogText, response };
    } catch (e) {
      await this._shot(page, "cancel-error").catch(() => {});
      throw e;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
