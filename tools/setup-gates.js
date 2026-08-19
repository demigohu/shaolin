import { config } from "../config.js";
import { toPips } from "./price.js";
import { getLastSMCContext } from "../smc.js";

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
    if (distPips > maxMarketPips) {
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
