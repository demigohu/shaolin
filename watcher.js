/**
 * Event watcher — cheap deterministic check (no LLM) every minute. Fires a
 * screening when price reaches a plan POI or sweeps a liquidity pool, so
 * setups aren't missed between the periodic screening cycles.
 */

import { toPips } from "./tools/price.js";

/**
 * @param price     live price
 * @param bar       current LTF bar { high, low } (sweeps are wicks through a pool)
 * @param pois      plan POIs [{ id, side, zone_low, zone_high }]
 * @param pools     liquidity pools [{ name, high?, low? }]
 * @param lastFired Map key → ms timestamp of the last time that trigger fired
 * @returns triggers [{ key, kind, text }] not on cooldown
 */
export function detectTriggers({ price, bar, pois = [], pools = [], proximityPips = 5, lastFired = new Map(), cooldownMs = 30 * 60_000, now = Date.now() }) {
  if (price == null) return [];
  const out = [];
  const add = (key, kind, text) => {
    if (now - (lastFired.get(key) ?? 0) < cooldownMs) return;
    out.push({ key, kind, text });
  };

  for (const p of pois) {
    const dist = price < p.zone_low ? toPips(p.zone_low - price) : price > p.zone_high ? toPips(price - p.zone_high) : 0;
    if (dist <= proximityPips) {
      add(`poi:${p.id}`, "poi", `price ${price} ${dist === 0 ? "inside" : `${dist}p from`} plan ${p.id} ${p.side.toUpperCase()} zone ${p.zone_low}–${p.zone_high} (${p.level_type})`);
    }
  }

  for (const pool of pools) {
    if (pool.high != null && bar?.high != null && bar.high > pool.high && price < pool.high) {
      add(`sweep:${pool.name}:high`, "sweep", `${pool.name} high ${pool.high.toFixed(2)} swept (bar high ${bar.high}) and price back below at ${price} — BSL raid`);
    }
    if (pool.low != null && bar?.low != null && bar.low < pool.low && price > pool.low) {
      add(`sweep:${pool.name}:low`, "sweep", `${pool.name} low ${pool.low.toFixed(2)} swept (bar low ${bar.low}) and price back above at ${price} — SSL raid`);
    }
  }
  return out;
}

/** Liquidity pools from the last structure context (Asian / PD / PW / PM / equal highs-lows). */
export function poolsFromContext(ctx) {
  if (!ctx) return [];
  const pools = [];
  const add = (name, high, low) => {
    if (high != null || low != null) pools.push({ name, high: high ?? null, low: low ?? null });
  };
  if (ctx.asian_range?.complete) add("Asian", ctx.asian_range.high, ctx.asian_range.low);
  add("PD", ctx.pdh, ctx.pdl);
  add("PW", ctx.pwh, ctx.pwl);
  for (const e of ctx.equal_levels || []) {
    add(`EQ${e.kind === "eqh" ? "H" : "L"} ${e.tf}`, e.kind === "eqh" ? e.price : null, e.kind === "eql" ? e.price : null);
  }
  return pools;
}

/**
 * Trigger completion after a POI touch: a fresh entry-TF BMS in the POI's direction
 * (bullish for long POIs, bearish for short) while price reached the zone in the
 * recent bars. This is the PDF "SH/SMS → BMS" step — the OB that caused the BMS is
 * where the RTO limit goes.
 *
 * @param state  ltfTriggerState() result
 * @param maxBarsAgo how fresh the BMS must be
 */
export function detectBmsTriggers({ state, pois = [], lastFired = new Map(), cooldownMs = 60 * 60_000, now = Date.now(), maxBarsAgo = 2 }) {
  const bms = state?.bms;
  if (!bms || bms.bars_ago > maxBarsAgo) return [];
  const recent = state.tape || [];
  const out = [];
  for (const p of pois) {
    const wantDir = p.side === "long" ? "bullish" : "bearish";
    if (bms.dir !== wantDir) continue;
    const reached = p.side === "long"
      ? recent.some((k) => k.l <= p.zone_high)
      : recent.some((k) => k.h >= p.zone_low);
    if (!reached) continue;
    const key = `bms:${p.id}:${bms.level.toFixed(2)}`;
    if (now - (lastFired.get(key) ?? 0) < cooldownMs) continue;
    const ob = state.ob ? ` — RTO zone (OB) ${state.ob.low.toFixed(2)}–${state.ob.high.toFixed(2)}, RTO ${state.rto}` : "";
    out.push({
      key,
      kind: "bms",
      text: `plan ${p.id} ${p.side.toUpperCase()}: price reached the zone and a ${bms.dir} BMS closed through ${bms.level.toFixed(2)} (${bms.bars_ago} bars ago)${ob}`,
    });
  }
  return out;
}
