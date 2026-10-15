import { config } from "../config.js";
import { roundToPips, toPips, normalizeTpLevels, computeRrRatio } from "./price.js";
import { sideOfLiquidity, SETUP_TYPES, REVERSAL_SETUPS } from "../smc.js";

const STRUCTURE_SL_SETUPS = new Set(SETUP_TYPES);

const pipSize = () => config.broker.pipSize || 0.1;

function resolveMinSlPips(setupType, mode) {
  const bySetup = config.screening?.minSlPipsBySetup;
  if (setupType && bySetup?.[setupType] != null) return bySetup[setupType];
  return mode.minSlPips ?? 15;
}

/** Highest structure level strictly below the entry zone. */
function findStructureFloor(entry, ctx, zonePips) {
  const cutoff = entry - zonePips * pipSize();
  const levels = [
    ...(ctx?.mtf_zones?.zones || []).map((z) => z.price),
    ctx?.swing?.swing_low,
    ctx?.pdl,
  ].filter((p) => p != null && p <= cutoff);
  return levels.length ? Math.max(...levels) : null;
}

/** Lowest structure level strictly above the entry zone. */
function findStructureCeiling(entry, ctx, zonePips) {
  const cutoff = entry + zonePips * pipSize();
  const levels = [
    ...(ctx?.mtf_zones?.zones || []).map((z) => z.price),
    ctx?.swing?.swing_high,
    ctx?.pdh,
  ].filter((p) => p != null && p >= cutoff);
  return levels.length ? Math.min(...levels) : null;
}

export function validateConfidence(args, mode) {
  const min = mode.minConfidence;
  const conf = Number(args.confidence);
  if (min == null) return { ok: true };
  if (!Number.isFinite(conf) || conf < min) {
    return { ok: false, reason: "confidence_too_low", message: `Confidence ${args.confidence ?? "?"}% < ${min}% minimum for ${mode.id} — WATCH instead.` };
  }
  return { ok: true };
}

/** Block trend-continuation entries into extreme RSI (liquidity-reversal setups are exempt). */
export function validateRsi(args, rsi) {
  if (config.screening?.blockExtremeRsi === false || typeof rsi !== "number") return { ok: true };
  const noShort = config.screening.rsiNoShortBelow ?? 35;
  const noLong = config.screening.rsiNoLongAbove ?? 65;
  if (REVERSAL_SETUPS.has(args.setup_type)) return { ok: true };
  if (args.side === "short" && rsi < noShort) {
    return { ok: false, reason: "rsi_oversold_no_short", message: `RSI ${rsi.toFixed(1)} oversold — no continuation short (bounce risk). Wait for a sweep + BMS (turtle soup / SH+BMS+RTO) or WATCH.` };
  }
  if (args.side === "long" && rsi > noLong) {
    return { ok: false, reason: "rsi_overbought_no_long", message: `RSI ${rsi.toFixed(1)} overbought — no continuation long. Wait for a sweep + BMS (turtle soup / SH+BMS+RTO) or WATCH.` };
  }
  return { ok: true };
}

const BMS_SETUPS = new Set(["sh_bms_rto", "sms_bms_rto", "bms_rto_ote", "amd_distribution"]);

/**
 * The PDF trigger must be printed on the entry TF before an entry — checked on the
 * candles, not taken from the model's reading: BMS setups need a fresh BMS in the
 * trade direction whose OB has not failed; turtle soup needs the opposite pool swept.
 */
export function validateTriggerComplete(args, ctx) {
  if (config.screening?.requireTriggerComplete === false) return { ok: true };
  const t = ctx?.trigger;
  if (!t) return { ok: true };
  const tf = ctx.profile?.trigger_tf ?? "entry TF";
  const long = args.side === "long";

  if (BMS_SETUPS.has(args.setup_type)) {
    const want = long ? "bullish" : "bearish";
    const maxBars = config.screening?.maxBmsBarsAgo ?? 24;
    const bms = t.bms;
    if (!bms || bms.dir !== want) {
      const last = bms ? `last ${tf} BMS is ${bms.dir} (${bms.level.toFixed(2)}, ${bms.bars_ago} bars ago)` : `no ${tf} BMS`;
      return { ok: false, reason: "trigger_incomplete", message: `${args.setup_type} ${args.side} needs a ${want} ${tf} BMS — ${last}. Trigger not complete → WATCH.` };
    }
    if (bms.bars_ago > maxBars) {
      return { ok: false, reason: "trigger_stale", message: `${want} ${tf} BMS is ${bms.bars_ago} bars old (max ${maxBars}) — wait for a fresh one → WATCH.` };
    }
    if (String(t.rto || "").startsWith("failed")) {
      return { ok: false, reason: "trigger_failed", message: `Price closed back through the ${tf} BMS order block — the trigger failed → WATCH.` };
    }
    return { ok: true };
  }

  if (args.setup_type === "turtle_soup_long" || args.setup_type === "turtle_soup_short") {
    const side = long ? "ssl" : "bsl";
    const swept = (t.sweeps || []).some((s) => s.side === side) || sideOfLiquidity(ctx.liquidity_events)[side];
    if (!swept) {
      return { ok: false, reason: "trigger_incomplete", message: `${args.setup_type} needs a ${side.toUpperCase()} sweep that closed back inside — none on ${tf} → WATCH.` };
    }
  }
  return { ok: true };
}

