import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { recordSetupOutcome as recordSetupMemory, isTrade } from "./setup-memory.js";

const FILE = repoPath("lessons.json");

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
  const snapshot = { ...(setup.screening_snapshot || {}) };
  snapshot.setup_confidence ??= setup.confidence ?? null;
  snapshot.rr_ratio ??= setup.rr_ratio ?? null;
  snapshot.session ??= setup.session ?? null;
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

export function recordSetupOutcome(setup) {
  if (!setup || setup.outcome === "cancelled") return null;
  const data = load();
  const record = {
    setup_id: setup.id,
    side: setup.side,
    mode: setup.mode,
    setup_type: setup.setup_type || null,
    confluence_factors: setup.confluence_factors || [],
    entry_style: setup.entry_style || null,
    entry_distance_pips: setup.entry_distance_pips ?? null,
    filled: Boolean(setup.activated_at),
    outcome: setup.outcome,
    pnl_pips: setup.pnl_pips ?? 0,
    max_rr_reached: setup.max_rr_reached,
    confidence: setup.confidence,
    rr_ratio: setup.rr_ratio,
    session: setup.session || null,
    resolved_at: setup.resolved_at,
    partial_filled: setup.partial_filled || [],
    signal_snapshot: buildSignalSnapshot(setup),
    recorded_at: new Date().toISOString(),
  };
  data.performance.unshift(record);
  data.performance = data.performance.slice(0, 200);

  const rule = deriveLesson(setup);
  if (rule) {
    data.lessons.unshift({ id: `les_${Date.now()}`, rule, tags: [setup.mode, setup.side, setup.outcome], created_at: new Date().toISOString() });
    data.lessons = data.lessons.slice(0, 100);
  }

  save(data);
  recordSetupMemory(setup);
  return rule;
}

function deriveLesson(setup) {
  const mode = setup.mode || "unknown";
  const type = setup.setup_type || "unknown";
  const style = setup.entry_style || "?";
  const dist = setup.entry_distance_pips;
  const rsi = setup.screening_snapshot?.rsi;
  const rsiNote = typeof rsi === "number" ? ` RSI ${rsi.toFixed(1)}` : "";
  const distNote = dist != null ? ` entry ${dist}p from price at propose` : "";
  const conf = setup.confluence_factors?.length ? ` [${setup.confluence_factors.join(", ")}]` : "";
  const pnl = setup.pnl_pips ?? 0;
  const head = `${type} ${style} ${setup.side}${conf}${distNote}${rsiNote}`;

  switch (setup.outcome) {
    case "tp_hit":
    case "tp_full":
      return `[WORKED @ ${mode}] ${head}: ${setup.outcome} (+${pnl}p)`;
    case "tp_partial_then_sl":
      return `[${pnl > 0 ? "PARTIAL WIN" : "FAILED"} @ ${mode}] ${head}: TP partial then SL (${pnl}p)`;
    case "sl_hit":
      return `[FAILED @ ${mode}] ${head}: stopped (${pnl}p, max RR reached ${setup.max_rr_reached ?? 0})`;
    case "time_exit":
      return `[TIME STOP @ ${mode}] ${head}: no follow-through, closed at ${pnl}p`;
    case "invalidated":
      return setup.activated_at ? `[FLIPPED @ ${mode}] ${head}: closed by opposite thesis (${pnl}p)` : null;
    case "stale_no_fill":
      return `[AVOID @ ${mode}] ${type} limit${distNote} — price ran away without fill (${setup.stale_distance_pips ?? "?"}p)`;
    case "invalidated_pre_fill":
      return `[AVOID @ ${mode}] ${type} limit ${setup.side} — SL hit before entry filled`;
    case "expired":
      return `[AVOID @ ${mode}] ${type} ${style} expired without fill — entry too far or too late`;
    default:
      return null;
  }
}

export function getPerformanceRecords() {
  return load().performance || [];
}

export function getLessonsForPrompt(limit = 8) {
  return (load().lessons || []).slice(0, limit).map((l) => l.rule).join("\n") || "No lessons yet.";
}

export function getPerformanceSummary() {
  const perf = load().performance || [];
  if (!perf.length) return "No closed setups yet.";
  const trades = perf.filter(isTrade);
  const unfilled = perf.length - trades.length;
  if (!trades.length) return `0 filled trades (${unfilled} unfilled setups)`;
  const wins = trades.filter((p) => (p.pnl_pips ?? 0) > 0).length;
  const net = trades.reduce((s, p) => s + (p.pnl_pips ?? 0), 0);
  return `${trades.length} trades | win rate ${Math.round((wins / trades.length) * 100)}% | net ${Math.round(net * 10) / 10} pips | ${unfilled} unfilled`;
}
