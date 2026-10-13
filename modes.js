import { config, saveUserConfigPatch } from "./config.js";
import { zonedTime } from "./smc-sessions.js";

export function getActiveMode() {
  const id = config.activeMode;
  const mode = config.modes[id];
  if (!mode) throw new Error(`Unknown mode: ${id}`);
  return { id, ...mode };
}

export function getModeIntervals() {
  const mode = getActiveMode();
  return {
    screeningIntervalMin: mode.screeningIntervalMin,
    managementIntervalMin: mode.managementIntervalMin,
  };
}

/**
 * Sessions open right now: asian 00–07 UTC, london 08–17 London time,
 * new_york 08–17 New York time (DST-aware).
 */
export function getActiveSessions(now = new Date()) {
  const sessions = [];
  if (now.getUTCHours() < 7) sessions.push("asian");
  const london = zonedTime("Europe/London", now).hour;
  if (london >= 8 && london < 17) sessions.push("london");
  const ny = zonedTime("America/New_York", now).hour;
  if (ny >= 8 && ny < 17) sessions.push("new_york");
  return sessions;
}

export function getCurrentSession(now = new Date()) {
  const active = getActiveSessions(now);
  if (active.includes("london") && active.includes("new_york")) return "overlap";
  return active[0] || "off_hours";
}

/** Spot gold trades Sunday 18:00 → Friday 17:00 New York time. */
export function isWeekendMarketClosed(now = new Date()) {
  const { weekday, hour } = zonedTime("America/New_York", now);
  if (weekday === 6) return true;
  if (weekday === 5 && hour >= 17) return true;
  if (weekday === 0 && hour < 18) return true;
  return false;
}

export function isSessionAllowed(mode = getActiveMode(), now = new Date()) {
  const allowed = mode.sessions || ["any"];
  if (allowed.includes("any")) return true;
  const active = getActiveSessions(now);
  if (allowed.includes("overlap") && getCurrentSession(now) === "overlap") return true;
  return active.some((s) => allowed.includes(s));
}

export function switchMode(modeId, { persist = true } = {}) {
  if (!config.modes[modeId]) throw new Error(`Unknown mode: ${modeId}. Use: ${Object.keys(config.modes).join(", ")}`);
  config.activeMode = modeId;
  if (persist) saveUserConfigPatch({ activeMode: modeId });
  return getActiveMode();
}
