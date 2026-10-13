/**
 * Multi-timeframe support/resistance zone stack (HTF → LTF).
 * Fractal swing highs/lows per TF + PDH/PDL, prior week, Asian range and the
 * monthly pivots, merged into weighted clusters around price.
 */

import { config } from "./config.js";
import { toPips } from "./tools/price.js";
import { findFractals } from "./smc-analysis.js";

const TF_WEIGHT = { "1w": 6, "1d": 5, "4h": 4, "1h": 3, "15m": 2, "5m": 1 };
const TF_LOOKBACK = { "1w": 52, "1d": 90, "4h": 60, "1h": 72, "15m": 96, "5m": 72 };
export const CANDLE_KEY = { "1w": "w1", "1d": "d1", "4h": "h4", "1h": "h1", "15m": "m15", "5m": "m5" };

export function extractSwingLevels(candles, tf) {
  const weight = TF_WEIGHT[tf] ?? 1;
  const { highs, lows } = findFractals((candles || []).slice(-(TF_LOOKBACK[tf] ?? 60)));
  return [
    ...highs.slice(-6).map((f) => ({ price: f.price, kind: "resistance", label: `${tf}:swing_high`, tf, weight, source: "swing" })),
    ...lows.slice(-6).map((f) => ({ price: f.price, kind: "support", label: `${tf}:swing_low`, tf, weight, source: "swing" })),
  ];
}

/** Monthly classic pivots — identical on every TradingView TF, so taken once. */
export function extractPivotLevels(sr) {
  if (!sr) return [];
  const map = { pivot: "pivot", resistance_1: "resistance", resistance_2: "resistance", support_1: "support", support_2: "support" };
  return Object.entries(map)
    .filter(([key]) => Number.isFinite(Number(sr[key])) && Number(sr[key]) > 0)
    .map(([key, kind]) => ({ price: Number(sr[key]), kind, label: `monthly:${key}`, tf: "1M", weight: 3, source: "pivot" }));
}

export function extractExtraLevels(extras) {
  const levels = [];
  const add = (price, kind, label, weight, source) => {
    if (Number.isFinite(price) && price > 0) levels.push({ price, kind, label, tf: source === "session" ? "1D" : source, weight, source });
  };
  const { pdh, pdl, pwh, pwl, pmh, pml, hod, lod, equal, asian } = extras || {};
  add(pmh, "resistance", "PMH", 6, "session");
  add(pml, "support", "PML", 6, "session");
  add(pwh, "resistance", "PWH", 5, "session");
  add(pwl, "support", "PWL", 5, "session");
  add(pdh, "resistance", "PDH", 5, "session");
  add(pdl, "support", "PDL", 5, "session");
  add(hod, "resistance", "HOD", 3, "session");
  add(lod, "support", "LOD", 3, "session");
  for (const e of equal || []) {
    add(e.price, e.kind === "eqh" ? "resistance" : "support", `${e.kind.toUpperCase()} ${e.tf}`, 4, "liquidity");
  }
  add(asian?.high, "resistance", "Asian high", 4, "asian");
  add(asian?.low, "support", "Asian low", 4, "asian");
  return levels;
}

export function mergeZoneLevels(rawLevels, mergePips) {
  const pip = config.broker.pipSize || 0.1;
  const mergeDist = mergePips * pip;
  const sorted = [...rawLevels].sort((a, b) => a.price - b.price);
  const clusters = [];

  for (const level of sorted) {
    const cur = clusters.at(-1);
    if (cur && level.price - cur.members[0].price <= mergeDist) cur.members.push(level);
    else clusters.push({ members: [level] });
  }

  return clusters.map(({ members }) => {
    const totalW = members.reduce((s, l) => s + l.weight, 0);
    const avgPrice = members.reduce((s, l) => s + l.price * l.weight, 0) / totalW;
    const kinds = new Set(members.map((l) => l.kind));
    const kind = kinds.size === 1 ? members[0].kind : "flip";
    return {
      price: Number(avgPrice.toFixed(config.broker.digits ?? 2)),
      kind,
      strength: totalW,
      labels: members.map((l) => l.label),
      timeframes: [...new Set(members.map((l) => l.tf))],
      sources: [...new Set(members.map((l) => l.source))],
      confluence_tfs: new Set(members.map((l) => l.tf)).size,
    };
  });
}