export function validateProposedSl(args, ctx, mode) {
  const entry = Number(args.entry);
  const sl = Number(args.sl);
  const side = args.side;
  if (!["long", "short"].includes(side) || !Number.isFinite(entry) || !Number.isFinite(sl)) {
    return { ok: false, reason: "invalid_sl", message: "Invalid entry or SL." };
  }

  const slPips = toPips(Math.abs(entry - sl));
  if (side === "long" && sl >= entry) return { ok: false, reason: "sl_wrong_side", message: "Long SL must be below entry." };
  if (side === "short" && sl <= entry) return { ok: false, reason: "sl_wrong_side", message: "Short SL must be above entry." };

  // Mode bounds apply even when the LLM places SL (llmOwnsTpSl) — they are the risk envelope.
  const minSl = resolveMinSlPips(args.setup_type, mode);
  const maxSl = mode.maxSlPips;
  if (slPips < minSl) {
    return { ok: false, reason: "sl_too_tight", sl_pips: slPips, min_sl_pips: minSl, message: `SL ${slPips}p too tight (min ${minSl}p for ${mode.id}) — place beyond the next structure level.` };
  }
  if (maxSl != null && slPips > maxSl) {
    return {
      ok: false,
      reason: "sl_too_wide",
      sl_pips: slPips,
      max_sl_pips: maxSl,
      message: `SL ${slPips}p exceeds the ${maxSl}p max for ${mode.id}. Invalidation is too far for this mode — find an entry closer to structure, or WATCH. Do not just move SL inside structure.`,
    };
  }

  if (config.screening?.llmOwnsTpSl !== false) return { ok: true, sl_pips: slPips };

  const pip = pipSize();
  const bufferPips = config.screening?.slStructureBufferPips ?? 3;
  if (!STRUCTURE_SL_SETUPS.has(args.setup_type) || !ctx) return { ok: true, sl_pips: slPips };

  const raids = sideOfLiquidity(ctx.liquidity_events);
  const zonePips = mode.entryZonePips ?? 3;
  const sweepPips = config.smc?.slBelowSweepPips ?? 10;

  if (side === "long") {
    const refs = [];
    const floor = findStructureFloor(entry, ctx, zonePips);
    if (floor != null && toPips(entry - (floor - bufferPips * pip)) <= maxSl) refs.push(floor - bufferPips * pip);
    if (raids.ssl) refs.push(Math.min(entry, ctx.price ?? entry) - sweepPips * pip);
    if (refs.length) {
      const maxAllowedSl = Math.min(...refs);
      if (sl > maxAllowedSl + pip * 0.01) {
        const needPips = Math.max(minSl, toPips(entry - maxAllowedSl));
        return {
          ok: false,
          reason: "sl_above_structure",
          sl_pips: slPips,
          min_sl_pips: needPips,
          suggested_max_sl: roundToPips(maxAllowedSl),
          message: `SL ${sl} sits inside structure — move to ≤${roundToPips(maxAllowedSl)} (≥${needPips}p below entry).`,
        };
      }
    }
  } else {
    const refs = [];
    const ceiling = findStructureCeiling(entry, ctx, zonePips);
    if (ceiling != null && toPips(ceiling + bufferPips * pip - entry) <= maxSl) refs.push(ceiling + bufferPips * pip);
    if (raids.bsl) refs.push(Math.max(entry, ctx.price ?? entry) + sweepPips * pip);
    if (refs.length) {
      const minAllowedSl = Math.max(...refs);
      if (sl < minAllowedSl - pip * 0.01) {
        const needPips = Math.max(minSl, toPips(minAllowedSl - entry));
        return {
          ok: false,
          reason: "sl_below_structure",
          sl_pips: slPips,
          min_sl_pips: needPips,
          suggested_min_sl: roundToPips(minAllowedSl),
          message: `SL ${sl} sits inside structure — move to ≥${roundToPips(minAllowedSl)} (≥${needPips}p above entry).`,
        };
      }
    }
  }

  return { ok: true, sl_pips: slPips };
}

