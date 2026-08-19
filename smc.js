/**
 * Smart Money / Market Structure framework (PDF: Market Structure and Powerful Setups).
 * Session AMD, liquidity sweeps, confluence gating, setup types.
 */

import { config } from "./config.js";
import { callMcpTool } from "./tools/mcp-client.js";
import { extractPriceFromAnalysis } from "./tools/market.js";
import { toPips } from "./tools/price.js";
import { log } from "./logger.js";
import {
  getAMDPhase,
  getWIBNow,
  describeAMDPhase,
  isSMCTradingWindow,
  isLondonOpenWindow,
  isNewYorkOpenWindow,
} from "./smc-sessions.js";
import { getAsianRange, updateAsianRange } from "./smc-state.js";
import {
  inferSwingRange,
  computeFibOte,
  inferStructureBias,
  inferOrderBlockZones,
  bootstrapAsianRangeProxy,
} from "./smc-analysis.js";

let _lastSMCContext = null;

export function getLastSMCContext() {
  return _lastSMCContext;
}

export const SETUP_TYPES = [
  "turtle_soup_long",   // SSL raid → long
  "turtle_soup_short",  // BSL raid → short
  "sh_bms_rto",         // Stop hunt + BMS + return to OB
  "sms_bms_rto",        // Failure swing + BMS + RTO
  "amd_distribution",   // Post-manipulation distribution leg
  "fib_retrace",        // BMS + 50–72% fib retrace entry
];

export const CONFLUENCE_TAGS = [
  "htf_bias",
  "ltf_structure",
  "liquidity_sweep",
  "order_block_rto",
  "fib_ote",
  "london_open",
  "ny_open",
  "asian_range",
  "session_amd",
  "news_catalyst",
];

async function fetchTf(tf) {
  try {
    return await callMcpTool("coin_analysis", {
      symbol: config.market.dataSymbol,
      exchange: config.market.dataExchange,
      timeframe: tf,
    });
  } catch (error) {
    return { error: error.message, timeframe: tf };
  }
}

function readStructure(analysis) {
  if (!analysis || analysis.error) return null;
  return analysis.market_structure || null;
}

function readSR(analysis) {
  if (!analysis || analysis.error) return null;
  return analysis.support_resistance || null;
}

function readDailyHL(analysis) {
  const pd = analysis?.price_data;
  if (!pd) return { pdh: null, pdl: null };
  return {
    pdh: pd.high ?? null,
    pdl: pd.low ?? null,
  };
}

function detectLiquidityEvents(price, asian, daily) {
  const pip = config.broker.pipSize || 0.1;
  const events = [];
  const hints = [];

  if (asian && price != null) {
    const aboveAsian = price > asian.high;
    const belowAsian = price < asian.low;
    const distHighPips = toPips(Math.abs(price - asian.high));
    const distLowPips = toPips(Math.abs(price - asian.low));

    if (aboveAsian) {
      events.push("bsl_raid_asian_high");
      hints.push("BSL raid above Asian high — favor Turtle Soup SHORT or wait for RTO after BMS down");
    } else if (distHighPips <= 5) {
      hints.push("Price near Asian high (BSL pool) — watch for sweep");
    }

    if (belowAsian) {
      events.push("ssl_raid_asian_low");
      hints.push("SSL raid below Asian low — favor Turtle Soup LONG or wait for RTO after BMS up");
    } else if (distLowPips <= 5) {
      hints.push("Price near Asian low (SSL pool) — watch for sweep");
    }
  }

  if (price != null && daily?.pdh != null && price > daily.pdh) {
    events.push("bsl_raid_pdh");
    hints.push("Above PDH — BSL taken, reversal down possible");
  }
  if (price != null && daily?.pdl != null && price < daily.pdl) {
    events.push("ssl_raid_pdl");
    hints.push("Below PDL — SSL taken, reversal up possible");
  }

  return { events, hints };
}

function suggestPlaybooks(liquidityEvents, amdPhase, h1Trend) {
  const plays = [];
  if (liquidityEvents.includes("ssl_raid_asian_low") || liquidityEvents.includes("ssl_raid_pdl")) {
    plays.push("turtle_soup_long", "sh_bms_rto", "sms_bms_rto");
  }
  if (liquidityEvents.includes("bsl_raid_asian_high") || liquidityEvents.includes("bsl_raid_pdh")) {
    plays.push("turtle_soup_short", "sh_bms_rto", "sms_bms_rto");
  }
  if (amdPhase === "ny_distribution" || amdPhase === "london_manipulation") {
    plays.push("amd_distribution", "fib_retrace");
  }
  if (h1Trend === "Bullish") plays.push("fib_retrace");
  if (h1Trend === "Bearish") plays.push("fib_retrace");
  return [...new Set(plays)];
}

