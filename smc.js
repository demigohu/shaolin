/**
 * Smart Money / Market Structure framework (PDF: Market Structure and Powerful Setups).
 * Session AMD, liquidity sweeps, confluence gating, setup types.
 */

import { config } from "./config.js";
import { fetchAnalysis, extractPriceFromAnalysis, extractRsi } from "./tools/market.js";
import { getSpotCandleSet } from "./tools/candles.js";
import { toPips } from "./tools/price.js";
import { log } from "./logger.js";
import {
  getAMDPhase,
  getWIBNow,
  describeAMDPhase,
  isSMCTradingWindow,
  isLondonOpenWindow,
  isNewYorkOpenWindow,
  describeTradingWindowsWib,
  tzOffsetHours,
} from "./smc-sessions.js";
import { getActiveMode } from "./modes.js";
import {
  asianRange,
  previousDayHL,
  previousWeekHL,
  previousMonthHL,
  tradingDayStart,
  dayHighLow,
  equalLevels,
  ltfTriggerState,
  swingRange,
  detectBos,
  findOrderBlocks,
  wickRejection,
  computeFibOte,
  inferStructureBias,
} from "./smc-analysis.js";
import { buildMtfZoneStack, formatMtfZonesForPrompt } from "./mtf-zones.js";

let _lastSMCContext = null;

export function getLastSMCContext() {
  return _lastSMCContext;
}

/** Setups from "Market Structure and Powerful Setups" (docs/). */
export const SETUP_TYPES = [
  "turtle_soup_long",   // SSL raid: false break below a sell-stop pool, enter long
  "turtle_soup_short",  // BSL raid: false break above a buy-stop pool, enter short
  "sh_bms_rto",         // stop hunt → break in market structure → return to order block
  "sms_bms_rto",        // failure swing → break in market structure → return to order block
  "bms_rto_ote",        // after BMS, retrace to 50% / OTE (0.618–0.72) or the OB, trade with the BMS
  "amd_distribution",   // Asian accumulation → London/NY manipulation → distribution the other way
];

/** Setups that fade a liquidity raid (exempt from trend-only filters). */
export const REVERSAL_SETUPS = new Set(["turtle_soup_long", "turtle_soup_short", "sh_bms_rto", "sms_bms_rto", "amd_distribution"]);

export const CONFLUENCE_TAGS = [
  "htf_bias",          // trade in the direction of HTF structure
  "htf_key_level",     // at an HTF order block / liquidity pool / structure level
  "mtf_sr_zone",       // multi-TF S/R cluster
  "liquidity_sweep",   // BSL/SSL just swept
  "bms",               // break in market structure on the entry TF
  "order_block_rto",   // return to the order block that caused the BMS
  "fib_ote",           // 50% / OTE retracement
  "asian_range",       // Asian high/low as the swept or targeted pool
  "session_amd",       // AMD phase fits (manipulation at London/NY open)
  "london_open",
  "ny_open",
  "high_impact_news",  // liquidity grab around a scheduled release
  "plan_poi",          // at a POI from today's plan
];

/** Liquidity taken (price beyond) or swept (wick beyond, closed back inside). */
export function isLiquidityRaid(event) {
  return event.includes("_taken_") || event.includes("_swept_");
}

export function sideOfLiquidity(events) {
  const raids = (events || []).filter(isLiquidityRaid);
  return {
    ssl: raids.some((e) => e.startsWith("ssl_")),
    bsl: raids.some((e) => e.startsWith("bsl_")),
  };
}

/**
 * For each pool level: taken = price beyond it now; swept = a recent candle
 * wicked beyond it but price is back inside (turtle soup); near = within asianNearPips.
 */