export function classifyZonesAtPrice(price, zones, proximityPips) {
  if (price == null) {
    return { supports: [], resistances: [], nearestSupport: null, nearestResistance: null, atSupport: false, atResistance: false };
  }

  const pip = config.broker.pipSize || 0.1;
  const prox = proximityPips * pip;

  // Role follows position vs live price — a broken resistance below price acts as support.
  const below = zones.filter((z) => z.price <= price).sort((a, b) => b.price - a.price);
  const above = zones.filter((z) => z.price > price).sort((a, b) => a.price - b.price);

  const nearestSupport = below[0] || null;
  const nearestResistance = above[0] || null;

  return {
    supports: below.slice(0, 6),
    resistances: above.slice(0, 6),
    nearestSupport,
    nearestResistance,
    atSupport: nearestSupport != null && price - nearestSupport.price <= prox,
    atResistance: nearestResistance != null && nearestResistance.price - price <= prox,
  };
}

/** Bias from the two highest-timeframe trend labels. */
export function inferHtfBias(trends = []) {
  const [a, b] = trends.map((t) => String(t || "").toLowerCase());
  if (a?.includes("bull") && b?.includes("bull")) return "bullish";
  if (a?.includes("bear") && b?.includes("bear")) return "bearish";
  if (a?.includes("bull") || b?.includes("bull")) return "lean_bull";
  if (a?.includes("bear") || b?.includes("bear")) return "lean_bear";
  return "neutral";
}

export function buildMtfZoneStack({
  candles = null,
  pivots = null,
  price = null,
  extras = {},
  htfTrends = [],
  timeframes = ["4h", "1h", "15m", "5m"],
  mergePips = 8,
  proximityPips = 5,
  reachPips = null,
}) {
  const minStrength = config.mtfZones?.minZoneStrength ?? 0;

  const raw = [];
  if (candles) {
    for (const tf of timeframes) {
      const key = CANDLE_KEY[tf];
      if (key && candles[key]) raw.push(...extractSwingLevels(candles[key], tf));
    }
  }
  raw.push(...extractPivotLevels(pivots));
  raw.push(...extractExtraLevels(extras));

  const merged = mergeZoneLevels(raw, mergePips).filter((z) => z.strength >= minStrength);
  // The SR map shown to the LLM covers only what this mode can trade (reach = max TP distance);
  // all zones stay in `zones` for SL structure checks.
  const inReach = reachPips == null || price == null
    ? merged
    : merged.filter((z) => Math.abs(toPips(z.price - price)) <= reachPips);
  const classified = classifyZonesAtPrice(price, inReach, proximityPips);

  return {
    price,
    merge_pips: mergePips,
    proximity_pips: proximityPips,
    reach_pips: reachPips,
    beyond_reach: merged.length - inReach.length,
    timeframes,
    htf_bias: inferHtfBias(htfTrends),
    candles_available: Boolean(candles),
    zones: merged,
    ...classified,
  };
}

export function formatMtfZonesForPrompt(stack) {
  if (!stack || stack.disabled) return "";
  const lines = [
    "",
    `── MTF S/R ZONE STACK (fractal swings ${(stack.timeframes || []).join("/")} + PMH/PML, PWH/PWL, PDH/PDL, HOD/LOD, EQH/EQL, Asian + monthly pivots) ──`,
    `Price: ${stack.price ?? "?"} | HTF bias: ${stack.htf_bias}${stack.reach_pips != null ? ` | levels within ±${stack.reach_pips}p (trade reach)` : ""}`,
  ];
  if (!stack.candles_available) {
    lines.push("⚠ Candle history unavailable — only monthly pivots below; swing/session levels missing.");
  }

  if (stack.reach_pips != null && !stack.nearestSupport) lines.push(`No support within ${stack.reach_pips}p below price.`);
  if (stack.reach_pips != null && !stack.nearestResistance) lines.push(`No resistance within ${stack.reach_pips}p above price.`);

  for (const [label, z, at, dir] of [
    ["Nearest support", stack.nearestSupport, stack.atSupport, "below"],
    ["Nearest resistance", stack.nearestResistance, stack.atResistance, "above"],
  ]) {
    if (!z) continue;
    const dist = stack.price != null ? Math.abs(toPips(stack.price - z.price)) : "?";
    lines.push(`${label}: ${z.price} (${dist}p ${dir}) strength=${z.strength} [${z.labels.slice(0, 4).join(", ")}]${at ? " ★ AT ZONE" : ""}`);
  }

  for (const [label, list] of [["Support stack", stack.supports], ["Resistance stack", stack.resistances]]) {
    const top = (list || []).slice(0, 4);
    if (!top.length) continue;
    lines.push(`${label}:`);
    for (const z of top) {
      lines.push(`  ${z.price} str=${z.strength} [${z.labels.slice(0, 3).join(", ")}]`);
    }
  }

  if (stack.beyond_reach) {
    lines.push(`${stack.beyond_reach} farther level(s) omitted — beyond this mode's reach, not valid entries or targets.`);
  }
  lines.push("Note: S/R levels are reference only — you choose setup_type, side, entry, SL and TP from structure within reach.");
  return lines.join("\n");
}
