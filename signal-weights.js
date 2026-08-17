/**
 * Darwinian signal weighting for XAUUSD screening signals.
 *
 * Tracks which screening signals predict profitable setups and adjusts
 * weights over time. Persisted in signal-weights.json and injected into
 * the SCREENER prompt.
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const WEIGHTS_FILE = repoPath("signal-weights.json");

const SIGNAL_NAMES = [
  "mtf_net_score",
  "mtf_alignment_confidence",
  "mtf_divergent_count",
  "combined_signals_agree",
  "news_sentiment_score",
  "rsi",
  "trend_strength",
  "setup_confidence",
  "rr_ratio",
];

const DEFAULT_WEIGHTS = Object.fromEntries(SIGNAL_NAMES.map((s) => [s, 1.0]));

const HIGHER_IS_BETTER = new Set([
  "mtf_net_score",
  "mtf_alignment_confidence",
  "combined_signals_agree",
  "news_sentiment_score",
  "trend_strength",
  "setup_confidence",
  "rr_ratio",
]);

const LOWER_IS_BETTER = new Set(["mtf_divergent_count"]);

const CATEGORICAL_SIGNALS = new Set(["session"]);

function loadWeights() {
  if (!fs.existsSync(WEIGHTS_FILE)) {
    const initial = {
      weights: { ...DEFAULT_WEIGHTS },
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
    saveWeights(initial);
    log("signal_weights", "Created signal-weights.json with default weights");
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
  } catch (error) {
    log("signal_weights_error", `Failed to read signal-weights.json: ${error.message}`);
    return {
      weights: { ...DEFAULT_WEIGHTS },
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
  }
}

function saveWeights(data) {
  try {
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    log("signal_weights_error", `Failed to write signal-weights.json: ${error.message}`);
  }
}

export function recalculateWeights(perfData, cfg = {}) {
  const darwin = cfg.darwin || {};
  const windowDays = darwin.windowDays ?? 60;
  const minSamples = darwin.minSamples ?? 8;
  const boostFactor = darwin.boostFactor ?? 1.05;
  const decayFactor = darwin.decayFactor ?? 0.95;
  const weightFloor = darwin.weightFloor ?? 0.3;
  const weightCeiling = darwin.weightCeiling ?? 2.5;

  const data = loadWeights();
  const weights = data.weights || { ...DEFAULT_WEIGHTS };

  for (const name of SIGNAL_NAMES) {
    if (weights[name] == null) weights[name] = 1.0;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffISO = cutoff.toISOString();

  const recent = perfData.filter((p) => {
    const ts = p.resolved_at || p.recorded_at;
    return ts && ts >= cutoffISO;
  });

  if (recent.length < minSamples) {
    log("signal_weights", `Only ${recent.length} records in ${windowDays}d window (need ${minSamples}), skipping recalc`);
    return { changes: [], weights };
  }

  const wins = recent.filter((p) => (p.pnl_pips ?? 0) > 0);
  const losses = recent.filter((p) => (p.pnl_pips ?? 0) <= 0);

  if (!wins.length || !losses.length) {
    log("signal_weights", `Need both wins (${wins.length}) and losses (${losses.length}) to compute lift, skipping`);
    return { changes: [], weights };
  }

  const lifts = {};
  for (const signal of SIGNAL_NAMES) {
    const lift = computeLift(signal, wins, losses, minSamples);
    if (lift !== null) lifts[signal] = lift;
  }

  const ranked = Object.entries(lifts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) {
    log("signal_weights", "No signals had enough samples for lift calculation");
    return { changes: [], weights };
  }

  const q1End = Math.ceil(ranked.length * 0.25);
  const q3Start = Math.floor(ranked.length * 0.75);
  const topQuartile = new Set(ranked.slice(0, q1End).map(([name]) => name));
  const bottomQuartile = new Set(ranked.slice(q3Start).map(([name]) => name));

  const changes = [];
  for (const [signal, lift] of ranked) {
    const prev = weights[signal];
    let next = prev;

    if (topQuartile.has(signal)) {
      next = Math.min(prev * boostFactor, weightCeiling);
    } else if (bottomQuartile.has(signal)) {
      next = Math.max(prev * decayFactor, weightFloor);
    }

    next = Math.round(next * 1000) / 1000;
    if (next !== prev) {
      const dir = next > prev ? "boosted" : "decayed";
      changes.push({ signal, from: prev, to: next, lift: Math.round(lift * 1000) / 1000, action: dir });
      weights[signal] = next;
      log("signal_weights", `${signal}: ${prev} -> ${next} (${dir}, lift=${lift.toFixed(3)})`);
    }
  }

  data.weights = weights;
  data.last_recalc = new Date().toISOString();
  data.recalc_count = (data.recalc_count || 0) + 1;
  if (!data.history) data.history = [];
  if (changes.length) {
    data.history.push({
      timestamp: data.last_recalc,
      changes,
      window_size: recent.length,
      win_count: wins.length,
      loss_count: losses.length,
    });
    if (data.history.length > 20) data.history = data.history.slice(-20);
  }
  saveWeights(data);

  return { changes, weights };
}

function computeLift(signal, wins, losses, minSamples) {
  if (CATEGORICAL_SIGNALS.has(signal)) return computeCategoricalLift(signal, wins, losses, minSamples);
  return computeNumericLift(signal, wins, losses, minSamples);
}

function computeNumericLift(signal, wins, losses, minSamples) {
  const winVals = extractNumeric(signal, wins);
  const lossVals = extractNumeric(signal, losses);
  if (winVals.length + lossVals.length < minSamples) return null;
  if (!winVals.length || !lossVals.length) return null;

  const all = [...winVals, ...lossVals];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min;
  if (range === 0) return 0;

  const normalize = (v) => (v - min) / range;
  const winMean = mean(winVals.map(normalize));
  const lossMean = mean(lossVals.map(normalize));

  if (HIGHER_IS_BETTER.has(signal)) return winMean - lossMean;
  if (LOWER_IS_BETTER.has(signal)) return lossMean - winMean;
  return Math.abs(winMean - lossMean);
}

function computeCategoricalLift(signal, wins, losses, minSamples) {
  const allEntries = [
    ...wins.map((w) => ({ win: true, snap: w })),
    ...losses.map((l) => ({ win: false, snap: l })),
  ];
  const buckets = {};

  for (const { win, snap } of allEntries) {
    const val = getEntrySignalSnapshot(snap)?.[signal];
    if (val == null) continue;
    if (!buckets[val]) buckets[val] = { wins: 0, total: 0 };
    buckets[val].total++;
    if (win) buckets[val].wins++;
  }

  const totalSamples = Object.values(buckets).reduce((sum, b) => sum + b.total, 0);
  if (totalSamples < minSamples) return null;

  const rates = Object.values(buckets)
    .filter((b) => b.total >= 2)
    .map((b) => b.wins / b.total);
  if (rates.length < 2) return null;
  return Math.max(...rates) - Math.min(...rates);
}

function extractNumeric(signal, entries) {
  const vals = [];
  for (const entry of entries) {
    const snap = getEntrySignalSnapshot(entry);
    if (!snap) continue;
    const v = snap[signal];
    if (v != null && typeof v === "number" && Number.isFinite(v)) vals.push(v);
  }
  return vals;
}

function getEntrySignalSnapshot(entry) {
  if (entry.signal_snapshot) return entry.signal_snapshot;
  if (entry.screening_snapshot && Object.keys(entry.screening_snapshot).length) {
    return entry.screening_snapshot;
  }
  const snapshot = {};
  for (const signal of [...SIGNAL_NAMES, ...CATEGORICAL_SIGNALS]) {
    if (entry[signal] != null) snapshot[signal] = entry[signal];
  }
  return Object.keys(snapshot).length ? snapshot : null;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

export function getWeightsSummary() {
  const data = loadWeights();
  const w = data.weights || {};

  const lines = ["Signal Weights (Darwinian — learned from closed setups):"];
  const sorted = SIGNAL_NAMES
    .filter((s) => w[s] != null)
    .sort((a, b) => (w[b] ?? 1) - (w[a] ?? 1));

  for (const signal of sorted) {
    const val = w[signal] ?? 1.0;
    lines.push(`  ${signal.padEnd(26)} ${val.toFixed(2)}  ${weightBar(val)}  ${interpretWeight(val)}`);
  }

  if (data.last_recalc) {
    lines.push(`\nLast recalculated: ${data.last_recalc} (${data.recalc_count || 0} total)`);
  } else {
    lines.push("\nWeights have not been recalculated yet (using defaults).");
  }

  return lines.join("\n");
}

function interpretWeight(val) {
  if (val >= 1.8) return "[STRONG]";
  if (val >= 1.2) return "[above avg]";
  if (val >= 0.8) return "[neutral]";
  if (val >= 0.5) return "[below avg]";
  return "[weak]";
}

function weightBar(val) {
  const filled = Math.round(((val - 0.3) / (2.5 - 0.3)) * 10);
  const clamped = Math.max(0, Math.min(10, filled));
  return "#".repeat(clamped) + ".".repeat(10 - clamped);
}
