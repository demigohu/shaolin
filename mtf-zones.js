/**
 * Multi-timeframe support/resistance zone stack (HTF → LTF).
 * Merges pivot S/R per TF with PDH/PDL/Asian levels; scores confluence at price.
 */

import { config } from "./config.js";
import { toPips } from "./tools/price.js";
import { extractPriceFromAnalysis } from "./tools/market.js";

const TF_WEIGHT = { "1D": 5, "4h": 4, "1h": 3, "15m": 2, "5m": 1 };
const DEFAULT_TFS = ["4h", "1h", "15m", "5m"];

export function extractLevelsFromAnalysis(analysis, tf) {
  if (!analysis || analysis.error) return [];
  const weight = TF_WEIGHT[tf] ?? 1;
  const levels = [];
  const sr = analysis.support_resistance || {};

  for (const [key, val] of Object.entries(sr)) {
    if (key.includes("distance") || key.endsWith("_pct")) continue;
    const price = Number(val);
    if (!Number.isFinite(price) || price <= 0) continue;
    let kind = "level";
    if (key.includes("resist") || /^r\d/.test(key)) kind = "resistance";
    else if (key.includes("support") || /^s\d/.test(key)) kind = "support";
    else if (key === "pivot") kind = "pivot";
    levels.push({ price, kind, label: `${tf}:${key}`, tf, weight, source: "pivot" });
  }

  const pd = analysis.price_data || {};
  const high = Number(pd.high);
  const low = Number(pd.low);
  if (Number.isFinite(high) && high > 0) {
    levels.push({ price: high, kind: "resistance", label: `${tf}:bar_high`, tf, weight, source: "bar" });
  }
  if (Number.isFinite(low) && low > 0) {
    levels.push({ price: low, kind: "support", label: `${tf}:bar_low`, tf, weight, source: "bar" });
  }
  return levels;
}

export function extractExtraLevels(extras, price = null) {
  const levels = [];
  const { pdh, pdl, asian } = extras || {};
  if (Number.isFinite(pdh) && pdh > 0) {
    const kind = price != null && price >= pdh ? "support" : "resistance";
    levels.push({ price: pdh, kind, label: "PDH", tf: "1D", weight: 5, source: "session" });
  }
  if (Number.isFinite(pdl) && pdl > 0) {
    const kind = price != null && price <= pdl ? "resistance" : "support";
    levels.push({ price: pdl, kind, label: "PDL", tf: "1D", weight: 5, source: "session" });
  }
  if (asian?.high) {
    const kind = price != null && price >= asian.high ? "support" : "resistance";
    levels.push({ price: asian.high, kind, label: "Asian high", tf: "session", weight: 4, source: "asian" });
  }
  if (asian?.low) {
    const kind = price != null && price < asian.low ? "resistance" : "support";
    levels.push({ price: asian.low, kind, label: "Asian low", tf: "session", weight: 4, source: "asian" });
  }
  return levels;
}

export function mergeZoneLevels(rawLevels, mergePips) {
  const pip = config.broker.pipSize || 0.1;
  const mergeDist = mergePips * pip;
  const sorted = [...rawLevels].sort((a, b) => a.price - b.price);
  const used = new Array(sorted.length).fill(false);
  const clusters = [];

  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    const cluster = [sorted[i]];
    used[i] = true;
    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      if (sorted[j].price - sorted[i].price > mergeDist) break;
      const sameKind = sorted[j].kind === sorted[i].kind
        || sorted[i].kind === "pivot"
        || sorted[j].kind === "pivot";
      if (Math.abs(sorted[j].price - sorted[i].price) <= mergeDist && sameKind) {
        cluster.push(sorted[j]);
        used[j] = true;
      }
    }
    const totalW = cluster.reduce((s, l) => s + l.weight, 0);
    const avgPrice = cluster.reduce((s, l) => s + l.price * l.weight, 0) / totalW;
    const kind = cluster.some((l) => l.kind === "resistance") && !cluster.some((l) => l.kind === "support")
      ? "resistance"
      : cluster.some((l) => l.kind === "support") && !cluster.some((l) => l.kind === "resistance")
        ? "support"
        : cluster[0].kind;
    clusters.push({
      price: Number(avgPrice.toFixed(config.broker.digits ?? 2)),
      kind,
      strength: totalW,
      labels: cluster.map((l) => l.label),
      timeframes: [...new Set(cluster.map((l) => l.tf))],
      sources: [...new Set(cluster.map((l) => l.source))],
      confluence_tfs: new Set(cluster.map((l) => l.tf)).size,
    });
  }
  return clusters;
}

export function classifyZonesAtPrice(price, zones, proximityPips) {
  if (price == null) {
    return {
      supports: [],
      resistances: [],
      nearestSupport: null,
      nearestResistance: null,
      atSupport: false,
      atResistance: false,
    };
  }

  const pip = config.broker.pipSize || 0.1;
  const prox = proximityPips * pip;

  // Position relative to live price — broken levels flip role (resistance below price → support context).
  const below = zones.filter((z) => z.price <= price).sort((a, b) => b.price - a.price);
  const above = zones.filter((z) => z.price >= price).sort((a, b) => a.price - b.price);

  const nearestSupport = below[0] || null;
  const nearestResistance = above[0] || null;

  const atSupport = nearestSupport != null && Math.abs(price - nearestSupport.price) <= prox;
  const atResistance = nearestResistance != null && Math.abs(price - nearestResistance.price) <= prox;

  return {
    supports: below.slice(0, 6),
    resistances: above.slice(0, 6),
    nearestSupport,
    nearestResistance,
    atSupport,
    atResistance,
  };
}

