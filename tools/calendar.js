/**
 * Economic calendar (Forex Factory weekly feed) → news blackout around
 * high-impact releases (CPI, NFP, FOMC, Fed speakers...) that move gold.
 *
 * Feed: https://nfs.faireconomy.media/ff_calendar_thisweek.json
 * Events: { title, country, date (ISO with offset), impact, forecast, previous }
 * The feed is rate-limited, so it is cached for an hour.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { getJsonWithProxyFallback } from "./http.js";

const FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CACHE_MS = 60 * 60_000;

let cache = null;

export function normalizeEvents(raw, cfg = config.calendar) {
  const currencies = new Set(cfg?.currencies ?? ["USD"]);
  const impacts = new Set(cfg?.impacts ?? ["High"]);
  return (Array.isArray(raw) ? raw : [])
    .filter((e) => currencies.has(e.country) && impacts.has(e.impact))
    .map((e) => ({
      title: String(e.title || "").trim(),
      currency: e.country,
      impact: e.impact,
      time: Date.parse(e.date),
      forecast: e.forecast || null,
      previous: e.previous || null,
    }))
    .filter((e) => e.title && Number.isFinite(e.time))
    .sort((a, b) => a.time - b.time);
}

/** Filtered events of the current week; stale cache is reused if the feed fails. */
export async function getCalendarEvents() {
  if (config.calendar?.enabled === false) return [];
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.events;
  try {
    const events = normalizeEvents(await getJsonWithProxyFallback(FEED_URL));
    cache = { at: Date.now(), events };
    return events;
  } catch (error) {
    log("calendar_warn", `Forex Factory feed failed: ${error.message}${cache ? " — using last fetch" : ""}`);
    return cache?.events ?? [];
  }
}

/** Event whose blackout window [time - before, time + after] contains `now`, if any. */
export function findBlackout(events, now = Date.now(), cfg = config.calendar) {
  const before = (cfg?.blackoutBeforeMin ?? 15) * 60_000;
  const after = (cfg?.blackoutAfterMin ?? 15) * 60_000;
  return events.find((e) => now >= e.time - before && now <= e.time + after) || null;
}

export function upcomingEvents(events, now = Date.now(), hours = 24) {
  return events.filter((e) => e.time >= now - 30 * 60_000 && e.time <= now + hours * 3_600_000);
}

function fmtWib(ms) {
  const d = new Date(ms + 7 * 3_600_000);
  const days = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
  return `${days[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} WIB`;
}

export function fmtIn(ms, now = Date.now()) {
  const min = Math.round((ms - now) / 60_000);
  if (min < 0) return `${-min}m ago`;
  if (min < 60) return `in ${min}m`;
  return `in ${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`;
}

export function formatEvent(e, now = Date.now()) {
  const fc = [e.forecast && `f ${e.forecast}`, e.previous && `p ${e.previous}`].filter(Boolean).join(" / ");
  return `${e.currency} ${e.title} — ${fmtWib(e.time)} (${fmtIn(e.time, now)})${fc ? ` [${fc}]` : ""}`;
}

export function formatCalendarForPrompt(events, now = Date.now()) {
  if (config.calendar?.enabled === false) return "";
  const next = upcomingEvents(events, now, 24);
  const lines = [`── ECONOMIC CALENDAR (${(config.calendar?.impacts ?? ["High"]).join("/")} impact ${(config.calendar?.currencies ?? ["USD"]).join("/")}, next 24h) ──`];
  if (!next.length) lines.push("No scheduled high-impact events in the next 24h.");
  for (const e of next.slice(0, 8)) lines.push(`  ${formatEvent(e, now)}`);
  lines.push(`New setups are blocked from ${config.calendar?.blackoutBeforeMin ?? 15}m before to ${config.calendar?.blackoutAfterMin ?? 15}m after each event. Keep TPs realistic if a setup would still be open at release time.`);
  return lines.join("\n");
}

export function checkNewsBlackout(events, now = Date.now()) {
  const e = findBlackout(events, now);
  if (!e) return { ok: true };
  return {
    ok: false,
    reason: "news_blackout",
    event: e.title,
    message: `News blackout: ${formatEvent(e, now)} — no new setups until ${config.calendar?.blackoutAfterMin ?? 15}m after the release.`,
  };
}
