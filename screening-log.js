import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";

const LOG_FILE = repoPath("screening-log.json");
const MAX = 100;

function load() {
  if (!fs.existsSync(LOG_FILE)) return { decisions: [] };
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch (error) {
    log("screening_log_warn", error.message);
    return { decisions: [] };
  }
}

function save(data) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function logProposeBlocked(result, args = {}) {
  const reason = result.reason || "unknown";
  const side = args.side ? `${args.side} ` : "";
  const summary = result.message
    || `${side}${args.setup_type || "setup"} blocked: ${reason}`;
  appendScreeningDecision({
    type: "propose_blocked",
    action: "BLOCKED",
    summary,
    reason: [
      reason,
      result.sl_pips != null ? `sl=${result.sl_pips}p` : null,
      result.min_sl_pips != null ? `min_sl=${result.min_sl_pips}p` : null,
      result.distPips != null ? `entry_dist=${result.distPips}p` : null,
      result.entry_distance_pips != null ? `entry_dist=${result.entry_distance_pips}p` : null,
    ].filter(Boolean).join(" | "),
    metrics: {
      setup_type: args.setup_type,
      side: args.side,
      entry: args.entry,
      sl: args.sl,
    },
  });
}

export function appendScreeningDecision(entry) {
  const data = load();
  const decision = {
    id: `scr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "screen",
    actor: entry.actor || "SCREENER",
    action: entry.action || null,
    setup_id: entry.setup_id || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    metrics: entry.metrics || {},
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX);
  save(data);
  return decision;
}

export function getRecentScreeningDecisions(limit = 10) {
  return (load().decisions || []).slice(0, limit);
}

export function getScreeningSummary(limit = 6) {
  const decisions = getRecentScreeningDecisions(limit);
  if (!decisions.length) return "No recent screening decisions.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.action || d.type}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.setup_id ? `setup: ${d.setup_id}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}