export function detectLiquidityEvents(price, pools, recentCandles = []) {
  const nearPips = config.smc?.asianNearPips ?? 5;
  const events = [];
  const hints = [];
  if (price == null) return { events, hints };

  const recentHigh = recentCandles.length ? Math.max(...recentCandles.map((k) => k.h)) : null;
  const recentLow = recentCandles.length ? Math.min(...recentCandles.map((k) => k.l)) : null;

  for (const { name, high, low } of pools) {
    if (high != null) {
      if (price > high) {
        events.push(`bsl_taken_${name}`);
        hints.push(`Price above ${name} high ${high.toFixed(2)} — BSL taken; watch for failure back below (turtle_soup_short)`);
      } else if (recentHigh != null && recentHigh > high) {
        events.push(`bsl_swept_${name}`);
        hints.push(`${name} high ${high.toFixed(2)} swept and price back below — turtle_soup_short / RTO short candidate`);
      } else if (toPips(high - price) <= nearPips) {
        events.push(`bsl_near_${name}`);
        hints.push(`Price near ${name} high ${high.toFixed(2)} (BSL pool)`);
      }
    }
    if (low != null) {
      if (price < low) {
        events.push(`ssl_taken_${name}`);
        hints.push(`Price below ${name} low ${low.toFixed(2)} — SSL taken; watch for reclaim back above (turtle_soup_long)`);
      } else if (recentLow != null && recentLow < low) {
        events.push(`ssl_swept_${name}`);
        hints.push(`${name} low ${low.toFixed(2)} swept and price back above — turtle_soup_long / RTO long candidate`);
      } else if (toPips(price - low) <= nearPips) {
        events.push(`ssl_near_${name}`);
        hints.push(`Price near ${name} low ${low.toFixed(2)} (SSL pool)`);
      }
    }
  }
  return { events, hints };
}

function suggestPlaybooks(liquidityEvents, amdPhase, ltfBos) {
  const plays = [];
  const { ssl, bsl } = sideOfLiquidity(liquidityEvents);
  if (ssl) plays.push("turtle_soup_long", "sh_bms_rto (long)");
  if (bsl) plays.push("turtle_soup_short", "sh_bms_rto (short)");
  if (ltfBos?.bos) plays.push(`bms_rto_ote (${ltfBos.bos === "bullish_bos" ? "long" : "short"})`);
  if (amdPhase === "london_manipulation" || amdPhase === "ny_distribution") plays.push("amd_distribution");
  return [...new Set(plays)];
}

/**
 * Which timeframes each mode reads structure from. TradingView TFs use MCP
 * names (1D/1W); candle keys/zone TFs use the Yahoo-derived set (d1/w1).
 */
export const STRUCTURE_PROFILES = {
  scalp: {
    tvTfs: ["5m", "15m", "1h", "4h"], htf: ["4h", "1h", "15m"], rsiTf: "15m",
    swing: { key: "h1", tf: "1h", lookback: 48 }, bos: { key: "m15", tf: "15m" }, ob: { key: "m15", tf: "15m" },
    wick: { key: "m5", tf: "5m" }, sweep: { key: "m15", bars: 8 }, trigger: { key: "m5", tf: "5m" },
    refine: { key: "m1", tf: "1m" },
    zones: ["4h", "1h", "15m", "5m"], mergePips: 8, proximityPips: 5,
    pools: ["asian", "pd", "eq"], eq: [["m15", "15m"], ["h1", "1h"]], killzoneGate: true,
  },
  day: {
    tvTfs: ["15m", "1h", "4h", "1D"], htf: ["1D", "4h", "1h"], rsiTf: "1h",
    swing: { key: "h4", tf: "4h", lookback: 30 }, bos: { key: "h1", tf: "1h" }, ob: { key: "h1", tf: "1h" },
    wick: { key: "m15", tf: "15m" }, sweep: { key: "h1", bars: 6 }, trigger: { key: "m15", tf: "15m" },
    zones: ["1d", "4h", "1h", "15m"], mergePips: 15, proximityPips: 10,
    pools: ["asian", "pd", "pw", "eq"], eq: [["h1", "1h"], ["h4", "4h"]], killzoneGate: true,
  },
  swing: {
    tvTfs: ["1h", "4h", "1D", "1W"], htf: ["1W", "1D", "4h"], rsiTf: "4h",
    swing: { key: "d1", tf: "1D", lookback: 40 }, bos: { key: "h4", tf: "4h" }, ob: { key: "h4", tf: "4h" },
    wick: { key: "h1", tf: "1h" }, sweep: { key: "h4", bars: 6 }, trigger: { key: "h1", tf: "1h" },
    zones: ["1w", "1d", "4h", "1h"], mergePips: 40, proximityPips: 25,
    pools: ["pd", "pw", "pm", "eq"], eq: [["h4", "4h"], ["d1", "1D"]], killzoneGate: false,
  },
};