export function validateSetupReason(args) {
  if (config.screening?.llmOwnsTpSl === false) return { ok: true };

  const reason = String(args.reason || "").trim();
  const slAnchor = String(args.sl_anchor || "").trim();

  if (reason.length < 50) {
    return { ok: false, reason: "reason_too_short", message: "reason must explain the setup: HTF key level + trigger sequence (sweep / BMS / RTO) (≥50 chars). SL/TP structure goes in sl_anchor + tp_levels[].label." };
  }
  if (slAnchor.length < 12) {
    return { ok: false, reason: "sl_anchor_required", message: 'sl_anchor required — e.g. "above 1H high 4396.89 + buffer" or "below PDL sweep 4345".' };
  }
  if (!/\b(support|resistance|fib|sweep|snr|pdh|pdl|pwh|pwl|asian|ote|supply|demand|high|low|bsl|ssl|ob|order block|swing)\b/i.test(slAnchor)) {
    return { ok: false, reason: "sl_anchor_no_structure", message: "sl_anchor must name the structure level SL sits beyond (not just pip count)." };
  }

  if (Array.isArray(args.tp_levels) && args.tp_levels.length) {
    if (args.tp_levels.some((t) => String(t.label || "").trim().length < 8)) {
      return { ok: false, reason: "tp_label_required", message: 'Each tp_levels needs label — e.g. "MTF support 4389.9 / 4H demand".' };
    }
    if (args.tp_levels.some((t) => !/\b(support|resistance|fib|snr|pdh|pdl|pwh|pwl|asian|supply|demand|target|ote|swing|low|high|liquidity|bsl|ssl)\b/i.test(String(t.label)))) {
      return { ok: false, reason: "tp_label_no_structure", message: "Each tp_levels.label must name the SNR/fib target (support, resistance, fib, etc.)." };
    }
  }

  const entry = Number(args.entry);
  const sl = Number(args.sl);
  if (Number.isFinite(entry) && Number.isFinite(sl) && Math.abs(entry - sl) < pipSize() * 5) {
    return { ok: false, reason: "sl_on_entry", message: "SL too close to entry — place beyond the next structure level, not on the entry zone." };
  }

  return { ok: true };
}

/** Min RR without tightening SL — extend TP to next SNR/fib instead. */
export function validateMinRr(args, mode) {
  if (config.screening?.enforceMinRr === false) return { ok: true };
  const minRr = mode.minRrRatio ?? 1.2;
  if (minRr <= 0) return { ok: true };

  const entry = Number(args.entry);
  const sl = Number(args.sl);
  const side = args.side;
  if (!Number.isFinite(entry) || !Number.isFinite(sl)) return { ok: true };

  const riskPips = toPips(Math.abs(entry - sl));
  const minRewardPips = Math.ceil(riskPips * minRr);

  if (!Array.isArray(args.tp_levels) || !args.tp_levels.length) {
    // Template TPs (llmOwnsTpSl=false) are generated from mode.partialTp RR multiples.
    if (config.screening?.llmOwnsTpSl === false) return { ok: true };
    return {
      ok: false,
      reason: "tp_required_for_rr",
      min_rr: minRr,
      sl_pips: riskPips,
      message: `tp_levels required. SL at structure (${riskPips}p risk) — target next SNR/fib ≥${minRewardPips}p for RR ${minRr}. Do NOT tighten SL.`,
    };
  }

  const tpLevels = normalizeTpLevels(side, entry, sl, args.tp_levels);
  if (!tpLevels.length) {
    return { ok: false, reason: "invalid_tp_levels", message: "tp_levels must be on profit side of entry (long: above, short: below)." };
  }

  const rr = computeRrRatio(side, entry, sl, tpLevels.at(-1).price);
  if (rr < minRr) {
    return {
      ok: false,
      reason: "rr_too_low",
      rr_ratio: rr,
      min_rr: minRr,
      sl_pips: riskPips,
      min_tp_pips: minRewardPips,
      message: `RR ${rr} < ${minRr}. Keep SL at ${sl} (${riskPips}p) — extend TP final to next SNR/fib ≥${minRewardPips}p from entry. Never tighten SL to fix RR.`,
    };
  }
  return { ok: true, rr_ratio: rr };
}

/** Final TP must be reachable within the mode's holding time (mode.maxTpPips). */
export function validateTpDistance(args, mode) {
  const maxTp = mode.maxTpPips;
  if (maxTp == null || !Array.isArray(args.tp_levels) || !args.tp_levels.length) return { ok: true };
  const entry = Number(args.entry);
  const far = args.tp_levels
    .map((t) => ({ price: Number(t.price), pips: toPips(Math.abs(Number(t.price) - entry)) }))
    .filter((t) => Number.isFinite(t.price) && t.pips > maxTp);
  if (!far.length) return { ok: true };
  return {
    ok: false,
    reason: "tp_too_far",
    max_tp_pips: maxTp,
    message: `TP ${far.map((t) => `${t.price} (${t.pips}p)`).join(", ")} beyond the ${maxTp}p max for ${mode.id} (holding time ≤ ${mode.setupMaxAgeMin ?? "?"}m). Target the nearest realistic SNR/fib level instead.`,
  };
}

