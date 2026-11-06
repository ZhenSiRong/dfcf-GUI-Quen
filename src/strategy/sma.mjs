/**
 * 策略：日线 SMA 趋势（带迟滞带，低频）
 * ---------------------------------------------------------------
 * 纯函数，无 IO。信号只描述「方向 + 理由」，仓位由 runner 统一计算，
 * 确保所有金额仍然经过 RiskGuard。
 *
 * 规则：
 *  - trend = bull   当 SMA(short) > SMA(long) * (1 + band)
 *  - trend = bear   当 SMA(short) < SMA(long) * (1 - band)
 *  - 其余为 neutral（不做动作，避免均线附近来回摩擦）
 *  - 空仓 + bull → buy；持仓 + bear → sell；其余 hold
 */

export const DEFAULT_PARAMS = {
  short: 5,
  long: 20,
  band: 0.005,        // 0.5% 迟滞带
  minBars: 30,        // 最少历史长度
  maxChasePct: 0.05,  // 现价高于短均线 5% 不追高
};

/** 简单移动平均（最后 n 个值的均值） */
export function sma(values, n) {
  if (!Array.isArray(values) || n <= 0 || values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / n;
}

/** 趋势判定（含前一日的趋势，用于识别金叉/死叉） */
export function smaTrend(closes, { short = 5, long = 20, band = 0.005 } = {}) {
  if (!Array.isArray(closes) || closes.length < long + 1) {
    return { ok: false, reason: "insufficient_bars", need: long + 1, got: closes?.length ?? 0 };
  }
  const s = sma(closes, short);
  const l = sma(closes, long);
  const ps = sma(closes.slice(0, -1), short);
  const pl = sma(closes.slice(0, -1), long);
  if (![s, l, ps, pl].every(Number.isFinite)) {
    return { ok: false, reason: "sma_not_finite" };
  }
  const ratio = s / l;
  const prevRatio = ps / pl;
  const cls = (r) => (r > 1 + band ? "bull" : r < 1 - band ? "bear" : "neutral");
  const trend = cls(ratio);
  const prevTrend = cls(prevRatio);
  let cross = null;
  if (prevTrend !== "bull" && trend === "bull") cross = "golden";
  if (prevTrend !== "bear" && trend === "bear") cross = "death";
  return {
    ok: true, short: s, long: l, ratio, prevRatio, band, trend, prevTrend, cross,
  };
}

/**
 * 生成信号。
 * @param {object} o
 * @param {string} o.code
 * @param {Array<{close:number}>} o.bars 日 K（升序，最后一条可为当日实时价）
 * @param {number} o.positionQty 当前持仓股数
 * @param {object} [o.params]
 */
export function decide({ code, bars, positionQty = 0, params = {} }) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const closes = (bars || []).map((b) => Number(b.close)).filter(Number.isFinite);

  if (closes.length < p.minBars) {
    return { code, action: "hold", reason: "insufficient_bars", meta: { got: closes.length, need: p.minBars } };
  }

  const t = smaTrend(closes, p);
  if (!t.ok) return { code, action: "hold", reason: t.reason, meta: t };

  const last = closes.at(-1);
  const meta = {
    last, smaShort: Number(t.short.toFixed(4)), smaLong: Number(t.long.toFixed(4)),
    ratio: Number(t.ratio.toFixed(4)), trend: t.trend, prevTrend: t.prevTrend, cross: t.cross,
  };

  if (positionQty <= 0) {
    if (t.trend !== "bull") return { code, action: "hold", reason: "not_bull", meta };
    if (last > t.short * (1 + p.maxChasePct)) {
      return { code, action: "hold", reason: "too_extended", meta: { ...meta, chaseLimit: Number((t.short * (1 + p.maxChasePct)).toFixed(2)) } };
    }
    return {
      code, action: "buy",
      reason: t.cross === "golden" ? "golden_cross" : "bull_trend",
      meta,
    };
  }

  if (t.trend === "bear") {
    return {
      code, action: "sell",
      reason: t.cross === "death" ? "death_cross" : "bear_trend",
      meta,
    };
  }

  return { code, action: "hold", reason: "trend_intact", meta };
}

/** 批量生成信号 */
export function decideAll({ universe, barsByCode, positionQtyByCode = {}, params = {} }) {
  return universe.map((code) => {
    const bars = barsByCode instanceof Map ? barsByCode.get(String(code)) : barsByCode?.[String(code)];
    if (!bars || !Array.isArray(bars)) {
      return { code: String(code), action: "hold", reason: "no_bars" };
    }
    return decide({ code: String(code), bars, positionQty: positionQtyByCode[String(code)] || 0, params });
  });
}
