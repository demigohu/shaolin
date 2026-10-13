/**
 * Deterministic SMC helpers over real OHLC candles ({ t, o, h, l, c }):
 * fractal swings, previous-day H/L, Asian range, BOS, order blocks, fib OTE.
 */

import { toPips } from "./tools/price.js";
import { getAsianWindowUtc } from "./smc-sessions.js";

/** k-bar fractals: a swing high has k lower highs on each side (last k bars unconfirmed). */
export function findFractals(candles, k = 2) {
  const highs = [];
  const lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(candles[i].h > candles[i - j].h && candles[i].h >= candles[i + j].h)) isHigh = false;
      if (!(candles[i].l < candles[i - j].l && candles[i].l <= candles[i + j].l)) isLow = false;
    }
    if (isHigh) highs.push({ i, t: candles[i].t, price: candles[i].h });
    if (isLow) lows.push({ i, t: candles[i].t, price: candles[i].l });
  }
  return { highs, lows };
}

/** Last completed daily bar (the in-progress session bar is skipped). */
export function previousDayHL(d1, now = Date.now()) {
  if (!d1?.length) return { pdh: null, pdl: null };
  const last = d1.at(-1);
  const inProgress = now - last.t < 24 * 60 * 60 * 1000;
  const prev = inProgress ? d1.at(-2) : last;
  if (!prev) return { pdh: null, pdl: null };
  return { pdh: prev.h, pdl: prev.l, date: new Date(prev.t).toISOString().slice(0, 10) };
}

/** Previous completed week's H/L from daily bars (weeks split on Monday UTC). */
export function previousWeekHL(d1, now = Date.now()) {
  if (!d1?.length) return { pwh: null, pwl: null };
  const weekStart = (t) => {
    const d = new Date(t);
    const dow = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  };
  const thisWeek = weekStart(now);
  const lastWeek = thisWeek - 7 * 24 * 60 * 60 * 1000;
  const bars = d1.filter((k) => weekStart(k.t) === lastWeek);
  if (!bars.length) return { pwh: null, pwl: null };
  return { pwh: Math.max(...bars.map((k) => k.h)), pwl: Math.min(...bars.map((k) => k.l)) };
}

/** Asian range (07–13 WIB) from intraday candles. */
export function asianRange(candles, now = new Date()) {
  const win = getAsianWindowUtc(now);
  const bars = (candles || []).filter((k) => k.t >= win.start && k.t < win.end);
  if (bars.length < 4) return null;
  return {
    date: win.date,
    high: Math.max(...bars.map((k) => k.h)),
    low: Math.min(...bars.map((k) => k.l)),
    bars: bars.length,
    complete: now.getTime() >= win.end,
  };
}

/** Latest confirmed swing high/low on the given candles (fallback: window extremes). */
export function swingRange(candles, lookback = 48) {
  const win = (candles || []).slice(-lookback);
  if (win.length < 5) return null;
  const { highs, lows } = findFractals(win);
  const rangeHigh = Math.max(...win.map((k) => k.h));
  const rangeLow = Math.min(...win.map((k) => k.l));
  const swingHigh = highs.at(-1)?.price ?? rangeHigh;
  const swingLow = lows.at(-1)?.price ?? rangeLow;
  if (!(swingHigh > swingLow)) {
    return { swing_high: rangeHigh, swing_low: rangeLow, range_high: rangeHigh, range_low: rangeLow, source: "range" };
  }
  return {
    swing_high: swingHigh,
    swing_low: swingLow,
    range_high: rangeHigh,
    range_low: rangeLow,
    source: highs.length && lows.length ? "fractal" : "range",
  };
}

/** Break of structure: last close beyond the latest confirmed fractal. */
export function detectBos(candles, lookback = 60) {
  const win = (candles || []).slice(-lookback);
  if (win.length < 7) return null;
  const { highs, lows } = findFractals(win);
  const close = win.at(-1).c;
  const lastHigh = highs.at(-1)?.price ?? null;
  const lastLow = lows.at(-1)?.price ?? null;
  let bos = null;
  if (lastHigh != null && close > lastHigh) bos = "bullish_bos";
  else if (lastLow != null && close < lastLow) bos = "bearish_bos";
  return { bos, last_swing_high: lastHigh, last_swing_low: lastLow, close };
}