/** Normalized TP ladder, or none (template TPs are filled in by createSetup). */
export function validateProposedTp(args) {
  if (!Array.isArray(args.tp_levels) || !args.tp_levels.length) return { ok: true };
  const normalized = normalizeTpLevels(args.side, Number(args.entry), Number(args.sl), args.tp_levels);
  if (!normalized.length) {
    return { ok: false, reason: "invalid_tp_levels", message: "tp_levels must be prices on the profit side of entry (long: above entry, short: below)." };
  }
  if (normalized.length < args.tp_levels.length) {
    return { ok: false, reason: "invalid_tp_levels", message: "Some tp_levels are on the wrong side of entry — every TP must be in profit direction." };
  }
  return { ok: true, tp_levels: normalized };
}

/**
 * Entry sanity vs live price:
 * - market: entry within maxEntrySlippagePips (default entryZonePips) of price
 * - limit: on the retrace side of price (long ≤ price, short ≥ price) and ≤ maxLimitEntryPips away
 */
export function validateProposedEntry(args, price, mode) {
  const entry = Number(args.entry);
  if (!Number.isFinite(entry)) return { ok: false, reason: "invalid_entry", message: "Entry price required." };
  if (price == null) {
    return { ok: false, reason: "no_price", message: "Cannot validate entry — live price unavailable. WATCH and retry next cycle." };
  }

  const pip = pipSize();
  const zonePips = mode.entryZonePips ?? 3;
  const maxMarketPips = config.screening?.maxEntrySlippagePips ?? zonePips;
  const maxLimitPips = mode.maxLimitEntryPips ?? config.screening?.maxLimitEntryPips ?? 25;
  const distPips = toPips(Math.abs(price - entry));

  let entryStyle = args.entry_style;
  if (entryStyle !== "limit" && entryStyle !== "market") entryStyle = distPips <= maxMarketPips ? "market" : "limit";

  const base = { entry_style: entryStyle, distPips, price_at_propose: price };
  if (config.screening?.requireEntryNearPrice === false) return { ok: true, ...base };

  if (entryStyle === "market") {
    if (distPips > maxMarketPips) {
      return {
        ok: false,
        reason: "entry_too_far",
        ...base,
        message: `Market entry must be within ${maxMarketPips}p of price ${price} (entry ${entry} is ${distPips}p away). Use entry_style "limit" for a retrace, or WATCH.`,
      };
    }
    return { ok: true, ...base };
  }

  const wrongSide = args.side === "long" ? entry > price + zonePips * pip : entry < price - zonePips * pip;
  if (wrongSide) {
    return {
      ok: false,
      reason: "limit_wrong_side",
      ...base,
      message: `${args.side} limit at ${entry} is on the breakout side of price ${price} — a limit fills on retrace (long below price, short above). Use market on reclaim or WATCH.`,
    };
  }
  if (distPips > maxLimitPips) {
    return { ok: false, reason: "limit_entry_too_far", ...base, message: `Limit entry ${distPips}p from price (max ${maxLimitPips}p). Too far to wait — WATCH for a closer level.` };
  }
  return { ok: true, ...base };
}

export function distanceFromEntryPips(setup, price) {
  if (price == null || setup?.entry == null) return null;
  return toPips(Math.abs(price - setup.entry));
}

/** A resting limit fills once price trades to the entry (within the zone tolerance) or through it. */
export function isLimitFilled(setup, price, zonePips) {
  if (price == null || setup?.entry == null) return false;
  const zone = (zonePips ?? 3) * pipSize();
  return setup.side === "long" ? price <= setup.entry + zone : price >= setup.entry - zone;
}

/** Unfilled limit is stale once price has run maxStale pips further away than when it was proposed. */
export function shouldExpireStaleByDistance(setup, price, mode) {
  if (setup.status !== "proposed" || setup.entry_style !== "limit" || price == null) return false;
  const maxStale = mode.maxStaleDistancePips ?? config.screening?.maxStaleDistancePips ?? 15;
  const awayFromEntry = setup.side === "long" ? price > setup.entry : price < setup.entry;
  if (!awayFromEntry) return false;
  const dist = distanceFromEntryPips(setup, price);
  return dist > (setup.entry_distance_pips ?? 0) + maxStale;
}

export function shouldInvalidatePreFill(setup, price) {
  if (setup.status !== "proposed" || price == null) return false;
  return setup.side === "long" ? price <= setup.sl : price >= setup.sl;
}