export function getStructureProfile(mode = getActiveMode()) {
  const base = STRUCTURE_PROFILES[mode.id] || STRUCTURE_PROFILES.scalp;
  return {
    ...base,
    mergePips: mode.zoneMergePips ?? base.mergePips,
    proximityPips: mode.zoneProximityPips ?? base.proximityPips,
  };
}

/**
 * Build the structure context. `profileId` / `reachPips` let the planner read a
 * higher-timeframe view; `store: false` keeps the screener's cached context intact.
 */
export async function buildSMCContext({ profileId = null, reachPips = undefined, store = true } = {}) {
  const mode = getActiveMode();
  const profile = getStructureProfile(profileId ? { ...mode, id: profileId } : mode);
  const reach = reachPips === undefined ? mode.maxTpPips ?? null : reachPips;

  // Sequential (cached) TF fetches — parallel bursts trigger TradingView failure cooldowns.
  const tv = {};
  for (const tf of profile.tvTfs) tv[tf] = await fetchAnalysis(tf);

  let price = null;
  for (const tf of profile.tvTfs) {
    price = extractPriceFromAnalysis(tv[tf]);
    if (price != null) break;
  }

  // TradingView bar opens at UTC hour / quarter-hour boundaries anchor the futures→spot basis.
  const nowMs = Date.now();
  const anchors = [["1h", 3_600_000], ["15m", 900_000]]
    .filter(([tf]) => tv[tf]?.price_data?.open != null)
    .map(([tf, ms]) => ({ t: Math.floor(nowMs / ms) * ms, spot: Number(tv[tf].price_data.open) }));

  let candles = null;
  let candleError = null;
  try {
    candles = await getSpotCandleSet(price, anchors);
  } catch (error) {
    candleError = error.message;
    log("smc_warn", `Candle history unavailable: ${error.message}`);
  }

  const now = new Date();
  const amdPhase = getAMDPhase(now);
  const wib = getWIBNow(now);
  const asian = candles ? asianRange(candles.m15, now) : null;
  const { pdh, pdl } = candles ? previousDayHL(candles.d1, now.getTime()) : { pdh: null, pdl: null };
  const { pwh, pwl } = candles ? previousWeekHL(candles.d1, now.getTime()) : { pwh: null, pwl: null };
  const { pmh, pml } = candles ? previousMonthHL(candles.d1, now.getTime()) : { pmh: null, pml: null };
  const dayStart = tradingDayStart(now.getTime(), tzOffsetHours("America/New_York", now));
  const { hod, lod } = candles ? dayHighLow(candles.m15, dayStart) : { hod: null, lod: null };
  const eqTol = config.smc?.equalTolPips ?? profile.proximityPips * 2;
  const equal = candles
    ? profile.eq.flatMap(([key, tf]) => equalLevels(candles[key], eqTol).map((e) => ({ ...e, tf })))
    : [];

  const minAsianWidth = config.smc?.asianRangeMinPips ?? 5;
  // A range still being built contains the current price, so it can't be "raided" yet.
  const asianUsable = asian?.complete && toPips(asian.high - asian.low) >= minAsianWidth;
  const poolDefs = {
    asian: asianUsable ? { name: "asian", high: asian.high, low: asian.low } : null,
    pd: pdh != null || pdl != null ? { name: "pd", high: pdh, low: pdl } : null,
    pw: pwh != null || pwl != null ? { name: "pw", high: pwh, low: pwl } : null,
    pm: pmh != null || pml != null ? { name: "pm", high: pmh, low: pml } : null,
  };
  const eqPools = profile.pools.includes("eq")
    ? equal.map((e) => (e.kind === "eqh" ? { name: `eqh_${e.tf}`, high: e.price } : { name: `eql_${e.tf}`, low: e.price }))
    : [];
  const pools = [...profile.pools.map((p) => poolDefs[p]).filter(Boolean), ...eqPools];
  const sweepCandles = candles ? candles[profile.sweep.key].slice(-profile.sweep.bars) : [];
  const liquidity = detectLiquidityEvents(price, pools, sweepCandles);

  const htfEntries = profile.htf.map((tf) => [tf, tv[tf]]);
  const htfTrends = htfEntries.map(([, a]) => a?.market_structure?.trend || "unknown");
  const swing = candles ? swingRange(candles[profile.swing.key], profile.swing.lookback) : null;
  const structure = {
    ...inferStructureBias(htfEntries),
    ltf_bos: candles ? detectBos(candles[profile.bos.key]) : null,
  };
  const swingTrend = tv[profile.swing.tf]?.market_structure?.trend;
  const fib = computeFibOte(swing, swingTrend || structure.bias, price);
  const trigger = candles ? ltfTriggerState(withLiveBar(candles[profile.trigger.key], tv[profile.trigger.tf], profile.trigger.tf, nowMs), pools) : null;
  const refine = refineState(candles, profile, pools);
  const orderBlocks = candles
    ? { ...findOrderBlocks(candles[profile.ob.key]), wick_rejection: wickRejection(candles[profile.wick.key]) }
    : null;

  const context = {
    mode: mode.id,
    profile: {
      swing_tf: profile.swing.tf,
      bos_tf: profile.bos.tf,
      ob_tf: profile.ob.tf,
      wick_tf: profile.wick.tf,
      rsi_tf: profile.rsiTf,
      trigger_tf: profile.trigger.tf,
      refine_tf: refine ? profile.refine.tf : null,
      killzone_gate: profile.killzoneGate,
    },
    wib: wib.label,
    amd_phase: amdPhase,
    amd_description: describeAMDPhase(amdPhase),
    trading_windows: describeTradingWindowsWib(now),
    trading_window: isSMCTradingWindow(now),
    london_open: isLondonOpenWindow(now),
    ny_open: isNewYorkOpenWindow(now),
    price,
    data: {
      feed: config.market.feedLabel,
      candles: Boolean(candles),
      candle_source: candles?.source ?? null,
      basis: candles?.basis ?? null,
      candle_error: candleError,
    },
    asian_range: profile.pools.includes("asian") ? asian : null,
    pdh,
    pdl,
    pwh,
    pwl,
    pmh,
    pml,
    hod,
    lod,
    equal_levels: equal,
    htf: Object.fromEntries(htfEntries.map(([tf], i) => [tf, htfTrends[i]])),
    ltf: { rsi: extractRsi(tv[profile.rsiTf]?.rsi), rsi_tf: profile.rsiTf },
    structure,
    swing,
    fib,
    order_blocks: orderBlocks,
    trigger,
    refine,
    liquidity_events: liquidity.events,
    liquidity_hints: liquidity.hints,
    suggested_setups: suggestPlaybooks(liquidity.events, amdPhase, structure.ltf_bos),
    min_confluence: config.smc?.minConfluence ?? 2,
    reach_pips: reach,
  };

  if (config.mtfZones?.enabled !== false) {
    context.mtf_zones = buildMtfZoneStack({
      candles,
      pivots: tv[profile.tvTfs[0]]?.support_resistance,
      price,
      extras: { pdh, pdl, pwh, pwl, pmh, pml, hod, lod, equal, asian: asianUsable && profile.pools.includes("asian") ? asian : null },
      htfTrends: htfTrends.slice(0, 2),
      timeframes: profile.zones,
      mergePips: profile.mergePips,
      reachPips: reach,
      proximityPips: profile.proximityPips,
    });
    context.ltf.nearest_support = context.mtf_zones.nearestSupport?.price ?? null;
    context.ltf.nearest_resistance = context.mtf_zones.nearestResistance?.price ?? null;
  }

  log("smc", `Context [${mode.id}${profileId ? `/${profileId} view` : ""}] ${wib.label} ${amdPhase} price=${price} candles=${candles?.source ?? "none"}${candles?.m1 ? "+1m" : ""} basis=${candles?.basis ?? "?"} events=${liquidity.events.join(",") || "none"}`);
  if (store) _lastSMCContext = context;
  return context;
}

