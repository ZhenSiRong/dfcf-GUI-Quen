/**
 * POC-3 · 下单—查询—撤单闭环（零风险：跌停价限价单，永不成交）
 * ---------------------------------------------------------------
 * 用法：
 *   node scripts/poc3_order.mjs place    下 1 手 601398 @ 跌停价，验证委托存在
 *   node scripts/poc3_order.mjs cancel   撤销该委托，验证委托消失、持仓不变
 *
 * 安全设计：
 *  - 价格 = 页面自己显示的跌停价（买价 < 最新价 → 只进撮合队列，不会成交）
 *  - 数量 100 股，金额 ~757 元
 *  - 下单前做「快照核对」：读回输入框值 + 校验确认弹窗复述文本
 *  - 任何断言失败立即中止，不点「确定」
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ZH = process.env.POC_ZH || "000000000000000000"; // 替换为自己的模拟组合 zjzh
const NAME = process.env.POC_NAME || "demo";
const CODE = "601398";
const PRICE = "7.57"; // 页面显示的跌停价
const QTY = "100";
const API = "https://emstockdiag.eastmoney.com/apistock/tran/getJson";

const mode = process.argv[2] || "place";
const dir = path.join(ROOT, "logs/poc3");
fs.mkdirSync(dir, { recursive: true });

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const shot = (page, name) => page.screenshot({ path: path.join(dir, `${mode}-${name}.png`) });

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  log("✔ " + msg);
}

async function apiGet(ctx, pageUrl, parm) {
  const r = await ctx.request.post(API, {
    form: { path: "zuheV64/JS.aspx", pageUrl, urlParm: JSON.stringify(parm) },
    headers: { Referer: pageUrl, Origin: "https://groupwap.eastmoney.com" },
    timeout: 25000,
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
}

async function readState(ctx) {
  const pageUrl = `https://groupwap.eastmoney.com/group/simulation/hold.html?zh=${ZH}`;
  const hold = await apiGet(ctx, pageUrl, [{ type: "hold" }, { recIdx: 0 }, { zh: ZH }, { recCnt: 100 }, { appVer: "9001000" }]);
  const orders = await apiGet(ctx, pageUrl, [{ type: "orders_valid" }, { recIdx: 0 }, { zh: ZH }, { recCnt: 100 }, { appVer: "9001000" }]);
  const bal = await apiGet(ctx, pageUrl, [{ type: "user_infos" }, { infoType: "zuhe_bal_info" }, { zh: ZH }, { appVer: "9001000" }]);
  return { hold, orders, bal };
}

async function fillBuyForm(page) {
  const codeInput = page.locator('input[placeholder="请输入代码或简称"]');
  await codeInput.click();
  await page.keyboard.type(CODE, { delay: 100 });
  await page.waitForTimeout(1800);
  await page.getByText("工商银行", { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  await page.locator("#price").fill(PRICE);
  await page.locator('input[placeholder="买入数量"]').fill(QTY);
  await page.waitForTimeout(700);

  const snap = {
    code: await codeInput.inputValue(),
    price: await page.locator("#price").inputValue(),
    qty: await page.locator('input[placeholder="买入数量"]').inputValue(),
  };
  log("快照: " + JSON.stringify(snap));
  assert(snap.code === CODE && snap.price === PRICE && snap.qty === QTY, "输入框回读与预期一致");
  return snap;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--ssl-version-max=tls1.2"],
  });
  const ctx = await browser.newContext({
    storageState: path.join(ROOT, "state/storage_state.json"),
    locale: "zh-CN",
    viewport: { width: 430, height: 900 },
  });
  const page = await ctx.newPage();

  const before = await readState(ctx);
  log("下单前: 持仓数=" + (before.hold.listData?.length ?? "?") + " 委托数=" + (before.orders.listData?.length ?? "?"));
  log("下单前资金: " + JSON.stringify(before.bal.listData?.[0] || {}));

  if (mode === "place") {
    await page.goto(`https://groupwap.eastmoney.com/group/simulation/buy.html?zh=${ZH}&name=${encodeURIComponent(NAME)}`, {
      waitUntil: "domcontentloaded", timeout: 40000,
    });
    await page.waitForTimeout(3000);

    await fillBuyForm(page);
    await shot(page, "filled");

    // 点击「模拟买入」，捕获确认弹窗
    const addResp = page.waitForResponse(
      (r) => r.url().includes("emstockdiag") && (r.request().postData() || "").includes("add_order"),
      { timeout: 40000 },
    );
    await page.locator("div.input.button", { hasText: "模拟买入" }).click();
    await page.waitForTimeout(1500);

    const dlgText = await page.evaluate(() => document.querySelector(".aui-dialog")?.innerText || null);
    log("确认弹窗: " + JSON.stringify(dlgText));
    assert(!!dlgText, "确认弹窗已出现");
    assert(dlgText.includes(CODE) && dlgText.includes(PRICE) && dlgText.includes(QTY), "弹窗复述的代码/价格/数量与预期一致");
    assert(dlgText.includes("买入"), "弹窗方向为买入");
    await shot(page, "dialog");

    // 点确定
    const dlg = page.locator(".aui-dialog");
    await dlg.getByText("确定", { exact: true }).click();
    log("已点确定，等待 add_order 响应…");

    const resp = await addResp;
    const respText = await resp.text();
    log("add_order 响应: " + respText.slice(0, 500));
    fs.writeFileSync(path.join(dir, "add_order_response.json"), respText);
    await page.waitForTimeout(2500);
    await shot(page, "after_submit");
    log("提交后页面: " + (await page.$eval("body", (e) => e.innerText)).replace(/\n+/g, " | ").slice(0, 200));

    // 查委托
    const after = await readState(ctx);
    log("下单后: 委托数=" + (after.orders.listData?.length ?? "?") + " 持仓数=" + (after.hold.listData?.length ?? "?"));
    log("委托明细: " + JSON.stringify(after.orders.listData || []).slice(0, 600));
    fs.writeFileSync(path.join(dir, "after_place_state.json"), JSON.stringify(after, null, 2));

    // 打开撤单页，抓 DOM 结构
    await page.goto(`https://groupwap.eastmoney.com/group/simulation/cancel.html?zh=${ZH}&name=${encodeURIComponent(NAME)}`, {
      waitUntil: "domcontentloaded", timeout: 40000,
    });
    await page.waitForTimeout(3500);
    log("撤单页文本: " + (await page.$eval("body", (e) => e.innerText)).replace(/\n+/g, " | ").slice(0, 400));
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll("a,div,button")].map((b) => ({ tag: b.tagName, cls: b.className, t: (b.innerText || "").trim() }))
        .filter((x) => x.t && x.t.length < 12 && /撤单|撤销|取消/.test(x.t)),
    );
    log("撤单按钮候选: " + JSON.stringify(btns));
    await shot(page, "cancel_page");
  }

  if (mode === "cancel") {
    const st = await readState(ctx);
    const list = st.orders.listData || [];
    log("当前可撤委托: " + JSON.stringify(list).slice(0, 600));
    assert(list.length === 1, "恰好有 1 笔可撤委托");

    await page.goto(`https://groupwap.eastmoney.com/group/simulation/cancel.html?zh=${ZH}&name=${encodeURIComponent(NAME)}`, {
      waitUntil: "domcontentloaded", timeout: 40000,
    });
    await page.waitForTimeout(3500);
    log("撤单页文本: " + (await page.$eval("body", (e) => e.innerText)).replace(/\n+/g, " | ").slice(0, 400));

    const cancelResp = page.waitForResponse(
      (r) => r.url().includes("emstockdiag") && (r.request().postData() || "").includes("cancel_order"),
      { timeout: 40000 },
    );
    // 点撤单（真实按钮：<button onclick="javascript:cancel(...)">撤</button>）
    const btn = page.locator('button[onclick*="cancel("]').first();
    log("撤单按钮: " + (await btn.evaluate((e) => e.outerHTML.replace(/\s+/g, " ").slice(0, 160))));
    await btn.click();
    await page.waitForTimeout(1500);
    const dlgText = await page.evaluate(() => document.querySelector(".aui-dialog")?.innerText || null);
    log("撤单弹窗: " + JSON.stringify(dlgText));
    await shot(page, "cancel_dialog");
    if (dlgText) {
      await page.locator(".aui-dialog").getByText("确定", { exact: true }).click();
    }
    const resp = await cancelResp;
    const txt = await resp.text();
    log("cancel_order 响应: " + txt.slice(0, 400));
    fs.writeFileSync(path.join(dir, "cancel_order_response.json"), txt);
    await page.waitForTimeout(2500);
    await shot(page, "after_cancel");

    const after = await readState(ctx);
    log("撤单后: 委托数=" + (after.orders.listData?.length ?? "?") + " 持仓数=" + (after.hold.listData?.length ?? "?"));
    assert((after.orders.listData?.length || 0) === 0, "委托已消失");
    assert((after.hold.listData?.length || 0) === 0, "持仓仍为 0（未产生任何成交）");
    const cb = after.bal.listData?.[0] || {};
    assert(Number(cb.sdje) === 0, `冻结金额已释放 (sdje=${cb.sdje})`);
    assert(Number(cb.kyye) === Number(cb.csje), `可用资金回到初始 (${cb.kyye}/${cb.csje})`);
  }

  await browser.close();
  log("DONE " + mode);
}

main().catch(async (e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
