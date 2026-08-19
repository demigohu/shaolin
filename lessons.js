import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { recordSetupOutcome as recordSetupMemory } from "./setup-memory.js";
import { recalculateWeights } from "./signal-weights.js";

const FILE = repoPath("lessons.json");
const MIN_EVOLVE_SETUPS = 5;

function load() {
  if (!fs.existsSync(FILE)) return { lessons: [], performance: [] };
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (error) {
    log("lessons_warn", error.message);
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function buildSignalSnapshot(setup) {
  const snapshot = { ...(setup.screening_snapshot || setup.signal_snapshot || {}) };
  if (setup.confidence != null && snapshot.setup_confidence == null) {
    snapshot.setup_confidence = setup.confidence;
  }
  if (setup.rr_ratio != null && snapshot.rr_ratio == null) {
    snapshot.rr_ratio = setup.rr_ratio;
  }
  if (setup.session && snapshot.session == null) {
    snapshot.session = setup.session;
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

export function recordSetupOutcome(setup) {
  const data = load();
  const signalSnapshot = buildSignalSnapshot(setup);

  data.performance.unshift({
    setup_id: setup.id,
    side: setup.side,
    mode: setup.mode,
    setup_type: setup.setup_type || null,
    entry_style: setup.entry_style || null,
    entry_distance_pips: setup.entry_distance_pips ?? null,
    outcome: setup.outcome,
    pnl_pips: setup.pnl_pips,
    max_rr_reached: setup.max_rr_reached,
    confidence: setup.confidence,
    rr_ratio: setup.rr_ratio,
    session: setup.session || null,
    thesis_id: setup.thesis_id || null,
    strategy_id: setup.strategy_id || null,
    resolved_at: setup.resolved_at,
    partial_filled: setup.partial_filled || [],
    signal_snapshot: signalSnapshot,
    recorded_at: new Date().toISOString(),
  });
  data.performance = data.performance.slice(0, 200);

  const rule = deriveLesson(setup);
  if (rule) {
    data.lessons.unshift({
      id: `les_${Date.now()}`,
      rule,
      tags: [setup.mode, setup.side, setup.outcome],
      created_at: new Date().toISOString(),
    });
    data.lessons = data.lessons.slice(0, 100);
  }
  save(data);

  recordSetupMemory(setup);

  const recalcEvery = config.darwin?.recalcEveryN ?? MIN_EVOLVE_SETUPS;
  if (config.darwin?.enabled !== false && data.performance.length % recalcEvery === 0) {
    const wResult = recalculateWeights(data.performance, config);
    if (wResult.changes.length) {
      log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
    }
  }

  return rule;
}

function deriveLesson(setup) {
  const mode = setup.mode || "unknown";
  const type = setup.setup_type || "unknown";
  const style = setup.entry_style || "?";
  const dist = setup.entry_distance_pips;
  const rsi = setup.screening_snapshot?.rsi;
  const rsiNote = typeof rsi === "number" ? ` RSI ${rsi}` : "";
  const distNote = dist != null ? ` entry ${dist}p from price at propose` : "";
  const conf = setup.confluence_factors?.length
    ? ` [${setup.confluence_factors.join(", ")}]`
    : "";

  const win = setup.outcome?.includes("tp");
  if (win) {
    return `[WORKED @ ${mode}] ${type} ${style} ${setup.side}${conf}${distNote}${rsiNote}: ${setup.outcome} (+${setup.pnl_pips ?? 0}p)`;
  }
  if (setup.outcome === "sl_hit" || setup.outcome === "tp_partial_then_sl") {
    return `[FAILED @ ${mode}] ${type} ${style} ${setup.side}${conf}${distNote}${rsiNote}: stopped (${setup.pnl_pips ?? 0}p)`;
  }
  if (setup.outcome === "stale_no_fill") {
    return `[AVOID @ ${mode}] ${type} limit${distNote} — price never reached entry (stale ${setup.stale_distance_pips ?? "?"}p away)`;
  }
  if (setup.outcome === "invalidated_pre_fill") {
    return `[AVOID @ ${mode}] ${type} limit ${setup.side} — SL hit before entry zone filled`;
  }
  if (setup.outcome === "expired") {
    return `[AVOID @ ${mode}] ${type} expired without fill — entry was likely too late or too far`;
  }
  return null;
}

export function getLessonsForPrompt(limit = 8) {
  const data = load();
  return (data.lessons || []).slice(0, limit).map((l) => l.rule).join("\n") || "No lessons yet.";
}

export function getPerformanceSummary() {
  const perf = load().performance || [];
  if (!perf.length) return "No closed setups yet.";
  const wins = perf.filter((p) => String(p.outcome).includes("tp")).length;
  return `${perf.length} resolved setups | win rate ${((wins / perf.length) * 100).toFixed(0)}%`;
}