function formatTradingWindowLine(ctx) {
  if (!ctx.profile.killzone_gate) return `Killzones (${ctx.trading_windows}): informational only in ${ctx.mode} mode`;
  if (config.smc?.requireTradingWindow === false) {
    return ctx.trading_window
      ? `Killzone (${ctx.trading_windows}): ACTIVE — window gate OFF`
      : `Killzone (${ctx.trading_windows}): not active — window gate OFF, SETUP still allowed if confluence + entry rules met`;
  }
  return ctx.trading_window
    ? `Killzone (${ctx.trading_windows}): YES — preferred entry time`
    : `Killzone (${ctx.trading_windows}): NO — only turtle_soup_* / sh_bms_rto after a liquidity raid are accepted now`;
}

const fmt = (v) => (v == null ? "?" : Number(v).toFixed(2));

/** "4221.13 (+650p, context only)" — distance from price, flagged when beyond the mode's reach. */
function lvl(ctx, v) {
  if (v == null) return "?";
  if (ctx.price == null) return fmt(v);
  const d = toPips(v - ctx.price);
  const far = ctx.reach_pips != null && Math.abs(d) > ctx.reach_pips;
  return `${fmt(v)} (${d >= 0 ? "+" : ""}${d}p${far ? ", context only" : ""})`;
}

