/** WIB session + AMD phases from Market Structure PDF. */

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export function getWIBNow() {
  const utc = Date.now();
  const wib = new Date(utc + WIB_OFFSET_MS);
  return {
    date: wib.toISOString().slice(0, 10),
    hour: wib.getUTCHours(),
    minute: wib.getUTCMinutes(),
    label: `${String(wib.getUTCHours()).padStart(2, "0")}:${String(wib.getUTCMinutes()).padStart(2, "0")} WIB`,
  };
}

/** Asian 07–13 | London manip 14–19 | NY distrib 19–22 WIB */
export function getAMDPhase() {
  const { hour } = getWIBNow();
  if (hour >= 7 && hour < 13) return "asian_accumulation";
  if (hour >= 14 && hour < 19) return "london_manipulation";
  if (hour >= 19 && hour < 22) return "ny_distribution";
  return "off_hours";
}

/** Aligned with london_manipulation AMD phase (14:00–18:59 WIB). */
export function isLondonOpenWindow() {
  const { hour } = getWIBNow();
  return hour >= 14 && hour < 19;
}

export function isNewYorkOpenWindow() {
  const { hour } = getWIBNow();
  return hour >= 19 && hour < 22;
}

/** PDF: scalp entries during London / NY open windows */
export function isSMCTradingWindow() {
  return isLondonOpenWindow() || isNewYorkOpenWindow();
}

export function describeAMDPhase(phase = getAMDPhase()) {
  const map = {
    asian_accumulation: "Asian — accumulation / range (BSL above, SSL below range)",
    london_manipulation: "London — manipulation / stop hunt (LOD/HOD, false break)",
    ny_distribution: "New York — distribution / trend move after manip",
    off_hours: "Off hours — low edge for session-based setups",
  };
  return map[phase] || phase;
}
