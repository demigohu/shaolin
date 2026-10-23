import { test } from "node:test";
import assert from "node:assert/strict";
import { mode } from "./helpers.js";
import {
  validateProposedEntry,
  validateMinRr,
  validateProposedTp,
  validateConfidence,
  validateRsi,
  isLimitFilled,
} from "../tools/setup-gates.js";

test("market entry must be near live price", () => {
  assert.equal(validateProposedEntry({ side: "long", entry: 2000.2, entry_style: "market" }, 2000, mode).ok, true);
  const far = validateProposedEntry({ side: "long", entry: 2001, entry_style: "market" }, 2000, mode);
  assert.equal(far.ok, false);
  assert.equal(far.reason, "entry_too_far");
});

test("limit entry must be on the retrace side and within max distance", () => {
  assert.equal(validateProposedEntry({ side: "long", entry: 1998, entry_style: "limit" }, 2000, mode).ok, true);
  assert.equal(validateProposedEntry({ side: "long", entry: 2002, entry_style: "limit" }, 2000, mode).reason, "limit_wrong_side");
  assert.equal(validateProposedEntry({ side: "short", entry: 1998, entry_style: "limit" }, 2000, mode).reason, "limit_wrong_side");
  assert.equal(validateProposedEntry({ side: "long", entry: 1990, entry_style: "limit" }, 2000, mode).reason, "limit_entry_too_far");
});

test("entry style is inferred from distance when omitted", () => {
  assert.equal(validateProposedEntry({ side: "long", entry: 2000.1 }, 2000, mode).entry_style, "market");
  assert.equal(validateProposedEntry({ side: "long", entry: 1999 }, 2000, mode).entry_style, "limit");
});

test("no live price → reject", () => {
  assert.equal(validateProposedEntry({ side: "long", entry: 2000 }, null, mode).reason, "no_price");
});

test("min RR uses the final TP and never suggests tightening SL", () => {
  const low = validateMinRr({ side: "long", entry: 2000, sl: 1996, tp_levels: [{ price: 2004 }] }, mode);
  assert.equal(low.ok, false);
  assert.equal(low.min_tp_pips, 48);
  assert.equal(validateMinRr({ side: "long", entry: 2000, sl: 1996, tp_levels: [{ price: 2004 }, { price: 2006 }] }, mode).ok, true);
});

test("TP on the wrong side of entry is rejected", () => {
  assert.equal(validateProposedTp({ side: "long", entry: 2000, sl: 1996, tp_levels: [{ price: 2005 }, { price: 1998 }] }).ok, false);
});

test("confidence gate", () => {
  assert.equal(validateConfidence({ confidence: 60 }, mode).ok, false);
  assert.equal(validateConfidence({ confidence: 70 }, mode).ok, true);
});

test("RSI gate blocks trend trades into extremes but not turtle soup", () => {
  assert.equal(validateRsi({ side: "short", setup_type: "bms_rto_ote" }, 30).ok, false);
  assert.equal(validateRsi({ side: "long", setup_type: "bms_rto_ote" }, 70).ok, false);
  assert.equal(validateRsi({ side: "long", setup_type: "turtle_soup_long" }, 25).ok, true);
  assert.equal(validateRsi({ side: "long", setup_type: "bms_rto_ote" }, null).ok, true);
});

test("isLimitFilled", () => {
  const long = { side: "long", entry: 2000 };
  assert.equal(isLimitFilled(long, 2000.3, 3), true);
  assert.equal(isLimitFilled(long, 1995, 3), true);
  assert.equal(isLimitFilled(long, 2001, 3), false);
  const short = { side: "short", entry: 2000 };
  assert.equal(isLimitFilled(short, 2005, 3), true);
  assert.equal(isLimitFilled(short, 1999, 3), false);
});

test("SL bounds apply even when the LLM owns SL/TP", async () => {
  const { validateProposedSl } = await import("../tools/setup-gates.js");
  const m = { ...mode, minSlPips: 20, maxSlPips: 40 };
  const wide = validateProposedSl({ side: "short", entry: 4167.36, sl: 4189.53, setup_type: "sh_bms_rto" }, null, m);
  assert.equal(wide.ok, false);
  assert.equal(wide.reason, "sl_too_wide");
  assert.equal(validateProposedSl({ side: "short", entry: 4167.36, sl: 4170.5, setup_type: "sh_bms_rto" }, null, m).ok, true);
  assert.equal(validateProposedSl({ side: "short", entry: 4167.36, sl: 4168.5, setup_type: "sh_bms_rto" }, null, m).reason, "sl_too_tight");
});