const TF_MS = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

/**
 * Yahoo candles lag ~10 min and end with a partial bar at an odd timestamp. Drop that,
 * and append TradingView's live bar for the trigger TF (spot, real time) so the most
 * recent sweep/BMS is visible. Bars between Yahoo's last and the live one may be missing.
 */
export function withLiveBar(candles, tvAnalysis, tf, nowMs) {
  const ms = TF_MS[tf];
  if (!ms || !candles?.length) return candles;
  const closed = candles.filter((k) => k.t % ms === 0);
  const pd = tvAnalysis?.price_data;
  const live = pd && [pd.open, pd.high, pd.low, pd.close].every((v) => Number.isFinite(Number(v)))
    ? { t: Math.floor(nowMs / ms) * ms, o: Number(pd.open), h: Number(pd.high), l: Number(pd.low), c: Number(pd.close), live: true }
    : null;
  if (!live) return closed;
  return [...closed.filter((k) => k.t < live.t), live];
}

/** Entry refinement TF (1m for scalp): the BMS inside the trigger-TF OB that times the entry. */
export function refineState(candles, profile, pools = []) {
  if (!profile.refine || config.screening?.entryRefine === false) return null;
  const bars = candles?.[profile.refine.key];
  if (!bars?.length) return null;
  return ltfTriggerState(bars, pools, { lookback: 60, tapeBars: 10, sweepBars: 15 });
}

const wibClock = (ms) => new Date(ms + 7 * 3_600_000).toISOString().slice(11, 16);

/** Entry-TF trigger block: lets the model verify sweep → BMS → RTO instead of guessing. */
function formatTrigger(ctx) {
  const t = ctx.trigger;
  const tf = ctx.profile.trigger_tf;
  const out = ["", `── ${tf} TRIGGER DATA (closed + live bar; use this to confirm sweep → BMS → RTO) ──`];
  out.push(`${tf} swing highs: ${t.swing_highs.map((s) => `${fmt(s.price)} (${s.bars_ago} bars ago)`).join(", ") || "none"}`);
  out.push(`${tf} swing lows:  ${t.swing_lows.map((s) => `${fmt(s.price)} (${s.bars_ago} bars ago)`).join(", ") || "none"}`);
  out.push(t.sweeps.length
    ? `${tf} sweeps: ${t.sweeps.map((s) => `${s.side.toUpperCase()} ${s.pool} (wick ${fmt(s.wick)}, ${s.bars_ago} bars ago)`).join("; ")}`
    : `${tf} sweeps: none in the last bars`);
  if (t.bms) {
    out.push(`${tf} BMS: ${t.bms.dir.toUpperCase()} — close ${fmt(t.bms.close)} through swing ${fmt(t.bms.level)}, ${t.bms.bars_ago} bars ago`);
    if (t.ob) out.push(`${tf} OB that caused it: ${fmt(t.ob.low)}–${fmt(t.ob.high)} | RTO: ${t.rto}`);
  } else {
    out.push(`${tf} BMS: none yet in the window`);
  }
  out.push(ctx.data.candle_source === "twelvedata"
    ? `Last ${t.tape.length} ${tf} bars (WIB open, O/H/L/C), oldest → newest — the final bar is LIVE and still forming:`
    : `Last ${t.tape.length} ${tf} bars (WIB open, O/H/L/C), oldest → newest — history is ~10 min delayed, the final bar is LIVE from TradingView (a gap before it means bars not yet published):`);
  for (const k of t.tape) out.push(`  ${wibClock(k.t)} ${fmt(k.o)} ${fmt(k.h)} ${fmt(k.l)} ${fmt(k.c)}${k.live ? "  ← live, still forming" : ""}`);
  out.push(ctx.refine
    ? `Sweep + ${tf} BMS in the reversal direction shown above = setup ARMED. Entry is timed on ${ctx.profile.refine_tf} (block below) — do not demand any other confirmation.`
    : `Sweep + ${tf} BMS in the reversal direction shown above = trigger COMPLETE → limit at the OB listed. Do not demand a confirmation that is already printed above, and do not wait for a different level.`);
  return out;
}

