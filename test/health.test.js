import { test } from "node:test";
import assert from "node:assert/strict";
import { markOk, markFail, collectHealthAlerts, resetHealth } from "../health.js";

test("health: one alert after the threshold, then one recovery", () => {
  resetHealth();
  const t0 = Date.parse("2026-10-23T10:00:00Z");
  markOk("price", t0);
  markFail("price", "timeout", t0 + 60_000);
  assert.deepEqual(collectHealthAlerts(t0 + 5 * 60_000), []);
  const alerts = collectHealthAlerts(t0 + 12 * 60_000);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Price feed/);
  assert.deepEqual(collectHealthAlerts(t0 + 13 * 60_000), []);
  markOk("price", t0 + 14 * 60_000);
  assert.match(collectHealthAlerts(t0 + 15 * 60_000)[0], /recovered/);
  assert.deepEqual(collectHealthAlerts(t0 + 16 * 60_000), []);
});

test("health: a short blip below the threshold never alerts", () => {
  resetHealth();
  const t0 = Date.parse("2026-10-23T10:00:00Z");
  markFail("candles", "429", t0);
  markOk("candles", t0 + 5 * 60_000);
  assert.deepEqual(collectHealthAlerts(t0 + 30 * 60_000), []);
});
