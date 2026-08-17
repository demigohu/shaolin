import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";

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

export function recordSetupOutcome(setup) {
  const data = load();
  data.performance.unshift({
    setup_id: setup.id,
    side: setup.side,
    mode: setup.mode,
    outcome: setup.outcome,
    pnl_pips: setup.pnl_pips,
    max_rr_reached: setup.max_rr_reached,
    confidence: setup.confidence,
    rr_ratio: setup.rr_ratio,
    resolved_at: setup.resolved_at,
    partial_filled: setup.partial_filled || [],
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
  return rule;
}

function deriveLesson(setup) {
  const win = setup.outcome?.includes("tp");
  const mode = setup.mode || "unknown";
  if (win) return `[WORKED @ ${mode}] ${setup.side} setup ${setup.id}: ${setup.outcome} (+${setup.pnl_pips ?? 0} pips)`;
  if (setup.outcome === "sl_hit") return `[FAILED @ ${mode}] ${setup.side} stopped out (${setup.pnl_pips ?? 0} pips)`;
  if (setup.outcome === "expired") return `[AVOID @ ${mode}] Setup expired without activation`;
  return null;
}

export function getLessonsForPrompt(limit = 5) {
  const data = load();
  return (data.lessons || []).slice(0, limit).map((l) => l.rule).join("\n") || "No lessons yet.";
}

export function getPerformanceSummary() {
  const perf = load().performance || [];
  if (!perf.length) return "No closed setups yet.";
  const wins = perf.filter((p) => String(p.outcome).includes("tp")).length;
  return `${perf.length} resolved setups | win rate ${((wins / perf.length) * 100).toFixed(0)}%`;
}