/** 1m entry block: after the 5m trigger, entry = price back in the 5m OB + a 1m BMS the trade's way. */
function formatRefine(ctx) {
  const r = ctx.refine;
  const tf = ctx.profile.refine_tf;
  const ttf = ctx.profile.trigger_tf;
  const out = ["", `── ${tf} ENTRY REFINEMENT (real time; the last bar is still forming) ──`];
  out.push(`${tf} swing highs: ${r.swing_highs.map((x) => `${fmt(x.price)} (${x.bars_ago} bars ago)`).join(", ") || "none"}`);
  out.push(`${tf} swing lows:  ${r.swing_lows.map((x) => `${fmt(x.price)} (${x.bars_ago} bars ago)`).join(", ") || "none"}`);
  if (r.bms) {
    out.push(`${tf} BMS: ${r.bms.dir.toUpperCase()} — close ${fmt(r.bms.close)} through ${fmt(r.bms.level)}, ${r.bms.bars_ago} bars ago`);
    if (r.ob) out.push(`${tf} OB that caused it: ${fmt(r.ob.low)}–${fmt(r.ob.high)} | RTO: ${r.rto}`);
  } else {
    out.push(`${tf} BMS: none in the window`);
  }
  out.push(`Last ${r.tape.length} ${tf} bars (WIB, O/H/L/C): ${r.tape.map((k) => `${wibClock(k.t)} ${fmt(k.o)}/${fmt(k.h)}/${fmt(k.l)}/${fmt(k.c)}`).join(" · ")}`);
  out.push(`ENTRY RULE for sh_bms_rto / sms_bms_rto / bms_rto_ote / amd_distribution: (1) the ${ttf} trigger is complete, (2) price came back into the ${ttf} OB (RTO "touched"), (3) a ${tf} BMS the TRADE's way printed ≤5 bars ago → SETUP now: market at price, or limit at the ${tf} OB when price already left it. SL beyond the ${tf} swing that made the BMS or the sweep extreme, whichever is structural (min SL still applies). Missing (2) or (3) → WATCH naming it. propose_setup checks all three on the candles.`);
  return out;
}

