import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { detectTriggers, poolsFromContext } from "../watcher.js";

const pois = [{ id: "P1", side: "short", zone_low: 4165, zone_high: 4170, level_type: "15m OB" }];

test("POI proximity and inside triggers", () => {
  assert.equal(detectTriggers({ price: 4164.6, pois, proximityPips: 5 }).length, 1);
  assert.match(detectTriggers({ price: 4167, pois })[0].text, /inside plan P1/);
  assert.equal(detectTriggers({ price: 4160, pois, proximityPips: 5 }).length, 0);
});

test("sweep needs a wick through the pool AND price back inside", () => {
  const pools = [{ name: "PD", high: 4219, low: 4155 }];
  assert.equal(detectTriggers({ price: 4156, bar: { high: 4158, low: 4153.5 }, pools })[0].kind, "sweep");
  assert.equal(detectTriggers({ price: 4154, bar: { high: 4158, low: 4153.5 }, pools }).length, 0, "still below = taken, not swept");
  assert.equal(detectTriggers({ price: 4156, bar: { high: 4158, low: 4155.5 }, pools }).length, 0);
});

test("cooldown suppresses repeat triggers", () => {
  const now = 10_000_000;
  const lastFired = new Map([["poi:P1", now - 5 * 60_000]]);
  assert.equal(detectTriggers({ price: 4167, pois, lastFired, now, cooldownMs: 30 * 60_000 }).length, 0);
  assert.equal(detectTriggers({ price: 4167, pois, lastFired, now: now + 26 * 60_000, cooldownMs: 30 * 60_000 }).length, 1);
});

test("poolsFromContext collects Asian (only once complete), PD, PW and equal levels", () => {
  const pools = poolsFromContext({
    asian_range: { complete: false, high: 1, low: 0 }, pdh: 4219, pdl: 4155, pwh: null, pwl: 4068,
    equal_levels: [{ kind: "eqh", tf: "15m", price: 4173.5 }],
  });
  assert.deepEqual(pools.map((p) => p.name), ["PD", "PW", "EQH 15m"]);
});

test("detectBmsTriggers: fresh BMS in the POI direction after price reached the zone", async () => {
  const { detectBmsTriggers } = await import("../watcher.js");
  const pois = [
    { id: "P1", side: "long", zone_low: 4148.5, zone_high: 4152.7 },
    { id: "P2", side: "short", zone_low: 4165, zone_high: 4171 },
  ];
  const tape = [{ h: 4153, l: 4148.0 }, { h: 4156, l: 4151 }];
  const state = { bms: { dir: "bullish", level: 4154.9, bars_ago: 1 }, ob: { low: 4152.3, high: 4154.6 }, rto: "not yet", tape };
  const t = detectBmsTriggers({ state, pois });
  assert.deepEqual(t.map((x) => x.key), ["bms:P1"]);
  assert.match(t[0].text, /RTO zone \(OB\) 4152.30–4154.60/);
  assert.equal(detectBmsTriggers({ state: { ...state, bms: { ...state.bms, bars_ago: 5 } }, pois }).length, 0, "stale BMS");
  assert.equal(detectBmsTriggers({ state: { ...state, tape: [{ h: 4160, l: 4156 }] }, pois }).length, 0, "zone never reached");
  assert.equal(detectBmsTriggers({ state, pois, lastFired: new Map([["bms:P1", Date.now()]]) }).length, 0, "cooldown per POI");
  const farOb = { ...state, ob: { low: 4156.9, high: 4158.9 } };
  assert.equal(detectBmsTriggers({ state: farOb, pois }).length, 0, "OB 42p above the zone is the next leg");
});

test("BMS triggers carry the POI, the OB and a computed price-vs-OB relation", async () => {
  const { detectBmsTriggers, priceVsZone } = await import("../watcher.js");
  const pois = [{ id: "P4", side: "long", zone_low: 4148.46, zone_high: 4152.69 }];
  const state = { bms: { dir: "bullish", level: 4154.64, bars_ago: 0 }, ob: { low: 4154.12, high: 4158.10 }, rto: "not yet", tape: [{ h: 4153, l: 4150 }] };
  const [t] = detectBmsTriggers({ state, pois, price: 4155.57 });
  assert.equal(t.poi.id, "P4");
  assert.deepEqual(t.ob, { low: 4154.12, high: 4158.10 });
  assert.match(t.text, /price 4155.57 is INSIDE it now/);
  assert.equal(priceVsZone(4160, { low: 4154, high: 4158 }), "price 4160 is 20p above it");
});
