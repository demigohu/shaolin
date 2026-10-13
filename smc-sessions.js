/**
 * Session clock. London / New York windows follow local time in those cities,
 * so daylight-saving shifts are handled; the Asian range stays fixed at
 * 00:00–06:00 UTC (07–13 WIB, Tokyo has no DST). Labels are shown in WIB.
 */

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const formatters = new Map();

/** Local wall-clock parts of `now` in an IANA timezone. */
export function zonedTime(timeZone, now = new Date()) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", weekday: "short", hour: "numeric", minute: "numeric",
    }));
  }
  const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) + Number(parts.minute) / 60;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { hour, weekday };
}

/** UTC offset (hours) of a timezone at `now`. */
export function tzOffsetHours(timeZone, now = new Date()) {
  let diff = zonedTime(timeZone, now).hour - (now.getUTCHours() + now.getUTCMinutes() / 60);
  if (diff > 12) diff -= 24;
  if (diff < -12) diff += 24;
  return Math.round(diff);
}

// AMD windows in local exchange time.
const LONDON_KILLZONE = { tz: "Europe/London", start: 8, end: 13 };
const NEW_YORK_KILLZONE = { tz: "America/New_York", start: 8, end: 11 };

const inWindow = (w, now) => {
  const { hour } = zonedTime(w.tz, now);
  return hour >= w.start && hour < w.end;
};

export function getWIBNow(now = new Date()) {
  const wib = new Date(now.getTime() + WIB_OFFSET_MS);
  return {
    date: wib.toISOString().slice(0, 10),
    hour: wib.getUTCHours(),
    minute: wib.getUTCMinutes(),
    label: `${String(wib.getUTCHours()).padStart(2, "0")}:${String(wib.getUTCMinutes()).padStart(2, "0")} WIB`,
  };
}

export function isLondonOpenWindow(now = new Date()) {
  return inWindow(LONDON_KILLZONE, now);
}

export function isNewYorkOpenWindow(now = new Date()) {
  return inWindow(NEW_YORK_KILLZONE, now);
}

/** PDF: scalp entries during London / NY open windows */
export function isSMCTradingWindow(now = new Date()) {
  return isLondonOpenWindow(now) || isNewYorkOpenWindow(now);
}

/** Asian accumulation 07–13 WIB | London manipulation 08–13 London | NY distribution 08–11 New York */
export function getAMDPhase(now = new Date()) {
  if (isNewYorkOpenWindow(now)) return "ny_distribution";
  if (isLondonOpenWindow(now)) return "london_manipulation";
  if (now.getUTCHours() < 6) return "asian_accumulation";
  return "off_hours";
}

/** Today's killzones expressed in WIB, e.g. "London 14–19 WIB / NY 19–22 WIB" (shifts with DST). */
export function describeTradingWindowsWib(now = new Date()) {
  const toWib = (w) => {
    const shift = 7 - tzOffsetHours(w.tz, now);
    const fmt = (h) => String((h + shift + 24) % 24).padStart(2, "0");
    return `${fmt(w.start)}–${fmt(w.end)}`;
  };
  return `London ${toWib(LONDON_KILLZONE)} / NY ${toWib(NEW_YORK_KILLZONE)} WIB`;
}

/**
 * UTC window of the Asian range (07:00–13:00 WIB = 00:00–06:00 UTC) that is
 * relevant now: today's once it has started, otherwise the previous day's.
 */
export function getAsianWindowUtc(now = new Date()) {
  const { date, hour } = getWIBNow(now);
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const start = hour < 7 ? dayStart - 24 * 60 * 60 * 1000 : dayStart;
  return { start, end: start + 6 * 60 * 60 * 1000, date: new Date(start).toISOString().slice(0, 10) };
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