export function formatSMCForPrompt(ctx) {
  if (!ctx) return "SMC disabled.";
  const lines = [
    "── SMC / MARKET STRUCTURE ──",
    `Mode: ${ctx.mode} | WIB: ${ctx.wib} | Phase: ${ctx.amd_phase}`,
    ctx.amd_description,
    formatTradingWindowLine(ctx),
    `Price (${ctx.data.feed}): ${ctx.price ?? "?"}`,
  ];

  if (!ctx.data.candles) {
    lines.push(`⚠ CANDLE HISTORY UNAVAILABLE (${ctx.data.candle_error || "no price"}) — PDH/PDL, Asian range, swings, fib and OBs are missing. Prefer WATCH.`);
  } else {
    lines.push(ctx.data.candle_source === "twelvedata"
      ? `Levels from Twelve Data XAU/USD spot candles (real time, offset ${ctx.data.basis} to ${ctx.data.feed}).`
      : `Levels from Yahoo ${config.market.yahooSymbol} candles shifted by basis ${ctx.data.basis} onto spot (history ~10 min delayed).`);
  }

  if (ctx.asian_range) {
    const a = ctx.asian_range;
    lines.push(`Asian range ${a.date}${a.complete ? "" : " (building)"}: low ${lvl(ctx, a.low)} – high ${lvl(ctx, a.high)}`);
  }
  if (ctx.reach_pips != null) {
    lines.push(`Trade reach for ${ctx.mode}: ±${ctx.reach_pips}p. Levels marked "context only" are liquidity/bias references — never entries, SL anchors or TP targets.`);
  }
  if (ctx.pdh != null) lines.push(`PDH ${lvl(ctx, ctx.pdh)} | PDL ${lvl(ctx, ctx.pdl)}`);
  if (ctx.pwh != null) lines.push(`PWH ${lvl(ctx, ctx.pwh)} | PWL ${lvl(ctx, ctx.pwl)}`);
  if (ctx.pmh != null) lines.push(`PMH ${lvl(ctx, ctx.pmh)} | PML ${lvl(ctx, ctx.pml)}`);
  if (ctx.hod != null) lines.push(`Today HOD ${lvl(ctx, ctx.hod)} | LOD ${lvl(ctx, ctx.lod)}`);
  const byDistance = (ctx.equal_levels || []).slice().sort((x, y) => Math.abs(x.price - ctx.price) - Math.abs(y.price - ctx.price));
  for (const e of byDistance.slice(0, 4)) {
    lines.push(`Equal ${e.kind === "eqh" ? "highs (BSL)" : "lows (SSL)"} ${e.tf}: ${lvl(ctx, e.price)} ×${e.touches}`);
  }
  if (ctx.swing) lines.push(`${ctx.profile.swing_tf} swing (${ctx.swing.source}): low ${lvl(ctx, ctx.swing.swing_low)} – high ${lvl(ctx, ctx.swing.swing_high)}`);
  if (ctx.fib) {
    const lv = ctx.fib.levels;
    lines.push(`Fib retrace (${ctx.fib.trend_for_fib}): ${["0.382", "0.5", "0.618", "0.786"].map((k) => `${k}=${fmt(lv[k])}`).join(" | ")}`);
    lines.push(`OTE 0.618–0.72: ${fmt(ctx.fib.ote_zone.low)} – ${fmt(ctx.fib.ote_zone.high)} | in zone: ${ctx.fib.in_ote_zone ? "YES" : `no (${ctx.fib.dist_to_ote_pips}p away)`}`);
  }

  const s = ctx.structure;
  const bos = s.ltf_bos;
  lines.push(`Structure: ${s.bias}${s.bms_hint ? ` | ${s.bms_hint}` : ""}${bos?.bos ? ` | ${ctx.profile.bos_tf} ${bos.bos} (close ${fmt(bos.close)} vs swing H ${fmt(bos.last_swing_high)} / L ${fmt(bos.last_swing_low)})` : ""}`);
  if (ctx.order_blocks) {
    const ob = ctx.order_blocks;
    const zone = (z) => (z ? `${fmt(z.low)}–${lvl(ctx, z.high)}` : "none");
    lines.push(`${ctx.profile.ob_tf} OB — bullish: ${zone(ob.bullish)} | bearish: ${zone(ob.bearish)}${ob.wick_rejection ? ` | last ${ctx.profile.wick_tf}: ${ob.wick_rejection}` : ""}`);
  }
  lines.push(`Trend ${Object.entries(ctx.htf).map(([tf, t]) => `${tf}: ${t}`).join(" | ")} | RSI ${ctx.ltf.rsi_tf} ${ctx.ltf.rsi ?? "?"}`);

  if (ctx.trigger) lines.push(...formatTrigger(ctx));
  if (ctx.trigger && ctx.refine) lines.push(...formatRefine(ctx));

  if (ctx.liquidity_events.length) {
    lines.push(`Liquidity: ${ctx.liquidity_events.join(", ")} — include liquidity_sweep in confluence for turtle soup`);
  }
  for (const h of ctx.liquidity_hints.slice(0, 4)) lines.push(`  → ${h}`);

  lines.push("", "FRAMEWORK — HTF key level first, LTF trigger second (mirror for shorts):");
  lines.push("  1 HTF bias + key levels: order blocks, liquidity pools (PDH/PDL, PWH/PWL, PMH/PML, Asian H/L, EQH/EQL, HOD/LOD), plan POIs.");
  lines.push("  2 Wait for price AT a key level — ideally in the London/NY killzone or around a high-impact release.");
  lines.push("  3 Trigger (exactly one setup_type):");
  lines.push("    turtle_soup_long/short — pool swept (wick beyond SSL/BSL) and price back inside → enter against the sweep; SL beyond the sweep extreme.");
  lines.push("    sh_bms_rto — stop hunt, then LTF break in market structure confirming it, then return to the OB that caused the BMS; SL beyond that OB/sweep; TP1 = the BMS swing (opposite liquidity).");
  lines.push("    sms_bms_rto — failure swing (no new high/low), then BMS, then return to the OB; same SL/TP logic.");
  lines.push("    bms_rto_ote — after a BMS, trade WITH it on the retrace into 50%/OTE (0.618–0.72) or the OB; SL beyond the swing origin.");
  lines.push("    amd_distribution — Asian range accumulation, London/NY false move beyond it (manipulation), entry back the other way on RTO.");
  lines.push("  4 Trigger not complete yet → WATCH and name the level + the trigger you are waiting for.");
  lines.push(`  Confluence ≥${ctx.min_confluence}: htf_bias, htf_key_level, mtf_sr_zone, liquidity_sweep, bms, order_block_rto, fib_ote, asian_range, session_amd, london_open, ny_open, high_impact_news, plan_poi.`);

  if (ctx.mtf_zones) lines.push(formatMtfZonesForPrompt(ctx.mtf_zones));

  lines.push("", "YOU set SL/TP from structure — not from config defaults.");
  lines.push("- SL: beyond the sweep extreme / order block that invalidates the setup");
  lines.push(`- TP: the opposite liquidity / BMS swing first, then the next pool${ctx.reach_pips != null ? ` — all within ${ctx.reach_pips}p` : ""}`);
  lines.push(`- Suggested plays: ${ctx.suggested_setups.length ? ctx.suggested_setups.join(", ") : "none — WATCH"}`);

  return lines.join("\n");
}

