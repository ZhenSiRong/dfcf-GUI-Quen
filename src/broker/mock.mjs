/**
 * MockBroker —— 内存版券商，接口与 WapBroker 完全一致
 * ---------------------------------------------------------------
 * 用途：
 *  - 单元测试 / 端到端 dry-run（不接触任何真实账户）
 *  - 回放真实快照（fixtures/snapshot_real.json）做回归
 *
 * 行为刻意为「保守」：挂单不会自动成交；只有 cancel 会释放冻结。
 */
import fs from "node:fs";

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
// 与真实冻结金额对齐：佣金 max(5, 千一) + 过户费 0.001%
const feeOf = (notional) => Math.max(5, notional * 0.001) + notional * 0.00001;

export class MockBroker {
  constructor({ cash = 1_000_000, initialCash = null, positions = [], name = "mock", log } = {}) {
    this.name = name;
    this.initial = initialCash ?? cash;
    this.cash = cash;
    this.frozen = 0;
    this.positionsMap = new Map();
    for (const p of positions) {
      this.positionsMap.set(String(p.code), {
        code: String(p.code), name: p.name || "", qty: num(p.qty) || 0,
        available: num(p.available ?? p.qty) || 0, cost: num(p.cost) || 0,
        last: num(p.last) || num(p.cost) || 0, marketValue: num(p.marketValue) || 0,
        pnl: num(p.pnl) || 0,
      });
    }
    this.ordersMap = new Map();
    this.seq = 1;
    this.log = log || (() => {});
  }

  /** 从 fixtures/snapshot_*.json 回放某个组合（找不到 key 时退回第一个组合） */
  static fromSnapshot(file, key = "demo", opts = {}) {
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    const s = all[key] || all[Object.keys(all)[0]];
    if (!s) throw new Error(`快照中找不到 ${key}`);
    const b = s.balance || {};
    return new MockBroker({
      cash: num(b.cash) ?? 1_000_000,
      initialCash: num(b.initial) ?? num(b.total) ?? 1_000_000,
      positions: s.positions?.positions || [],
      name: key,
      ...opts,
    });
  }

  static async create(opts = {}) {
    return new MockBroker(opts);
  }

  async close() {}

  async health() {
    return { ok: true, total: this._total(), cash: this.cash, mock: true };
  }

  _marketValue() {
    let mv = 0;
    for (const p of this.positionsMap.values()) mv += (p.last || p.cost || 0) * p.qty;
    return mv;
  }

  _total() {
    return this.cash + this.frozen + this._marketValue();
  }

  async balance() {
    return {
      ok: true,
      message: "ok",
      total: Number(this._total().toFixed(3)),
      cash: Number(this.cash.toFixed(3)),
      marketValue: Number(this._marketValue().toFixed(3)),
      frozen: Number(this.frozen.toFixed(3)),
      initial: this.initial,
      pnlToday: 0,
      pnlHolding: 0,
      mock: true,
    };
  }

  async positions() {
    return {
      ok: true,
      message: "ok",
      positions: [...this.positionsMap.values()].map((p) => ({ ...p })),
    };
  }

  async orders() {
    return {
      ok: true,
      message: "ok",
      orders: [...this.ordersMap.values()].map((o) => ({ ...o })),
    };
  }

  async place({ side, code, price, qty, dryRun = true }) {
    if (!["buy", "sell"].includes(side)) throw new Error("side 必须是 buy/sell");
    const codeS = String(code);
    const notional = price * qty;

    if (side === "buy" && this.cash < notional + feeOf(notional)) {
      return { dryRun, ok: false, name: "", response: { result: "-1", message: "可用资金不足" } };
    }
    if (side === "sell") {
      const p = this.positionsMap.get(codeS);
      if (!p || (p.available || 0) < qty) {
        return { dryRun, ok: false, name: p?.name || "", response: { result: "-1", message: "可卖数量不足" } };
      }
    }

    if (dryRun) {
      return {
        dryRun: true, ok: true, orderId: null, name: this.positionsMap.get(codeS)?.name || "",
        dialogText: "mock dry-run", response: { result: "0", message: "dry-run 未提交" },
      };
    }

    const orderId = `MOCK${String(this.seq++).padStart(12, "0")}`;
    const name = this.positionsMap.get(codeS)?.name || "";
    const order = {
      orderId, code: codeS, name, side, price, qty, filledQty: 0, filledPrice: null,
      status: "未报", canCancel: true, date: new Date().toISOString().slice(0, 10),
    };
    if (side === "buy") {
      const fee = feeOf(notional);
      this.cash -= notional + fee;
      this.frozen += notional + fee;
      order.frozen = notional + fee;
    } else {
      const p = this.positionsMap.get(codeS);
      p.qty -= qty;
      p.available -= qty;
      if (p.qty <= 0) this.positionsMap.delete(codeS);
    }
    this.ordersMap.set(orderId, order);
    this.log(`[mock] place ${side} ${codeS} ${qty}@${price} -> ${orderId}`);
    return { dryRun: false, ok: true, orderId, name, dialogText: "mock", response: { result: "0", message: "委托成功", data: { orderId } } };
  }

  async cancel({ orderId, dryRun = true }) {
    const o = this.ordersMap.get(String(orderId));
    if (!o) return { dryRun, ok: false, reason: "not_found" };
    if (dryRun) return { dryRun: true, ok: true, orderId, dialogText: "mock dry-run" };

    if (o.side === "buy") {
      const frozen = o.frozen ?? o.price * o.qty + feeOf(o.price * o.qty);
      this.frozen = Math.max(0, this.frozen - frozen);
      this.cash += frozen;
    } else {
      const p = this.positionsMap.get(o.code) || {
        code: o.code, name: o.name, qty: 0, available: 0, cost: o.price, last: o.price,
      };
      p.qty += o.qty;
      p.available += o.qty;
      this.positionsMap.set(o.code, p);
    }
    this.ordersMap.delete(String(orderId));
    this.log(`[mock] cancel ${orderId}`);
    return { dryRun: false, ok: true, orderId, response: { result: "0", message: "撤单成功" } };
  }

  /** 测试辅助：直接设置行情，刷新持仓市值 */
  setPrice(code, price) {
    const p = this.positionsMap.get(String(code));
    if (p) {
      p.last = price;
      p.marketValue = price * p.qty;
    }
  }
}