export async function buildSMCContext({ updateRange = true } = {}) {
  // Warm up MCP session before parallel fetches (avoids "before initialization" race).
  const m5 = await fetchTf("5m");
  const [daily, h4, h1, m15] = await Promise.all([
    fetchTf("1D"),
    fetchTf("4h"),
    fetchTf("1h"),
    fetchTf("15m"),
  ]);

  const price = extractPriceFromAnalysis(m5)
    ?? extractPriceFromAnalysis(m15)
    ?? extractPriceFromAnalysis(h1)
    ?? extractPriceFromAnalysis(daily);
  if (updateRange && price != null) updateAsianRange(price);

  let asian = getAsianRange();
  if (!asian && config.smc?.bootstrapAsianRange !== false) {
    asian = bootstrapAsianRangeProxy(h1, m15);
  }

  const dailyHL = readDailyHL(daily);
  const amdPhase = getAMDPhase();
  const wib = getWIBNow();
  const liquidity = detectLiquidityEvents(price, asian, dailyHL);
  const h4Struct = readStructure(h4);
  const h1Struct = readStructure(h1);
  const m15SR = readSR(m15);
  const swing = inferSwingRange(h1, m15);
  const structure = inferStructureBias(h4, h1, m15);
  const fib = computeFibOte(swing, h1Struct?.trend || structure.bias, price);
  const orderBlocks = inferOrderBlockZones(m15, m5);

  const context = {
    wib: wib.label,
    amd_phase: amdPhase,
    amd_description: describeAMDPhase(amdPhase),
    trading_window: isSMCTradingWindow(),
    london_open: isLondonOpenWindow(),
    ny_open: isNewYorkOpenWindow(),
    price,
    asian_range: asian,
    pdh: dailyHL.pdh,
    pdl: dailyHL.pdl,
    htf: {
      h4_trend: h4Struct?.trend || "unknown",
      h1_trend: h1Struct?.trend || "unknown",
      h4_strength: h4Struct?.trend_strength,
      h1_strength: h1Struct?.trend_strength,
    },
    ltf: {
      m15_rsi: m15?.rsi,
      m5_rsi: m5?.rsi,
      nearest_support: m15SR?.nearest_support,
      nearest_resistance: m15SR?.nearest_resistance,
    },
    structure,
    swing,
    fib,
    order_blocks: orderBlocks,
    liquidity_events: liquidity.events,
    liquidity_hints: liquidity.hints,
    suggested_setups: suggestPlaybooks(liquidity.events, amdPhase, h1Struct?.trend),
    min_confluence: config.smc?.minConfluence ?? 2,
  };

  log("smc", `Context ${wib.label} ${amdPhase} price=${price} events=${liquidity.events.join(",") || "none"}`);
  _lastSMCContext = context;
  return context;
}

export function formatSMCForPrompt(ctx) {
  if (!ctx) return "SMC disabled.";
  const lines = [
    "── SMC / MARKET STRUCTURE (PDF framework) ──",
    `WIB: ${ctx.wib} | Phase: ${ctx.amd_phase}`,
    ctx.amd_description,
    `Trading window (London/NY open): ${ctx.trading_window ? "YES — preferred entry time" : "NO — prefer WATCH unless clear AMD play"}`,
    `Price: ${ctx.price ?? "?"}`,
  ];

  if (ctx.asian_range) {
    const proxy = ctx.asian_range.proxy ? " (proxy)" : "";
    lines.push(`Asian range${proxy}: ${ctx.asian_range.low} – ${ctx.asian_range.high} (BSL above / SSL below)`);
  } else {
    lines.push("Asian range: not built yet (updates during 07–13 WIB)");
  }

  if (ctx.swing) {
    lines.push(`Swing H/L: ${ctx.swing.swing_low} – ${ctx.swing.swing_high}`);
  }
  if (ctx.fib) {
    lines.push(`Fib OTE (0.618–0.72): ${ctx.fib.ote_zone.low.toFixed(2)} – ${ctx.fib.ote_zone.high.toFixed(2)} | in zone: ${ctx.fib.in_ote_zone ? "YES" : `no (${ctx.fib.dist_to_ote_pips}p away)`}`);
  }
  if (ctx.structure) {
    lines.push(`Structure: ${ctx.structure.bias}${ctx.structure.bms_hint ? ` | ${ctx.structure.bms_hint}` : ""}${ctx.structure.sms_hint ? ` | ${ctx.structure.sms_hint}` : ""}`);
  }
  if (ctx.order_blocks) {
    const ob = ctx.order_blocks;
    lines.push(`OB zones — bull: ${ob.bullish_ob_zone ?? "?"} | bear: ${ob.bearish_ob_zone ?? "?"}${ob.wick_rejection ? ` | ${ob.wick_rejection}` : ""}`);
  }

  if (ctx.pdh != null || ctx.pdl != null) {
    lines.push(`PDH ${ctx.pdh ?? "?"} | PDL ${ctx.pdl ?? "?"}`);
  }

  lines.push(`HTF H4: ${ctx.htf.h4_trend} | H1: ${ctx.htf.h1_trend}`);
  if (ctx.liquidity_events.length) {
    lines.push(`Liquidity: ${ctx.liquidity_events.join(", ")}`);
  }
  for (const h of ctx.liquidity_hints.slice(0, 4)) {
    lines.push(`  → ${h}`);
  }

  lines.push("", "SETUP TYPES (propose_setup.setup_type):");
  lines.push("  turtle_soup_long — SSL raid, false break down, long");
  lines.push("  turtle_soup_short — BSL raid, false break up, short");
  lines.push("  sh_bms_rto — Stop hunt + break structure + return to order block");
  lines.push("  sms_bms_rto — Failure swing + BMS + RTO");
  lines.push("  amd_distribution — Trade distribution leg after London manip");
  lines.push("  fib_retrace — Entry on 50–72% retrace after BMS (not chase)");

  lines.push("", "RULES:");
  lines.push("- Min 2 confluence_factors from: htf_bias, liquidity_sweep, order_block_rto, fib_ote, london_open, ny_open, asian_range, session_amd");
  lines.push("- Do NOT trend-follow short into SSL / oversold (RSI<35) — prefer turtle_soup_long or WATCH");
  lines.push("- Do NOT trend-follow long into BSL / overbought (RSI>65)");
  lines.push("- After BMS: wait retracement to fib 0.5–0.72 or OB — no chase entries");
  lines.push(`- Suggested now: ${ctx.suggested_setups.length ? ctx.suggested_setups.join(", ") : "none — WATCH"}`);

  return lines.join("\n");
}

