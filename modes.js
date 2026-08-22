import { config } from "./config.js";

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

export function getCurrentSession() {
  const hour = new Date().getUTCHours();
  if (hour >= 7 && hour < 12) return "london";
  if (hour >= 12 && hour < 17) return "overlap";
  if (hour >= 13 && hour < 21) return "new_york";
  if (hour >= 0 && hour < 7) return "asian";
  return "off_hours";
}

/** XAUUSD spot/CFD — no new liquidity Sat/Sun (UTC). */
export function isWeekendMarketClosed() {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

export function isSessionAllowed(mode = getActiveMode()) {
  const sessions = mode.sessions || ["any"];
  if (sessions.includes("any")) return true;
  const current = getCurrentSession();
  if (sessions.includes("overlap") && current === "overlap") return true;
  return sessions.includes(current);
}

export function switchMode(modeId) {
  if (!config.modes[modeId]) throw new Error(`Unknown mode: ${modeId}`);
  config.activeMode = modeId;
  return getActiveMode();
}