/**
 * Order blocks: last opposite candle before a displacement that closes beyond it.
 * Only unmitigated blocks (price hasn't closed through them since) are returned.
 */
export function findOrderBlocks(candles, lookback = 60) {
  const win = (candles || []).slice(-lookback);
  if (win.length < 10) return { bullish: null, bearish: null };
  const avgRange = win.reduce((s, k) => s + (k.h - k.l), 0) / win.length;
  let bullish = null;
  let bearish = null;

  for (let i = win.length - 4; i >= 0 && (!bullish || !bearish); i--) {
    const k = win[i];
    const next = win.slice(i + 1, i + 4);
    const after = win.slice(i + 1);
    if (!bullish && k.c < k.o) {
      const maxClose = Math.max(...next.map((n) => n.c));
      if (maxClose > k.h && maxClose - k.l >= 1.5 * avgRange && !after.some((n) => n.c < k.l)) {
        bullish = { low: k.l, high: k.h, t: k.t };
      }
    }
    if (!bearish && k.c > k.o) {
      const minClose = Math.min(...next.map((n) => n.c));
      if (minClose < k.l && k.h - minClose >= 1.5 * avgRange && !after.some((n) => n.c > k.h)) {
        bearish = { low: k.l, high: k.h, t: k.t };
      }
    }
  }
  return { bullish, bearish };
}

/** Wick rejection on the last CLOSED candle. */
export function wickRejection(candles) {
  const k = candles?.at(-2);
  if (!k) return null;
  const range = k.h - k.l;
  if (range <= 0) return null;
  const lower = (Math.min(k.o, k.c) - k.l) / range;
  const upper = (k.h - Math.max(k.o, k.c)) / range;
  if (lower >= 0.5 && k.c >= k.o) return "bullish_rejection";
  if (upper >= 0.5 && k.c <= k.o) return "bearish_rejection";
  return null;
}

export function computeFibOte(swing, trend, price) {
  if (!swing || price == null) return null;
  const { swing_high: hi, swing_low: lo } = swing;
  const diff = hi - lo;
  if (diff <= 0) return null;

  const bearish = String(trend || "").toLowerCase().startsWith("bear");
  const at = (r) => (bearish ? lo + diff * r : hi - diff * r);
  const levels = { "0.382": at(0.382), "0.5": at(0.5), "0.618": at(0.618), "0.72": at(0.72), "0.786": at(0.786) };

  const zoneLow = Math.min(levels["0.618"], levels["0.72"]);
  const zoneHigh = Math.max(levels["0.618"], levels["0.72"]);
  const inOte = price >= zoneLow && price <= zoneHigh;

  return {
    trend_for_fib: bearish ? "Bearish" : "Bullish",
    levels,
    ote_zone: { low: zoneLow, high: zoneHigh },
    in_ote_zone: inOte,
    dist_to_ote_pips: inOte ? 0 : toPips(Math.min(Math.abs(price - zoneLow), Math.abs(price - zoneHigh))),
  };
}

/**
 * Bias from TradingView EMA-based market_structure, entries ordered HTF → LTF:
 * [["4h", analysis], ["1h", analysis], ["15m", analysis]].
 */
export function inferStructureBias(entries) {
  const trends = entries.map(([, a]) => a?.market_structure?.trend);
  const bull = trends.filter((t) => t === "Bullish").length;
  const bear = trends.filter((t) => t === "Bearish").length;
  let bias = "mixed";
  if (bull >= 2 && bull > bear) bias = "bullish";
  if (bear >= 2 && bear > bull) bias = "bearish";

  // Counter-trend move on the lowest TF against the one above it.
  const [mid, low] = trends.slice(-2);
  let bms_hint = null;
  if (mid === "Bullish" && low === "Bearish") bms_hint = "potential_bearish_bms_on_ltf";
  if (mid === "Bearish" && low === "Bullish") bms_hint = "potential_bullish_bms_on_ltf";

  return { bias, bms_hint, alignment: Object.fromEntries(entries.map(([tf], i) => [tf, trends[i]])) };
}