export function validateSMCSetup(args, ctx = null) {
  if (config.smc?.enabled === false) return { ok: true };

  const setupType = args.setup_type;
  const confluence = Array.isArray(args.confluence_factors) ? args.confluence_factors : [];
  const minConf = config.smc?.minConfluence ?? 2;

  if (!setupType || !SETUP_TYPES.includes(setupType)) {
    return {
      ok: false,
      reason: "invalid_setup_type",
      message: `setup_type required. Use: ${SETUP_TYPES.join(", ")}`,
    };
  }

  const validTags = confluence.filter((c) => CONFLUENCE_TAGS.includes(c));
  if (validTags.length < minConf) {
    return {
      ok: false,
      reason: "insufficient_confluence",
      message: `Need ≥${minConf} confluence_factors (have ${validTags.length}: ${validTags.join(", ") || "none"})`,
    };
  }

  if (config.smc?.requireTradingWindow && ctx && !ctx.trading_window) {
    const allowedOffHours = ["turtle_soup_long", "turtle_soup_short"].includes(setupType)
      && ctx.liquidity_events?.length > 0;
    if (!allowedOffHours) {
      return {
        ok: false,
        reason: "outside_trading_window",
        message: "Outside London/NY window (14–18 / 19–22 WIB) — prefer WATCH per PDF",
      };
    }
  }

  const rsi = args.screening_snapshot?.rsi ?? ctx?.ltf?.m15_rsi;
  if (typeof rsi === "number") {
    const noShort = config.screening?.rsiNoShortBelow ?? 35;
    const noLong = config.screening?.rsiNoLongAbove ?? 65;
    if (args.side === "short" && rsi < noShort && setupType !== "turtle_soup_short") {
      return { ok: false, reason: "rsi_oversold_no_trend_short", message: `RSI ${rsi} — use turtle_soup_long or WATCH, not trend short` };
    }
    if (args.side === "long" && rsi > noLong && setupType !== "turtle_soup_long") {
      return { ok: false, reason: "rsi_overbought_no_trend_long", message: `RSI ${rsi} — use turtle_soup_short or WATCH, not trend long` };
    }
  }

  const events = ctx?.liquidity_events || [];
  if (config.smc?.blockTrendFollowAtLiquidity !== false && events.length) {
    const sslSwept = events.some((e) => e.startsWith("ssl_"));
    const bslSwept = events.some((e) => e.startsWith("bsl_"));
    if (sslSwept && args.side === "short" && setupType !== "turtle_soup_short") {
      return {
        ok: false,
        reason: "ssl_swept_no_short",
        message: "SSL swept — do not short; favor turtle_soup_long / RTO long / WATCH",
      };
    }
    if (bslSwept && args.side === "long" && setupType !== "turtle_soup_long") {
      return {
        ok: false,
        reason: "bsl_swept_no_long",
        message: "BSL swept — do not long chase; favor turtle_soup_short / RTO short / WATCH",
      };
    }
  }

  return { ok: true, confluence: validTags, setup_type: setupType };
}
