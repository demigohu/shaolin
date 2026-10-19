import { test } from "node:test";
import assert from "node:assert/strict";
import { mode } from "./helpers.js";
import { config } from "../config.js";
import { sanitizePlan, matchPoi, gradeSetup } from "../planner.js";

config.plan = { enabled: true, offPlanMinConfidence: 75, offPlanMinConfluence: 3 };

const raw = {
  bias: "bearish",
  bias_reason: "4h/1h bearish, PDL swept",
  invalidation_above: 4180,
  pois: [
    { side: "short", zone_low: 4170.7, zone_high: 4165, level_type: "15m bearish OB + EQH", setups: ["sh_bms_rto", "bogus"], trigger: "sweep EQH then 5m BMS down", targets: [4155, "x", 4150] },
    { side: "long", zone_low: 4150, zone_high: 4154, level_type: "PDL + Asian low", setups: ["turtle_soup_long"], trigger: "sweep + reclaim" },
    { side: "long", zone_low: 4000, zone_high: 4005, level_type: "far away", setups: [], trigger: "x" },
    { side: "short", zone_low: 4160, zone_high: 4300, level_type: "too wide", setups: [], trigger: "x" },
    { side: "sideways", zone_low: 1, zone_high: 2 },
  ],
};

test("sanitizePlan keeps valid in-reach POIs, orders zones, filters setups/targets", () => {
  const p = sanitizePlan(raw, { price: 4158, reach: 400 });
  assert.equal(p.bias, "bearish");
  assert.deepEqual(p.invalidation, { above: 4180, below: null });
  assert.deepEqual(p.pois.map((x) => [x.id, x.side, x.zone_low, x.zone_high]), [["P1", "short", 4165, 4170.7], ["P2", "long", 4150, 4154]]);
  assert.deepEqual(p.pois[0].setups, ["sh_bms_rto"]);
  assert.deepEqual(p.pois[0].targets, [4155, 4150]);
});

test("matchPoi / gradeSetup: A at POI on its side, B off-plan needs more, unplanned without plan", () => {
  const plan = { id: "plan-1", ...sanitizePlan(raw, { price: 4158, reach: 400 }) };
  assert.equal(matchPoi(plan, "short", 4166, 3)?.id, "P1");
  assert.equal(matchPoi(plan, "long", 4166, 3), null, "wrong side");

  assert.deepEqual(gradeSetup({ side: "short", entry: 4166, confidence: 66 }, plan, mode, ["htf_bias", "bms"]), { ok: true, grade: "A", poi_id: "P1", plan_id: "plan-1" });
  assert.equal(gradeSetup({ side: "long", entry: 4160, confidence: 70 }, plan, mode, ["htf_bias", "bms", "fib_ote"]).reason, "off_plan_weak");
  assert.equal(gradeSetup({ side: "long", entry: 4160, confidence: 80 }, plan, mode, ["htf_bias", "bms", "fib_ote"]).grade, "B");
  assert.equal(gradeSetup({ side: "long", entry: 4160, confidence: 60 }, null, mode, []).grade, "unplanned");
});

test("an OB just outside the POI zone still grades A (poiTolerancePips)", () => {
  config.plan.poiTolerancePips = 30;
  const plan = { id: "plan-2", pois: [{ id: "P4", side: "long", zone_low: 4148.46, zone_high: 4152.69 }] };
  assert.equal(gradeSetup({ side: "long", entry: 4155.0, confidence: 70 }, plan, mode, ["htf_bias", "bms"]).grade, "A");
  assert.equal(gradeSetup({ side: "long", entry: 4160.0, confidence: 70 }, plan, mode, ["htf_bias", "bms"]).reason, "off_plan_weak");
});

test("sanitizePlan drops an opposite-side POI that overlaps or nearly touches an earlier one", () => {
  const p = sanitizePlan({ bias: "bearish", bias_reason: "", pois: [
    { side: "short", zone_low: 4154.12, zone_high: 4158.93, level_type: "1h OB", setups: [], trigger: "x" },
    { side: "long", zone_low: 4148.46, zone_high: 4152.69, level_type: "SSL", setups: [], trigger: "x" },
    { side: "short", zone_low: 4165.1, zone_high: 4171.2, level_type: "PDH", setups: [], trigger: "x" },
    { side: "long", zone_low: 4130.3, zone_high: 4137.9, level_type: "1h OB", setups: [], trigger: "x" },
  ] }, { price: 4152, reach: 400 });
  assert.deepEqual(p.pois.map((x) => `${x.side}@${x.zone_low}`), ["short@4154.12", "short@4165.1", "long@4130.3"]);
});

test("sanitizePlan takes the side from the targets when the label contradicts them", () => {
  const p = sanitizePlan({ bias: "bearish", bias_reason: "", pois: [
    { side: "short", zone_low: 4156.23, zone_high: 4162.6, level_type: "EQL SSL", setups: [], trigger: "sweep then close back above → long", targets: [4162.6, 4166.24, 4171.31] },
    { side: "short", zone_low: 4180, zone_high: 4183, level_type: "OB", setups: [], trigger: "x", targets: [4172, 4168] },
  ] }, { price: 4168, reach: 400 });
  assert.equal(p.pois[0].side, "long");
  assert.equal(p.pois[1].side, "short");
});
