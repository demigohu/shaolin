/** Persist Asian session range (high/low) for liquidity framework. */

import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { getAMDPhase, getWIBNow } from "./smc-sessions.js";

const FILE = repoPath("smc-state.json");

function load() {
  if (!fs.existsSync(FILE)) {
    return { asianRange: null, lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (error) {
    log("smc_state_warn", error.message);
    return { asianRange: null, lastUpdated: null };
  }
}

function save(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function getAsianRange() {
  const data = load();
  const { date, hour } = getWIBNow();
  const range = data.asianRange;
  if (!range) return null;
  if (range.date === date) return range;
  // 00:00–06:59 WIB: keep prior session range until today's Asian builds (07:00+).
  if (hour < 7) {
    return { ...range, carried_over: true, carry_from: range.date };
  }
  return null;
}

export function updateAsianRange(price) {
  if (price == null || !Number.isFinite(Number(price))) return null;
  const p = Number(price);
  const phase = getAMDPhase();
  const { date } = getWIBNow();
  const data = load();

  if (phase === "asian_accumulation" || (phase === "london_manipulation" && getWIBNow().hour === 14)) {
    if (!data.asianRange || data.asianRange.date !== date) {
      data.asianRange = { date, high: p, low: p, samples: 1 };
    } else {
      data.asianRange.high = Math.max(data.asianRange.high, p);
      data.asianRange.low = Math.min(data.asianRange.low, p);
      data.asianRange.samples = (data.asianRange.samples || 0) + 1;
    }
    save(data);
    return data.asianRange;
  }

  return data.asianRange?.date === date ? data.asianRange : null;
}
