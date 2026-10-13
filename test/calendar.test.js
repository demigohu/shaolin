import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { config } from "../config.js";
import { normalizeEvents, findBlackout, checkNewsBlackout, upcomingEvents, fmtIn } from "../tools/calendar.js";

config.calendar = { enabled: true, currencies: ["USD"], impacts: ["High"], blackoutBeforeMin: 15, blackoutAfterMin: 15, warnOpenSetupMin: 30 };

const raw = [
  { title: "CPI m/m", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "0.6%", previous: "0.4%" },
  { title: "German ZEW", country: "EUR", date: "2026-10-14T05:00:00-04:00", impact: "High" },
  { title: "Crude Oil Inventories", country: "USD", date: "2026-10-14T10:30:00-04:00", impact: "Medium" },
  { title: "Bank Holiday", country: "USD", date: "2026-10-12T00:00:00-04:00", impact: "Holiday" },
];
const cpi = Date.parse("2026-10-14T12:30:00Z");

test("normalizeEvents keeps only configured currencies and impacts", () => {
  const ev = normalizeEvents(raw, config.calendar);
  assert.deepEqual(ev.map((e) => e.title), ["CPI m/m"]);
  assert.equal(ev[0].time, cpi);
});

test("blackout window spans 15m before to 15m after the release", () => {
  const ev = normalizeEvents(raw, config.calendar);
  assert.equal(findBlackout(ev, cpi - 16 * 60_000), null);
  assert.equal(findBlackout(ev, cpi - 14 * 60_000)?.title, "CPI m/m");
  assert.equal(findBlackout(ev, cpi + 14 * 60_000)?.title, "CPI m/m");
  assert.equal(findBlackout(ev, cpi + 16 * 60_000), null);
  const blocked = checkNewsBlackout(ev, cpi - 5 * 60_000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "news_blackout");
});

test("upcomingEvents window and countdown formatting", () => {
  const ev = normalizeEvents(raw, config.calendar);
  assert.equal(upcomingEvents(ev, cpi - 25 * 3_600_000, 24).length, 0);
  assert.equal(upcomingEvents(ev, cpi - 2 * 3_600_000, 24).length, 1);
  assert.equal(fmtIn(cpi, cpi - 95 * 60_000), "in 1h35m");
  assert.equal(fmtIn(cpi, cpi + 10 * 60_000), "10m ago");
});