export function validateSMCSetup(args, ctx = null) {
  if (config.smc?.enabled === false) return { ok: true };

  const setupType = args.setup_type;
  const confluence = Array.isArray(args.confluence_factors) ? args.confluence_factors : [];
  const minConf = config.smc?.minConfluence ?? 2;

  if (!setupType || !SETUP_TYPES.includes(setupType)) {
    return { ok: false, reason: "invalid_setup_type", message: `setup_type required. Use: ${SETUP_TYPES.join(", ")}` };
  }

  const validTags = [...new Set(confluence.filter((c) => CONFLUENCE_TAGS.includes(c)))];
  if (validTags.length < minConf) {
    return {
      ok: false,
      reason: "insufficient_confluence",
      message: `Need ≥${minConf} confluence_factors (have ${validTags.length}: ${validTags.join(", ") || "none"})`,
    };
  }

  const raids = sideOfLiquidity(ctx?.liquidity_events);

  if (config.smc?.requireTradingWindow && ctx?.profile?.killzone_gate && !ctx.trading_window) {
    const allowedOffHours = ["turtle_soup_long", "turtle_soup_short", "sh_bms_rto"].includes(setupType)
      && (raids.ssl || raids.bsl);
    if (!allowedOffHours) {
      return { ok: false, reason: "outside_trading_window", message: `Outside killzones (${ctx.trading_windows}) — WATCH unless turtle soup / SH+BMS+RTO after a liquidity raid` };
    }
  }

  if (config.smc?.blockTrendFollowAtLiquidity !== false) {
    if (raids.ssl && !raids.bsl && args.side === "short") {
      return { ok: false, reason: "ssl_swept_no_short", message: "Sell-side liquidity just taken — do not short into it; favor turtle_soup_long / sh_bms_rto long / WATCH" };
    }
    if (raids.bsl && !raids.ssl && args.side === "long") {
      return { ok: false, reason: "bsl_swept_no_long", message: "Buy-side liquidity just taken — do not chase long; favor turtle_soup_short / sh_bms_rto short / WATCH" };
    }
  }

  return { ok: true, confluence: validTags, setup_type: setupType };
}
