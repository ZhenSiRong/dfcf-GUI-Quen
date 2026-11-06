/**
 * 风控层：所有下单必须经过这里，禁止绕过
 * ---------------------------------------------------------------
 * 纯函数，无 IO —— 便于单测。
 * 输入是「已经取到的快照」，输出是决策。
 */
import { RISK } from "../config.mjs";
import { limitPrices } from "../market/push2.mjs";

const R = (ok, rule, detail) => ({ ok, rule, detail });

/**
 * 下单前校验。
 *
 * @param {object} o
 * @param {"buy"|"sell"} o.side
 * @param {string} o.code
 * @param {number} o.price      限价
 * @param {number} o.qty        股数
 * @param {object} o.quote      {last, prevClose, name}
 * @param {object} o.balance    {total, cash}     total=总资产, cash=可用
 * @param {Map|object} o.positions  {code: {qty, marketValue}}
 * @param {number} o.todayOrders  当日已成功下单笔数
 * @param {number} o.consecutiveFailures 连续失败次数
 * @param {object} [o.cfg]
 */
export function checkOrder(o) {
  const cfg = { ...RISK, ...(o.cfg || {}) };
  const { side, code, price, qty, quote, balance, positions } = o;

  if (!["buy", "sell"].includes(side)) return R(false, "side", `非法方向 ${side}`);
  if (!quote || !Number.isFinite(quote.last) || quote.last <= 0) return R(false, "quote", "无有效行情");
  if (!Number.isFinite(price) || price <= 0) return R(false, "price", "非法价格");
  if (!Number.isInteger(qty) || qty <= 0) return R(false, "qty", "非法数量");

  // 熔断
  if ((o.consecutiveFailures || 0) >= cfg.maxConsecutiveFailures) {
    return R(false, "circuit_breaker", `连续失败 ${o.consecutiveFailures} 次`);
  }

  // 单日笔数
  if ((o.todayOrders || 0) >= cfg.maxOrdersPerDay) {
    return R(false, "daily_limit", `当日已下单 ${o.todayOrders} 笔`);
  }

  // 涨跌停范围
  const lim = limitPrices(quote, code);
  if (lim && (price > lim.up + 1e-9 || price < lim.down - 1e-9)) {
    return R(false, "limit_band", `价格 ${price} 超出 [${lim.down}, ${lim.up}]`);
  }

  // 价格偏离
  const dev = Math.abs(price - quote.last) / quote.last;
  if (dev > cfg.maxPriceDeviation) {
    return R(false, "price_deviation", `偏离最新价 ${(dev * 100).toFixed(2)}% > ${(cfg.maxPriceDeviation * 100).toFixed(0)}%`);
  }

  if (side === "buy") {
    // 整手
    if (qty % cfg.lotSize !== 0) return R(false, "lot_size", `买入必须是 ${cfg.lotSize} 股整数倍（${qty}）`);

    const notional = price * qty;
    // 单笔金额
    if (notional > cfg.maxNotionalPerOrder) {
      return R(false, "notional", `单笔 ${notional.toFixed(2)} 元 > ${cfg.maxNotionalPerOrder}`);
    }

    // 现金（佣金千一、最低 5 元；另加过户费约 0.001%）
    if (!balance || !Number.isFinite(balance.cash)) return R(false, "balance", "无资金快照");
    const fee = Math.max(5, notional * 0.001) + notional * 0.00001;
    if (notional + fee > balance.cash) {
      return R(false, "insufficient_cash", `需要 ${(notional + fee).toFixed(2)}，可用 ${balance.cash}`);
    }

    // 单票集中度（买入后）
    const posList = positions instanceof Map ? [...positions.values()] : Object.values(positions || {});
    const held = posList.find((p) => p.code === code)?.marketValue || 0;
    const total = balance.total || balance.cash + posList.reduce((s, p) => s + (p.marketValue || 0), 0);
    if (total > 0 && (held + notional) / total > cfg.maxPositionRatioPerStock) {
      return R(false, "concentration", `单票占比 ${(((held + notional) / total) * 100).toFixed(1)}% > ${(cfg.maxPositionRatioPerStock * 100).toFixed(0)}%`);
    }

    // 现金保留
    const cashAfter = balance.cash - notional - fee;
    if (total > 0 && cashAfter / total < cfg.minCashReserveRatio) {
      return R(false, "cash_reserve", `下单后现金占比 ${((cashAfter / total) * 100).toFixed(1)}% < ${(cfg.minCashReserveRatio * 100).toFixed(0)}%`);
    }
  }

  if (side === "sell") {
    const posList = positions instanceof Map ? [...positions.values()] : Object.values(positions || {});
    const held = posList.find((p) => p.code === code)?.qty || 0;
    if (qty > held) return R(false, "insufficient_position", `可卖 ${held} 股 < 卖出 ${qty}`);
  }

  return R(true, "ok", "通过");
}

/**
 * 卖出数量归一化：模拟盘允许零股卖出，但必须先卖零股再卖整手。
 * 这里简单按「全部可卖」或「整手」处理。
 */
export function normalizeSellQty(qty, held, { allowOdd = true } = {}) {
  if (qty <= 0) return 0;
  if (qty > held) qty = held;
  if (!allowOdd && qty % RISK.lotSize !== 0) qty = Math.floor(qty / RISK.lotSize) * RISK.lotSize;
  return Math.max(0, Math.floor(qty));
}
