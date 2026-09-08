import { config } from "../config.js";
import { roundToPips, toPips, normalizeTpLevels, computeRrRatio } from "./price.js";
import { getLastSMCContext } from "../smc.js";

const STRUCTURE_SL_SETUPS = new Set([
  "dip_reclaim_long",
  "dip_reclaim_short",
  "fib_retrace",
  "snr_bounce_long",
  "snr_bounce_short",
  "turtle_soup_long",
  "turtle_soup_short",
  "sh_bms_rto",
  "sms_bms_rto",
]);

function resolveMinSlPips(setupType, mode) {
  const bySetup = config.screening?.minSlPipsBySetup;
  if (setupType && bySetup?.[setupType] != null) return bySetup[setupType];
  return mode.minSlPips ?? 15;
}

/** Highest support strictly below entry zone (not the zone you're entering at). */
function findStructureFloor(entry, ctx, zonePips = 2) {
  const pip = config.broker.pipSize || 0.1;
  const cutoff = entry - zonePips * pip;
  const levels = [];
  for (const s of ctx?.mtf_zones?.supports || []) {
    if (s.price <= cutoff) levels.push(s.price);
  }
  if (ctx?.swing?.swing_low != null && ctx.swing.swing_low <= cutoff) {
    levels.push(ctx.swing.swing_low);
  }
  if (ctx?.pdl != null && ctx.pdl <= cutoff) levels.push(ctx.pdl);
  const ns = ctx?.ltf?.nearest_support;
  if (ns != null && ns <= cutoff) levels.push(ns);
  return levels.length ? Math.max(...levels) : null;
}

/** Lowest resistance strictly above entry zone. */
function findStructureCeiling(entry, ctx, zonePips = 2) {
  const pip = config.broker.pipSize || 0.1;
  const cutoff = entry + zonePips * pip;
  const levels = [];
  for (const r of ctx?.mtf_zones?.resistances || []) {
    if (r.price >= cutoff) levels.push(r.price);
  }
  if (ctx?.swing?.swing_high != null && ctx.swing.swing_high >= cutoff) {
    levels.push(ctx.swing.swing_high);
  }
  if (ctx?.pdh != null && ctx.pdh >= cutoff) levels.push(ctx.pdh);
  const nr = ctx?.ltf?.nearest_resistance;
  if (nr != null && nr >= cutoff) levels.push(nr);
  return levels.length ? Math.min(...levels) : null;
}

export function validateProposedSl(args, _ctx, mode) {
  const entry = Number(args.entry);
  const sl = Number(args.sl);
  const side = args.side;
  if (!["long", "short"].includes(side) || !Number.isFinite(entry) || !Number.isFinite(sl)) {
    return { ok: false, reason: "invalid_sl", message: "Invalid entry or SL." };
  }

  const llmOwns = config.screening?.llmOwnsTpSl !== false;
  const slPips = toPips(Math.abs(entry - sl));

  if (side === "long" && sl >= entry) {
    return { ok: false, reason: "sl_wrong_side", message: "Long SL must be below entry." };
  }
  if (side === "short" && sl <= entry) {
    return { ok: false, reason: "sl_wrong_side", message: "Short SL must be above entry." };
  }

  if (llmOwns) {
    return { ok: true, sl_pips: slPips };
  }

  const pip = config.broker.pipSize || 0.1;
  const minSl = resolveMinSlPips(args.setup_type, mode);
  const maxSl = mode.maxSlPips ?? 40;
  const bufferPips = config.screening?.slStructureBufferPips ?? 3;
  const ctx = _ctx;

  if (slPips < minSl) {
    return {
      ok: false,
      reason: "sl_too_tight",
      sl_pips: slPips,
      min_sl_pips: minSl,
      message: `SL ${slPips}p too tight (min ${minSl}p) — place below next structure level.`,
    };
  }
  if (maxSl != null && slPips > maxSl) {
    return {
      ok: false,
      reason: "sl_too_wide",
      sl_pips: slPips,
      max_sl_pips: maxSl,
      message: `SL ${slPips}p exceeds max ${maxSl}p.`,
    };
  }

  if (!STRUCTURE_SL_SETUPS.has(args.setup_type) || !ctx) {
    return { ok: true, sl_pips: slPips };
  }

  const events = ctx.liquidity_events || [];
  const zonePips = mode.entryZonePips ?? 3;
  const belowSweepPips = config.smc?.slBelowSweepPips ?? 10;

  if (side === "long") {
    const refs = [];
    const floor = findStructureFloor(entry, ctx, zonePips);
    if (floor != null) {
      const structSl = floor - bufferPips * pip;
      const structDistPips = toPips(entry - structSl);
      if (structDistPips <= maxSl) refs.push(structSl);
    }

    if (events.some((e) => e.startsWith("ssl_"))) {
      const sweepRef = Math.min(entry, ctx.price ?? entry);
      refs.push(sweepRef - belowSweepPips * pip);
    }

    if (refs.length) {
      const maxAllowedSl = Math.min(...refs);
      if (sl > maxAllowedSl + pip * 0.01) {
        const needPips = toPips(entry - maxAllowedSl);
        return {
          ok: false,
          reason: "sl_above_structure",
          sl_pips: slPips,
          min_sl_pips: Math.max(minSl, needPips),
          structure_level: roundToPips(Math.min(...refs) + bufferPips * pip),
          suggested_max_sl: roundToPips(maxAllowedSl),
          message: `SL ${sl} too high — need ≥${Math.max(minSl, needPips)}p below entry (below sweep/structure ~${roundToPips(maxAllowedSl + bufferPips * pip)}).`,
        };
      }
    }
  } else {
    const refs = [];
    const ceiling = findStructureCeiling(entry, ctx, zonePips);
    if (ceiling != null) {
      const structSl = ceiling + bufferPips * pip;
      const structDistPips = toPips(structSl - entry);
      if (structDistPips <= maxSl) refs.push(structSl);
    }

    if (events.some((e) => e.startsWith("bsl_"))) {
      const sweepRef = Math.max(entry, ctx.price ?? entry);
      refs.push(sweepRef + belowSweepPips * pip);
    }

    if (refs.length) {
      const minAllowedSl = Math.max(...refs);
      if (sl < minAllowedSl - pip * 0.01) {
        const needPips = toPips(minAllowedSl - entry);
        return {
          ok: false,
          reason: "sl_below_structure",
          sl_pips: slPips,
          min_sl_pips: Math.max(minSl, needPips),
          structure_level: roundToPips(minAllowedSl - bufferPips * pip),
          suggested_min_sl: roundToPips(minAllowedSl),
          message: `SL ${sl} too low — need ≥${Math.max(minSl, needPips)}p above entry (above sweep/structure ~${roundToPips(minAllowedSl - bufferPips * pip)}).`,
        };
      }
    }
  }

  return { ok: true, sl_pips: slPips };
}

