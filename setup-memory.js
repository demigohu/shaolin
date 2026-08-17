/**
 * Setup memory — persistent history per thesis fingerprint.
 *
 * Keyed by thesisFingerprint (side|strategy|mode|entry|sl). Updated when
 * setups resolve. Injected into the SCREENER prompt for recall.
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { thesisFingerprint } from "./setups.js";
import { config } from "./config.js";

const FILE = repoPath("setup-memory.json");
const MAX_HISTORY = 10;

function load() {
  if (!fs.existsSync(FILE)) return { theses: {} };
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (error) {
    log("setup_memory_warn", error.message);
    return { theses: {} };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function isWin(outcome) {
  return String(outcome || "").includes("tp");
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function recomputeStats(entry) {
  const deploys = entry.setups || [];
  const wins = deploys.filter((d) => isWin(d.outcome)).length;
  entry.total_setups = deploys.length;
  entry.wins = wins;
  entry.win_rate = deploys.length ? Math.round((wins / deploys.length) * 100) : 0;
  entry.avg_pnl_pips = Math.round(avg(deploys.map((d) => d.pnl_pips)) * 10) / 10;
  entry.last_outcome = deploys.length ? deploys[deploys.length - 1].outcome : null;
  entry.last_resolved_at = deploys.length ? deploys[deploys.length - 1].resolved_at : null;
}

function maybeSetCooldown(entry) {
  const mem = config.setupMemory || {};
  const minSetups = mem.cooldownMinSetups ?? 3;
  const maxWinRate = mem.cooldownMaxWinRate ?? 25;
  const hours = mem.cooldownHours ?? 24;

  if (entry.total_setups < minSetups) return;
  if (entry.win_rate > maxWinRate) return;
  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) return;

  entry.cooldown_until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_reason = `win rate ${entry.win_rate}% over ${entry.total_setups} setups`;
  log("setup_memory", `Cooldown set for ${entry.thesis_id || entry.fingerprint}: ${entry.cooldown_reason}`);
}

export function recordSetupOutcome(setup) {
  if (!setup) return null;

  const fp = thesisFingerprint(setup);
  const db = load();

  if (!db.theses[fp]) {
    db.theses[fp] = {
      fingerprint: fp,
      thesis_id: setup.thesis_id || null,
      side: setup.side,
      mode: setup.mode,
      strategy_id: setup.strategy_id || null,
      total_setups: 0,
      wins: 0,
      win_rate: 0,
      avg_pnl_pips: 0,
      last_outcome: null,
      last_resolved_at: null,
      cooldown_until: null,
      cooldown_reason: null,
      setups: [],
    };
  }

  const entry = db.theses[fp];
  entry.thesis_id = setup.thesis_id || entry.thesis_id;
  entry.setups.push({
    setup_id: setup.id,
    outcome: setup.outcome,
    pnl_pips: setup.pnl_pips ?? 0,
    confidence: setup.confidence ?? null,
    rr_ratio: setup.rr_ratio ?? null,
    session: setup.session || null,
    resolved_at: setup.resolved_at || new Date().toISOString(),
    signal_snapshot: setup.screening_snapshot || setup.signal_snapshot || null,
  });

  if (entry.setups.length > MAX_HISTORY) {
    entry.setups = entry.setups.slice(-MAX_HISTORY);
  }

  recomputeStats(entry);
  maybeSetCooldown(entry);
  save(db);

  log("setup_memory", `Recorded ${setup.id} for ${entry.thesis_id || fp}: ${setup.outcome} (${setup.pnl_pips ?? 0} pips)`);
  return entry;
}

export function getThesisMemory(candidate) {
  const fp = typeof candidate === "string" ? candidate : thesisFingerprint(candidate);
  const entry = load().theses[fp];
  if (!entry) return null;
  return {
    ...entry,
    on_cooldown: !!(entry.cooldown_until && new Date(entry.cooldown_until) > new Date()),
  };
}

export function isThesisOnCooldown(candidate) {
  const mem = getThesisMemory(candidate);
  return mem?.on_cooldown === true;
}

export function recallForThesis(candidate) {
  const entry = getThesisMemory(candidate);
  if (!entry) return null;

  const lines = [
    `THESIS MEMORY [${entry.thesis_id || entry.fingerprint}]: ${entry.total_setups} past setup(s), win rate ${entry.win_rate}%, avg ${entry.avg_pnl_pips} pips, last: ${entry.last_outcome}`,
  ];

  if (entry.on_cooldown) {
    lines.push(`THESIS COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  const recent = (entry.setups || []).slice(-3);
  if (recent.length) {
    lines.push(`RECENT: ${recent.map((s) => `${s.outcome} (${s.pnl_pips ?? 0} pips)`).join(", ")}`);
  }

  return lines.join("\n");
}

export function getSetupMemorySummary(limit = 5) {
  const theses = Object.values(load().theses || {})
    .sort((a, b) => String(b.last_resolved_at || "").localeCompare(String(a.last_resolved_at || "")))
    .slice(0, limit);

  if (!theses.length) return "No thesis history yet.";

  return theses.map((entry, i) => {
    const cooldown = entry.cooldown_until && new Date(entry.cooldown_until) > new Date()
      ? " [COOLDOWN]"
      : "";
    return `${i + 1}. ${entry.thesis_id || entry.fingerprint}: ${entry.total_setups} setups, ${entry.win_rate}% win, avg ${entry.avg_pnl_pips} pips${cooldown}`;
  }).join("\n");
}
