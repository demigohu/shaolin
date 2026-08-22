import { config } from "../config.js";
import { roundToPips, toPips } from "./price.js";
import { getLastSMCContext } from "../smc.js";

const STRUCTURE_SL_SETUPS = new Set([
  "turtle_soup_long",
  "turtle_soup_short",
  "sh_bms_rto",
  "sms_bms_rto",
  "fib_retrace",
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

export function validateProposedSl(args, ctx, mode) {
  const entry = Number(args.entry);
  const sl = Number(args.sl);
  const side = args.side;
  if (!["long", "short"].includes(side) || !Number.isFinite(entry) || !Number.isFinite(sl)) {
    return { ok: false, reason: "invalid_sl", message: "Invalid entry or SL." };
  }

  const pip = config.broker.pipSize || 0.1;
  const minSl = resolveMinSlPips(args.setup_type, mode);
  const maxSl = mode.maxSlPips ?? 40;
  const bufferPips = config.screening?.slStructureBufferPips ?? 3;
  const slPips = toPips(Math.abs(entry - sl));

  if (side === "long" && sl >= entry) {
    return { ok: false, reason: "sl_wrong_side", message: "Long SL must be below entry." };
  }
  if (side === "short" && sl <= entry) {
    return { ok: false, reason: "sl_wrong_side", message: "Short SL must be above entry." };
  }
  if (slPips < minSl) {
    return {
      ok: false,
      reason: "sl_too_tight",
      sl_pips: slPips,
      min_sl_pips: minSl,
      message: `SL ${slPips}p too tight (min ${minSl}p for ${args.setup_type || "setup"}) — place below next structure, not on entry zone.`,
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

const LIMIT_SETUP_TYPES = new Set(["fib_retrace", "sh_bms_rto", "sms_bms_rto"]);

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
      entry_style: args.entry_style || "market",
      distPips: price != null ? toPips(Math.abs(Number(args.entry) - price)) : null,
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

  const entry = Number(args.entry);
  const distPips = toPips(Math.abs(price - entry));
  let entryStyle = args.entry_style;

  if (!entryStyle || !["limit", "market"].includes(entryStyle)) {
    if (distPips <= maxMarketPips) entryStyle = "market";
    else if (LIMIT_SETUP_TYPES.has(args.setup_type)) entryStyle = "limit";
    else entryStyle = "market";
  }

  if (entryStyle === "market") {
    // Market = enter now at live price; LLM often passes a zone level instead of the quote.
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
        entry_style: entryStyle,
      };
    }
  } else if (distPips > maxLimitPips) {
    return {
      ok: false,
      reason: "limit_entry_too_far",
      message: `Limit entry ${distPips}p from price (max ${maxLimitPips}p). Too far to wait — WATCH for closer level.`,
      distPips,
      price_at_propose: price,
      entry_style: entryStyle,
    };
  }

  return {
    ok: true,
    entry_style: entryStyle,
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
