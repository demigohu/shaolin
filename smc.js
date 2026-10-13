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
} from "./smc-sessions.js";
import { getActiveMode } from "./modes.js";
import {
  asianRange,
  previousDayHL,
  previousWeekHL,
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

export const SETUP_TYPES = [
  "dip_reclaim_long",   // DIP → structure intact → absorption → reclaim → long
  "dip_reclaim_short",  // Rally → structure intact → distribution → reclaim → short
  "fib_retrace",        // Entry at fib SNR (0.5–0.786) after impulse
  "snr_bounce_long",    // Demand at MTF support + confirmation
  "snr_bounce_short",   // Supply at MTF resistance + confirmation
  "turtle_soup_long",   // SSL raid / false break (PDF)
  "turtle_soup_short",  // BSL raid / false break (PDF)
  "sh_bms_rto",
  "sms_bms_rto",
  "amd_distribution",
];

export const CONFLUENCE_TAGS = [
  "htf_bias",
  "ltf_structure",
  "snr_zone",
  "fib_retrace",
  "absorption",
  "reclaim",
  "liquidity_sweep",
  "order_block_rto",
  "fib_ote",
  "london_open",
  "ny_open",
  "asian_range",
  "session_amd",
  "news_catalyst",
  "mtf_sr_zone",
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

function suggestPlaybooks(liquidityEvents, amdPhase, trend) {
  const plays = [];
  const { ssl, bsl } = sideOfLiquidity(liquidityEvents);
  if (ssl) plays.push("turtle_soup_long", "sh_bms_rto");
  if (bsl) plays.push("turtle_soup_short", "sms_bms_rto");
  if (amdPhase === "ny_distribution" || amdPhase === "london_manipulation") plays.push("amd_distribution");
  if (trend === "Bullish" || trend === "Bearish") plays.push("fib_retrace");
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
    wick: { key: "m5", tf: "5m" }, sweep: { key: "m15", bars: 8 },
    zones: ["4h", "1h", "15m", "5m"], mergePips: 8, proximityPips: 5,
    pools: ["asian", "pd"], killzoneGate: true,
  },
  day: {
    tvTfs: ["15m", "1h", "4h", "1D"], htf: ["1D", "4h", "1h"], rsiTf: "1h",
    swing: { key: "h4", tf: "4h", lookback: 30 }, bos: { key: "h1", tf: "1h" }, ob: { key: "h1", tf: "1h" },
    wick: { key: "m15", tf: "15m" }, sweep: { key: "h1", bars: 6 },
    zones: ["1d", "4h", "1h", "15m"], mergePips: 15, proximityPips: 10,
    pools: ["asian", "pd", "pw"], killzoneGate: true,
  },
  swing: {
    tvTfs: ["1h", "4h", "1D", "1W"], htf: ["1W", "1D", "4h"], rsiTf: "4h",
    swing: { key: "d1", tf: "1D", lookback: 40 }, bos: { key: "h4", tf: "4h" }, ob: { key: "h4", tf: "4h" },
    wick: { key: "h1", tf: "1h" }, sweep: { key: "h4", bars: 6 },
    zones: ["1w", "1d", "4h", "1h"], mergePips: 40, proximityPips: 25,
    pools: ["pd", "pw"], killzoneGate: false,
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

export async function buildSMCContext() {
  const mode = getActiveMode();
  const profile = getStructureProfile(mode);

  // Sequential (cached) TF fetches — parallel bursts trigger TradingView failure cooldowns.
  const tv = {};
  for (const tf of profile.tvTfs) tv[tf] = await fetchAnalysis(tf);

  let price = null;
  for (const tf of profile.tvTfs) {
    price = extractPriceFromAnalysis(tv[tf]);
    if (price != null) break;
  }

  let candles = null;
  let candleError = null;
  try {
    candles = await getSpotCandleSet(price);
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

  const minAsianWidth = config.smc?.asianRangeMinPips ?? 5;
  // A range still being built contains the current price, so it can't be "raided" yet.
  const asianUsable = asian?.complete && toPips(asian.high - asian.low) >= minAsianWidth;
  const poolDefs = {
    asian: asianUsable ? { name: "asian", high: asian.high, low: asian.low } : null,
    pd: pdh != null || pdl != null ? { name: "pd", high: pdh, low: pdl } : null,
    pw: pwh != null || pwl != null ? { name: "pw", high: pwh, low: pwl } : null,
  };
  const pools = profile.pools.map((p) => poolDefs[p]).filter(Boolean);
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
      basis: candles?.basis ?? null,
      candle_error: candleError,
    },
    asian_range: profile.pools.includes("asian") ? asian : null,
    pdh,
    pdl,
    pwh,
    pwl,
    htf: Object.fromEntries(htfEntries.map(([tf], i) => [tf, htfTrends[i]])),
    ltf: { rsi: extractRsi(tv[profile.rsiTf]?.rsi), rsi_tf: profile.rsiTf },
    structure,
    swing,
    fib,
    order_blocks: orderBlocks,
    liquidity_events: liquidity.events,
    liquidity_hints: liquidity.hints,
    suggested_setups: suggestPlaybooks(liquidity.events, amdPhase, swingTrend),
    min_confluence: config.smc?.minConfluence ?? 2,
  };

  if (config.mtfZones?.enabled !== false) {
    context.mtf_zones = buildMtfZoneStack({
      candles,
      pivots: tv[profile.tvTfs[0]]?.support_resistance,
      price,
      extras: { pdh, pdl, pwh, pwl, asian: asianUsable && profile.pools.includes("asian") ? asian : null },
      htfTrends: htfTrends.slice(0, 2),
      timeframes: profile.zones,
      mergePips: profile.mergePips,
      proximityPips: profile.proximityPips,
    });
    context.ltf.nearest_support = context.mtf_zones.nearestSupport?.price ?? null;
    context.ltf.nearest_resistance = context.mtf_zones.nearestResistance?.price ?? null;
  }

  log("smc", `Context [${mode.id}] ${wib.label} ${amdPhase} price=${price} basis=${candles?.basis ?? "?"} events=${liquidity.events.join(",") || "none"}`);
  _lastSMCContext = context;
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
    : `Killzone (${ctx.trading_windows}): NO — only turtle_soup_* / dip_reclaim_* after a liquidity raid are accepted now`;
}

const fmt = (v) => (v == null ? "?" : Number(v).toFixed(2));

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
    lines.push(`Levels from Yahoo ${config.market.yahooSymbol} candles shifted by basis ${ctx.data.basis} onto spot.`);
  }

  if (ctx.asian_range) {
    const a = ctx.asian_range;
    lines.push(`Asian range ${a.date}${a.complete ? "" : " (building)"}: ${fmt(a.low)} – ${fmt(a.high)} (${toPips(a.high - a.low)}p)`);
  }
  if (ctx.pdh != null) lines.push(`PDH ${fmt(ctx.pdh)} | PDL ${fmt(ctx.pdl)} | PWH ${fmt(ctx.pwh)} | PWL ${fmt(ctx.pwl)}`);
  if (ctx.swing) lines.push(`${ctx.profile.swing_tf} swing (${ctx.swing.source}): low ${fmt(ctx.swing.swing_low)} – high ${fmt(ctx.swing.swing_high)}`);
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
    const zone = (z) => (z ? `${fmt(z.low)}–${fmt(z.high)}` : "none");
    lines.push(`${ctx.profile.ob_tf} OB — bullish: ${zone(ob.bullish)} | bearish: ${zone(ob.bearish)}${ob.wick_rejection ? ` | last ${ctx.profile.wick_tf}: ${ob.wick_rejection}` : ""}`);
  }
  lines.push(`Trend ${Object.entries(ctx.htf).map(([tf, t]) => `${tf}: ${t}`).join(" | ")} | RSI ${ctx.ltf.rsi_tf} ${ctx.ltf.rsi ?? "?"}`);

  if (ctx.liquidity_events.length) {
    lines.push(`Liquidity: ${ctx.liquidity_events.join(", ")} — include liquidity_sweep in confluence for turtle soup`);
  }
  for (const h of ctx.liquidity_hints.slice(0, 4)) lines.push(`  → ${h}`);

  lines.push("", "DIP → ENTRY checklist (long; mirror for short):");
  lines.push("  1 DIP — pullback in HTF trend (not random noise)");
  lines.push("  2 STRUCTURE — HTF intact (no BOS against your bias)");
  lines.push("  3 ABSORPTION — wick/OB/RSI stall at SNR or fib (smart money in)");
  lines.push("  4 RECLAIM — close back above/below key level (failed breakdown/breakout)");
  lines.push("  5 ENTRY — market at reclaim or limit at fib 0.5–0.786 / SNR");

  lines.push("", "SETUP TYPES (you choose — cite in propose_setup):");
  lines.push("  dip_reclaim_long | dip_reclaim_short — core DIP framework");
  lines.push("  fib_retrace | snr_bounce_long | snr_bounce_short — SNR + fib entry");
  lines.push("  turtle_soup_long | turtle_soup_short — liquidity false break");
  lines.push("  sh_bms_rto | sms_bms_rto | amd_distribution — break of structure + return to OB / session distribution");

  if (ctx.mtf_zones) lines.push(formatMtfZonesForPrompt(ctx.mtf_zones));

  lines.push("", "YOU set SL/TP from SNR + fib — not from config defaults.");
  lines.push("- SL: beyond invalidation (below demand / above supply you cite)");
  lines.push("- TP: next SNR levels or fib extension — provide tp_levels[] on propose_setup");
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
    const allowedOffHours = ["turtle_soup_long", "turtle_soup_short", "dip_reclaim_long", "dip_reclaim_short"].includes(setupType)
      && (raids.ssl || raids.bsl);
    if (!allowedOffHours) {
      return { ok: false, reason: "outside_trading_window", message: `Outside killzones (${ctx.trading_windows}) — WATCH unless turtle soup / dip reclaim after a liquidity raid` };
    }
  }

  if (config.smc?.blockTrendFollowAtLiquidity !== false) {
    if (raids.ssl && !raids.bsl && args.side === "short") {
      return { ok: false, reason: "ssl_swept_no_short", message: "Sell-side liquidity just taken — do not short into it; favor turtle_soup_long / RTO long / WATCH" };
    }
    if (raids.bsl && !raids.ssl && args.side === "long") {
      return { ok: false, reason: "bsl_swept_no_long", message: "Buy-side liquidity just taken — do not chase long; favor turtle_soup_short / RTO short / WATCH" };
    }
  }

  return { ok: true, confluence: validTags, setup_type: setupType };
}
