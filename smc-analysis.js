/**
 * Deterministic SMC helpers over real OHLC candles ({ t, o, h, l, c }):
 * fractal swings, previous-day H/L, Asian range, BOS, order blocks, fib OTE.
 */

import { config } from "./config.js";
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

/** Previous calendar month's H/L from daily bars (UTC months). */
export function previousMonthHL(d1, now = Date.now()) {
  if (!d1?.length) return { pmh: null, pml: null };
  const n = new Date(now);
  const thisMonth = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1);
  const lastMonth = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1);
  const bars = d1.filter((k) => k.t >= lastMonth && k.t < thisMonth);
  if (!bars.length) return { pmh: null, pml: null };
  return { pmh: Math.max(...bars.map((k) => k.h)), pml: Math.min(...bars.map((k) => k.l)) };
}

/** Start of the current gold trading day: 18:00 New York time (DST-aware via offsetHours). */
export function tradingDayStart(now, nyOffsetHours) {
  const d = new Date(now);
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18 - nyOffsetHours);
  while (start > now) start -= 24 * 3_600_000;
  return start;
}

/** High/low of the current trading day so far (HOD/LOD). */
export function dayHighLow(candles, dayStart) {
  const bars = (candles || []).filter((k) => k.t >= dayStart);
  if (!bars.length) return { hod: null, lod: null };
  return { hod: Math.max(...bars.map((k) => k.h)), lod: Math.min(...bars.map((k) => k.l)) };
}

/**
 * Equal highs / equal lows ("retail" resistance/support = resting liquidity):
 * two or more fractal swings within `tolPips` that price has not traded through since.
 */
export function equalLevels(candles, tolPips, lookback = 96) {
  const tol = tolPips * (config.broker.pipSize || 0.1);
  const win = (candles || []).slice(-lookback);
  const { highs, lows } = findFractals(win);
  const out = [];
  const cluster = (points, kind) => {
    const used = new Set();
    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue;
      const group = [points[i]];
      for (let j = i + 1; j < points.length; j++) {
        if (!used.has(j) && Math.abs(points[j].price - points[i].price) <= tol) {
          group.push(points[j]);
          used.add(j);
        }
      }
      if (group.length < 2) continue;
      const level = kind === "eqh" ? Math.max(...group.map((g) => g.price)) : Math.min(...group.map((g) => g.price));
      const lastIdx = Math.max(...group.map((g) => g.i));
      const after = win.slice(lastIdx + 1);
      const taken = kind === "eqh" ? after.some((k) => k.h > level + tol) : after.some((k) => k.l < level - tol);
      if (!taken) out.push({ kind, price: level, touches: group.length });
    }
  };
  cluster(highs, "eqh");
  cluster(lows, "eql");
  return out;
}

/**
 * Entry-timeframe trigger state (PDF: sweep → BMS → RTO), computed bar by bar:
 * - swings: latest confirmed fractal highs/lows
 * - sweeps: bars that wicked through a liquidity pool and closed back inside
 * - bms: the most recent close through the latest confirmed swing (break in market structure)
 * - ob: the last opposite candle before that break, and whether price has returned to it (RTO)
 * - tape: the last bars, so the model can read the sequence itself
 */
export function ltfTriggerState(candles, pools = [], { lookback = 48, tapeBars = 12, sweepBars = 12 } = {}) {
  const win = (candles || []).slice(-lookback);
  if (win.length < 10) return null;
  const last = win.length - 1;
  const { highs, lows } = findFractals(win);

  // A k=2 fractal at index f is only known once bar f+2 has closed.
  let bms = null;
  for (let i = 3; i < win.length; i++) {
    const hi = highs.filter((f) => f.i <= i - 3).at(-1);
    const lo = lows.filter((f) => f.i <= i - 3).at(-1);
    if (hi && win[i].c > hi.price && win[i - 1].c <= hi.price) bms = { dir: "bullish", level: hi.price, i };
    if (lo && win[i].c < lo.price && win[i - 1].c >= lo.price) bms = { dir: "bearish", level: lo.price, i };
  }

  let ob = null;
  let rto = null;
  if (bms) {
    const wantBearCandle = bms.dir === "bullish";
    for (let j = bms.i - 1; j >= Math.max(0, bms.i - 10); j--) {
      const k = win[j];
      if (wantBearCandle ? k.c < k.o : k.c > k.o) {
        ob = { low: k.l, high: k.h };
        break;
      }
    }
    if (ob) {
      const after = win.slice(bms.i + 1);
      const failed = bms.dir === "bullish" ? after.some((k) => k.c < ob.low) : after.some((k) => k.c > ob.high);
      const touched = bms.dir === "bullish" ? after.some((k) => k.l <= ob.high) : after.some((k) => k.h >= ob.low);
      rto = failed ? "failed (closed through the OB)" : touched ? "touched" : "not yet";
    }
  }

  const sweeps = [];
  for (let i = Math.max(0, win.length - sweepBars); i < win.length; i++) {
    const k = win[i];
    for (const p of pools) {
      if (p.low != null && k.l < p.low && k.c > p.low) sweeps.push({ pool: `${p.name} low ${p.low.toFixed(2)}`, side: "ssl", bars_ago: last - i, wick: k.l });
      if (p.high != null && k.h > p.high && k.c < p.high) sweeps.push({ pool: `${p.name} high ${p.high.toFixed(2)}`, side: "bsl", bars_ago: last - i, wick: k.h });
    }
  }

  return {
    close: win[last].c,
    swing_highs: highs.slice(-3).map((f) => ({ price: f.price, bars_ago: last - f.i })),
    swing_lows: lows.slice(-3).map((f) => ({ price: f.price, bars_ago: last - f.i })),
    bms: bms ? { dir: bms.dir, level: bms.level, bars_ago: last - bms.i, close: win[bms.i].c } : null,
    ob,
    rto,
    sweeps: sweeps.slice(-4),
    tape: win.slice(-tapeBars),
  };
}
