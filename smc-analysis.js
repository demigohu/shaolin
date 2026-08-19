/**
 * Deterministic SMC helpers — fib OTE, swing structure, OB zones, Asian range bootstrap.
 */

import { config } from "./config.js";
import { toPips } from "./tools/price.js";

function pd(analysis) {
  return analysis?.price_data || {};
}

export function inferSwingRange(h1, m15) {
  const h = pd(h1);
  const m = pd(m15);
  const high = Math.max(h.high || 0, m.high || 0, h.close || 0, m.close || 0);
  const low = Math.min(
    h.low || Infinity,
    m.low || Infinity,
    h.close || Infinity,
    m.close || Infinity,
  );
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  return { swing_high: high, swing_low: low, source: "h1_m15" };
}

export function computeFibOte(swing, trend, price) {
  if (!swing || price == null) return null;
  const { swing_high: hi, swing_low: lo } = swing;
  const diff = hi - lo;
  if (diff <= 0) return null;

  const levels = trend === "Bearish" || trend === "bearish"
    ? {
        "0.5": lo + diff * 0.5,
        "0.618": lo + diff * 0.618,
        "0.72": lo + diff * 0.72,
      }
    : {
        "0.5": hi - diff * 0.5,
        "0.618": hi - diff * 0.618,
        "0.72": hi - diff * 0.72,
      };

  const zoneLow = Math.min(levels["0.618"], levels["0.72"]);
  const zoneHigh = Math.max(levels["0.618"], levels["0.72"]);
  const inOte = price >= zoneLow && price <= zoneHigh;

  return {
    trend_for_fib: trend,
    levels,
    ote_zone: { low: zoneLow, high: zoneHigh },
    in_ote_zone: inOte,
    dist_to_ote_pips: inOte ? 0 : toPips(Math.min(Math.abs(price - zoneLow), Math.abs(price - zoneHigh))),
  };
}

export function inferStructureBias(h4, h1, m15) {
  const trends = [h4?.market_structure?.trend, h1?.market_structure?.trend, m15?.market_structure?.trend];
  const bull = trends.filter((t) => t === "Bullish").length;
  const bear = trends.filter((t) => t === "Bearish").length;
  let bias = "mixed";
  if (bull >= 2 && bull > bear) bias = "bullish";
  if (bear >= 2 && bear > bull) bias = "bearish";

  const h1t = h1?.market_structure?.trend;
  const m15t = m15?.market_structure?.trend;
  let bms_hint = null;
  if (h1t === "Bullish" && m15t === "Bearish") bms_hint = "potential_bearish_bms_on_ltf";
  if (h1t === "Bearish" && m15t === "Bullish") bms_hint = "potential_bullish_bms_on_ltf";

  const h1Score = h1?.market_structure?.trend_score ?? 0;
  const m15Score = m15?.market_structure?.trend_score ?? 0;
  let sms_hint = null;
  if (Math.abs(h1Score) >= 2 && Math.sign(h1Score) !== Math.sign(m15Score || 0)) {
    sms_hint = "potential_failure_swing_ltf";
  }

  return { bias, bms_hint, sms_hint, alignment: { h4: trends[0], h1: trends[1], m15: trends[2] } };
}

/** Proxy order block zone from S/R + last candle character. */
export function inferOrderBlockZones(m15, m5) {
  const sr = m15?.support_resistance || m5?.support_resistance || {};
  const candle = m5?.market_structure?.candle || m15?.market_structure?.candle || {};
  const pd5 = pd(m5);
  const price = pd5.close ?? pd5.current_price;

  const bullishOb = sr.support_1 ?? sr.nearest_support ?? sr.pivot;
  const bearishOb = sr.resistance_1 ?? sr.nearest_resistance ?? sr.pivot;

  return {
    bullish_ob_zone: bullishOb,
    bearish_ob_zone: bearishOb,
    last_candle: candle.type || null,
    wick_rejection: (candle.lower_wick_pct > 40 && candle.type === "Bullish")
      ? "bullish_rejection"
      : (candle.upper_wick_pct > 40 && candle.type === "Bearish")
        ? "bearish_rejection"
        : null,
    price,
  };
}

/** Seed Asian range from overnight H1 range when Asian session hasn't populated yet. */
export function bootstrapAsianRangeProxy(h1, m15) {
  const swing = inferSwingRange(h1, m15);
  if (!swing) return null;
  const pip = config.broker.pipSize || 0.1;
  const widthPips = toPips(swing.swing_high - swing.swing_low);
  const maxAsian = config.smc?.asianRangeMaxPips ?? 50;
  if (widthPips > maxAsian * 2) {
    const mid = (swing.swing_high + swing.swing_low) / 2;
    const half = (maxAsian * pip) / 2;
    return {
      date: new Date().toISOString().slice(0, 10),
      high: mid + half,
      low: mid - half,
      samples: 0,
      proxy: true,
      source: "overnight_mid_range",
    };
  }
  return {
    date: new Date().toISOString().slice(0, 10),
    high: swing.swing_high,
    low: swing.swing_low,
    samples: 0,
    proxy: true,
    source: "h1_m15_range",
  };
}