export function inferHtfBias(htf) {
  const h4 = String(htf?.h4_trend || "").toLowerCase();
  const h1 = String(htf?.h1_trend || "").toLowerCase();
  if (h4.includes("bull") && h1.includes("bull")) return "bullish";
  if (h4.includes("bear") && h1.includes("bear")) return "bearish";
  if (h4.includes("bull") || h1.includes("bull")) return "lean_bull";
  if (h4.includes("bear") || h1.includes("bear")) return "lean_bear";
  return "neutral";
}

export function describeZoneContext({
  price,
  atSupport,
  atResistance,
  nearestSupport,
  nearestResistance,
  proximityPips,
}) {
  const notes = [];

  if (nearestSupport && price != null) {
    const distP = toPips(price - nearestSupport.price);
    notes.push(
      `Support ${nearestSupport.price} (${distP}p ${distP >= 0 ? "below" : "above"} price) str=${nearestSupport.strength} [${nearestSupport.timeframes.join(",")}]${atSupport ? " — price in zone" : ""}`,
    );
  }
  if (nearestResistance && price != null) {
    const distP = toPips(nearestResistance.price - price);
    notes.push(
      `Resistance ${nearestResistance.price} (${distP}p above price) str=${nearestResistance.strength} [${nearestResistance.timeframes.join(",")}]${atResistance ? " — price in zone" : ""}`,
    );
  }

  if (nearestSupport && nearestResistance && price != null) {
    const rangePips = toPips(nearestResistance.price - nearestSupport.price);
    if (rangePips > 0) {
      notes.push(`Range between nearest S/R: ~${rangePips}p (reference for setup area — you decide side/type)`);
    }
  }

  return { notes, proximity_pips: proximityPips };
}

export function buildMtfZoneStack({ analyses = {}, price = null, extras = {}, htf = {} }) {
  const cfg = config.mtfZones || {};
  const mergePips = cfg.mergePips ?? 8;
  const proximityPips = cfg.proximityPips ?? 5;
  const enabledTfs = cfg.timeframes ?? DEFAULT_TFS;

  let livePrice = price;
  if (livePrice == null) {
    for (const tf of ["5m", "15m", "1h", "4h", "1D"]) {
      livePrice = extractPriceFromAnalysis(analyses[tf]);
      if (livePrice != null) break;
    }
  }

  let raw = [];
  for (const tf of enabledTfs) {
    if (analyses[tf]) raw.push(...extractLevelsFromAnalysis(analyses[tf], tf));
  }
  raw.push(...extractExtraLevels(extras, livePrice));

  const merged = mergeZoneLevels(raw, mergePips);
  const classified = classifyZonesAtPrice(livePrice, merged, proximityPips);
  const htfBias = inferHtfBias(htf);
  const zoneContext = describeZoneContext({ price: livePrice, ...classified, proximityPips });

  const byTf = {};
  for (const tf of [...new Set([...enabledTfs, "1D"])]) {
    const a = analyses[tf];
    if (!a || a.error) {
      byTf[tf] = a?.error ? { error: a.error } : null;
      continue;
    }
    const sr = a.support_resistance || {};
    byTf[tf] = {
      pivot: sr.pivot ?? null,
      support_1: sr.support_1 ?? null,
      support_2: sr.support_2 ?? null,
      resistance_1: sr.resistance_1 ?? null,
      resistance_2: sr.resistance_2 ?? null,
      nearest_support: sr.nearest_support ?? null,
      nearest_resistance: sr.nearest_resistance ?? null,
    };
  }

  return {
    price: livePrice,
    merge_pips: mergePips,
    proximity_pips: proximityPips,
    htf_bias: htfBias,
    zones: merged,
    ...classified,
    by_timeframe: byTf,
    zone_context: zoneContext,
  };
}

export function formatMtfZonesForPrompt(stack) {
  if (!stack || stack.disabled) return "";
  const lines = [
    "",
    "── MTF S/R ZONE STACK (4h → 1h → 15m → 5m + PDH/PDL/Asian) ──",
    `Price: ${stack.price ?? "?"} | HTF bias: ${stack.htf_bias}`,
  ];

  if (stack.nearestSupport) {
    const ns = stack.nearestSupport;
    const dist = stack.price != null ? toPips(stack.price - ns.price) : "?";
    lines.push(
      `Nearest support: ${ns.price} (${dist}p below) strength=${ns.strength} TFs=[${ns.timeframes.join(",")}]${stack.atSupport ? " ★ AT ZONE" : ""}`,
    );
  }
  if (stack.nearestResistance) {
    const nr = stack.nearestResistance;
    const dist = stack.price != null ? toPips(nr.price - stack.price) : "?";
    lines.push(
      `Nearest resistance: ${nr.price} (${dist}p above) strength=${nr.strength} TFs=[${nr.timeframes.join(",")}]${stack.atResistance ? " ★ AT ZONE" : ""}`,
    );
  }

  for (const [label, list] of [["Support stack", stack.supports], ["Resistance stack", stack.resistances]]) {
    const top = (list || []).slice(0, 4);
    if (!top.length) continue;
    lines.push(`${label}:`);
    for (const z of top) {
      lines.push(`  ${z.price} str=${z.strength} [${z.labels.slice(0, 3).join(", ")}]`);
    }
  }

  for (const note of (stack.zone_context?.notes || [])) {
    lines.push(`  ${note}`);
  }

  lines.push(
    "Note: S/R levels are reference only — you choose setup_type, side, entry, and SL from SMC + structure.",
  );
  return lines.join("\n");
}