test("TP beyond the mode's reach is rejected", async () => {
  const { validateTpDistance } = await import("../tools/setup-gates.js");
  const m = { ...mode, maxTpPips: 150 };
  const far = validateTpDistance({ entry: 4167.36, tp_levels: [{ price: 4068 }, { price: 4030 }] }, m);
  assert.equal(far.ok, false);
  assert.equal(far.reason, "tp_too_far");
  assert.equal(validateTpDistance({ entry: 4167.36, tp_levels: [{ price: 4160 }, { price: 4155 }] }, m).ok, true);
});

test("trigger gate: BMS setups need a fresh BMS in the trade direction", async () => {
  const { validateTriggerComplete } = await import("../tools/setup-gates.js");
  const ctx = (bms, extra = {}) => ({ profile: { trigger_tf: "5m" }, trigger: { bms, rto: "not yet", sweeps: [], ...extra } });
  const bull = { dir: "bullish", level: 4160, bars_ago: 1 };
  const bear = { dir: "bearish", level: 4160, bars_ago: 1 };
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "sh_bms_rto" }, ctx(bull)).reason, "trigger_incomplete");
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "sh_bms_rto" }, ctx(null)).reason, "trigger_incomplete");
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "sh_bms_rto" }, ctx(bear)).ok, true);
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "sh_bms_rto" }, ctx({ ...bear, bars_ago: 40 })).reason, "trigger_stale");
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "sh_bms_rto" }, ctx(bear, { rto: "failed (closed through the OB)" })).reason, "trigger_failed");
  assert.equal(validateTriggerComplete({ side: "long", setup_type: "sh_bms_rto" }, ctx(bull)).ok, true);
});

test("trigger gate: turtle soup needs the opposite pool swept", async () => {
  const { validateTriggerComplete } = await import("../tools/setup-gates.js");
  const ctx = (sweeps) => ({ profile: { trigger_tf: "5m" }, trigger: { bms: null, sweeps }, liquidity_events: [] });
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "turtle_soup_short" }, ctx([])).reason, "trigger_incomplete");
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "turtle_soup_short" }, ctx([{ side: "ssl" }])).reason, "trigger_incomplete");
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "turtle_soup_short" }, ctx([{ side: "bsl" }])).ok, true);
  assert.equal(validateTriggerComplete({ side: "long", setup_type: "sh_bms_rto" }, null).ok, true);
});

test("trigger gate: with 1m refinement, BMS setups need the 5m RTO and a fresh 1m BMS", async () => {
  const { validateTriggerComplete } = await import("../tools/setup-gates.js");
  const bear = { dir: "bearish", level: 4160, bars_ago: 3 };
  const ctx = (rto, refineBms) => ({ profile: { trigger_tf: "5m", refine_tf: "1m" }, trigger: { bms: bear, rto, sweeps: [] }, refine: { bms: refineBms } });
  const args = { side: "short", setup_type: "sh_bms_rto" };
  assert.equal(validateTriggerComplete(args, ctx("not yet", { dir: "bearish", level: 1, bars_ago: 1 })).reason, "refine_no_rto");
  assert.equal(validateTriggerComplete(args, ctx("touched", null)).reason, "refine_pending");
  assert.equal(validateTriggerComplete(args, ctx("touched", { dir: "bullish", level: 1, bars_ago: 1 })).reason, "refine_pending");
  assert.equal(validateTriggerComplete(args, ctx("touched", { dir: "bearish", level: 1, bars_ago: 9 })).reason, "refine_pending");
  assert.equal(validateTriggerComplete(args, ctx("touched", { dir: "bearish", level: 1, bars_ago: 2 })).ok, true);
  assert.equal(validateTriggerComplete({ side: "short", setup_type: "turtle_soup_short" }, { ...ctx("not yet", null), trigger: { bms: null, sweeps: [{ side: "bsl" }] } }).ok, true);
});

test("SL must sit a buffer beyond sweep wicks and the day's extreme", async () => {
  const { validateSlBuffer } = await import("../tools/setup-gates.js");
  const ctx = { lod: 4010.1, hod: 4040, trigger: { sweeps: [{ side: "ssl", wick: 4010.1 }] }, refine: null };
  assert.equal(validateSlBuffer({ side: "long", sl: 4010 }, ctx).reason, "sl_on_liquidity");
  assert.equal(validateSlBuffer({ side: "long", sl: 4009.1 }, ctx).ok, true);
  assert.equal(validateSlBuffer({ side: "long", sl: 4013 }, ctx).ok, true);
  assert.equal(validateSlBuffer({ side: "short", sl: 4040.4 }, ctx).reason, "sl_on_liquidity");
  assert.equal(validateSlBuffer({ side: "short", sl: 4041 }, ctx).ok, true);
});
