/**
 * Feed/LLM health: each subsystem reports success or failure; an outage longer than
 * its threshold raises one Telegram alert, and the first success after it a recovery.
 */

import { config } from "./config.js";

const DEFAULT_THRESHOLD_MIN = { price: 10, candles: 20, llm: 45 };
const LABEL = { price: "Price feed (TradingView)", candles: "Candles (Twelve Data / Yahoo)", llm: "LLM (screener / planner)" };
const state = new Map();

function entry(name) {
  if (!state.has(name)) state.set(name, { lastOk: null, lastError: null, failingSince: null, alerted: false });
  return state.get(name);
}

export function markOk(name, now = Date.now()) {
  const s = entry(name);
  s.lastOk = now;
  s.failingSince = null;
  if (s.alerted) {
    s.alerted = false;
    s.recovered = now;
  }
}

export function markFail(name, error, now = Date.now()) {
  const s = entry(name);
  s.lastError = String(error?.message ?? error ?? "unknown").slice(0, 160);
  s.failingSince ??= now;
}

const thresholdMin = (name) => config.health?.thresholdMin?.[name] ?? DEFAULT_THRESHOLD_MIN[name] ?? 15;
const ago = (ms, now) => `${Math.round((now - ms) / 60000)}m`;

/** Messages to send now: new outages past their threshold, and recoveries since the last check. */
export function collectHealthAlerts(now = Date.now()) {
  const out = [];
  for (const [name, s] of state) {
    if (s.failingSince != null && !s.alerted && now - s.failingSince >= thresholdMin(name) * 60_000) {
      s.alerted = true;
      out.push(`🚨 ${LABEL[name] ?? name} failing for ${ago(s.failingSince, now)} — ${s.lastError ?? "no detail"}${s.lastOk ? ` (last OK ${ago(s.lastOk, now)} ago)` : ""}`);
    }
    if (s.recovered) {
      out.push(`✅ ${LABEL[name] ?? name} recovered`);
      s.recovered = null;
    }
  }
  return out;
}

export function formatHealth(now = Date.now()) {
  if (!state.size) return "Health: no checks recorded yet.";
  const lines = ["🩺 Health"];
  for (const [name, s] of state) {
    const status = s.failingSince != null ? `❌ failing ${ago(s.failingSince, now)} — ${s.lastError}` : "✅ OK";
    lines.push(`${LABEL[name] ?? name}: ${status}${s.lastOk ? ` · last OK ${ago(s.lastOk, now)} ago` : ""}`);
  }
  return lines.join("\n");
}

/** Test hook. */
export function resetHealth() {
  state.clear();
}