export function validateSetupReason(args) {
  if (config.screening?.llmOwnsTpSl === false) return { ok: true };

  const reason = String(args.reason || "").trim();
  const sl = Number(args.sl);
  const entry = Number(args.entry);

  if (reason.length < 50) {
    return {
      ok: false,
      reason: "reason_too_short",
      message: "reason must explain entry, SL, and TP with structure labels + prices (support/resistance/fib/sweep).",
    };
  }

  const slText = Number.isFinite(sl) ? sl.toFixed(2) : "";
  if (slText && !reason.includes(slText) && !reason.includes(String(sl))) {
    return {
      ok: false,
      reason: "reason_missing_sl",
      message: `reason must state why SL is at ${sl} (which support/resistance/fib/sweep level).`,
    };
  }

  if (Array.isArray(args.tp_levels) && args.tp_levels.length) {
    const missingTp = args.tp_levels.filter((t) => {
      const p = Number(t.price);
      if (!Number.isFinite(p)) return true;
      const pt = p.toFixed(2);
      return !reason.includes(pt) && !reason.includes(String(p));
    });
    if (missingTp.length === args.tp_levels.length) {
      return {
        ok: false,
        reason: "reason_missing_tp",
        message: "reason must cite the SNR/fib target for each tp_levels price.",
      };
    }
  }

  if (!args.sl_anchor && !/\b(support|resistance|fib|sweep|snr|pdh|pdl|asian|ote|supply|demand)\b/i.test(reason)) {
    return {
      ok: false,
      reason: "reason_no_structure",
      message: "reason must reference structure (support, resistance, fib, sweep, etc.) for SL/TP placement.",
    };
  }

  if (Number.isFinite(entry) && Number.isFinite(sl) && Math.abs(entry - sl) < (config.broker.pipSize || 0.1) * 5) {
    return {
      ok: false,
      reason: "sl_on_entry",
      message: "SL too close to entry — place beyond the next structure level, not on the entry zone.",
    };
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
    return {
      ok: false,
      reason: "invalid_tp_levels",
      message: "tp_levels must be on profit side of entry (long: above, short: below).",
    };
  }

  const tpFinal = tpLevels[tpLevels.length - 1].price;
  const rr = computeRrRatio(side, entry, sl, tpFinal);
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

export function validateProposedTp(args) {
  const llmOwns = config.screening?.llmOwnsTpSl !== false;
  if (!Array.isArray(args.tp_levels) || !args.tp_levels.length) {
    return { ok: true, tp_source: llmOwns ? "llm_none" : "default" };
  }

  const entry = Number(args.entry);
  const sl = Number(args.sl);
  const side = args.side;
  const normalized = normalizeTpLevels(side, entry, sl, args.tp_levels);
  if (!normalized.length) {
    if (llmOwns) {
      return { ok: true, tp_source: "llm_none" };
    }
    return {
      ok: false,
      reason: "invalid_tp_levels",
      message: "tp_levels must be prices on the profit side of entry (long: above entry, short: below).",
    };
  }

  return { ok: true, tp_source: "llm", tp_levels: normalized };
}

const LIMIT_SETUP_TYPES = new Set([
  "fib_retrace",
  "dip_reclaim_long",
  "dip_reclaim_short",
  "snr_bounce_long",
  "snr_bounce_short",
  "sh_bms_rto",
  "sms_bms_rto",
]);

export async function resolveProposePrice(market) {
  const ctx = getLastSMCContext();
  if (ctx?.price != null) return ctx.price;
  try {
    const quote = await market.getManagementPrice();
    return quote?.price ?? null;
  } catch {
    return null;
  }
}

export function validateProposedEntry(args, price, mode) {
  const llmOwns = config.screening?.llmOwnsTpSl !== false;
  const entry = Number(args.entry);
  const entryStyle = args.entry_style === "limit" || args.entry_style === "market"
    ? args.entry_style
    : (llmOwns && LIMIT_SETUP_TYPES.has(args.setup_type) ? "limit" : "market");

  if (llmOwns) {
    if (!Number.isFinite(entry)) {
      return { ok: false, reason: "invalid_entry", message: "Entry price required." };
    }
    return {
      ok: true,
      entry_style: entryStyle,
      entry,
      distPips: price != null ? toPips(Math.abs(price - entry)) : null,
      price_at_propose: price,
    };
  }

  const zonePips = mode.entryZonePips ?? 3;
  const maxMarketPips = config.screening?.maxEntrySlippagePips ?? zonePips;
  const maxLimitPips = mode.maxLimitEntryPips
    ?? config.screening?.maxLimitEntryPips
    ?? mode.maxStaleDistancePips
    ?? config.screening?.maxStaleDistancePips
    ?? 25;

  if (config.screening?.requireEntryNearPrice === false) {
    return {
      ok: true,
      entry_style: entryStyle,
      distPips: price != null ? toPips(Math.abs(entry - price)) : null,
      price_at_propose: price,
    };
  }

  if (price == null) {
    return {
      ok: false,
      reason: "no_price",
      message: "Cannot validate entry — live price unavailable. Retry or WATCH.",
    };
  }

  const distPips = toPips(Math.abs(price - entry));
  let resolvedStyle = entryStyle;

  if (!args.entry_style || !["limit", "market"].includes(args.entry_style)) {
    if (distPips <= maxMarketPips) resolvedStyle = "market";
    else if (LIMIT_SETUP_TYPES.has(args.setup_type)) resolvedStyle = "limit";
    else resolvedStyle = "market";
  }

  if (resolvedStyle === "market") {
    if (distPips > maxMarketPips) {
      const maxSnap = maxLimitPips;
      if (distPips <= maxSnap) {
        return {
          ok: true,
          entry_style: "market",
          distPips: 0,
          price_at_propose: price,
          entry: price,
          entry_snapped_from: entry,
        };
      }
      return {
        ok: false,
        reason: "entry_too_far",
        message: `Market entry must be within ${maxMarketPips}p of price ${price} (entry ${entry} is ${distPips}p away). Use entry_style "limit" for retrace OR WATCH.`,
        distPips,
        price_at_propose: price,
        entry_style: resolvedStyle,
      };
    }
  } else if (distPips > maxLimitPips) {
    return {
      ok: false,
      reason: "limit_entry_too_far",
      message: `Limit entry ${distPips}p from price (max ${maxLimitPips}p). Too far to wait — WATCH for closer level.`,
      distPips,
      price_at_propose: price,
      entry_style: resolvedStyle,
    };
  }

  return {
    ok: true,
    entry_style: resolvedStyle,
    distPips,
    price_at_propose: price,
  };
}

export function isInEntryZone(setup, price, zonePips) {
  if (price == null || setup?.entry == null) return false;
  const pip = config.broker.pipSize || 0.1;
  const zone = (zonePips ?? 3) * pip;
  return Math.abs(price - setup.entry) <= zone;
}

export function distanceFromEntryPips(setup, price) {
  if (price == null || setup?.entry == null) return null;
  return toPips(Math.abs(price - setup.entry));
}

export function shouldExpireStaleByDistance(setup, price, mode) {
  if (setup.status !== "proposed" || setup.entry_style !== "limit") return false;
  const maxStale = mode.maxStaleDistancePips
    ?? config.screening?.maxStaleDistancePips
    ?? 15;
  const dist = distanceFromEntryPips(setup, price);
  return dist != null && dist > maxStale;
}

export function shouldInvalidatePreFill(setup, price) {
  if (setup.status !== "proposed") return false;
  const { side, sl } = setup;
  if (side === "long" && price <= sl) return true;
  if (side === "short" && price >= sl) return true;
  return false;
}
