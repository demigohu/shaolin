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
  assert.equal(validateRsi({ side: "short", setup_type: "fib_retrace" }, 30).ok, false);
  assert.equal(validateRsi({ side: "long", setup_type: "snr_bounce_long" }, 70).ok, false);
  assert.equal(validateRsi({ side: "long", setup_type: "turtle_soup_long" }, 25).ok, true);
  assert.equal(validateRsi({ side: "long", setup_type: "fib_retrace" }, null).ok, true);
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
  const wide = validateProposedSl({ side: "short", entry: 4167.36, sl: 4189.53, setup_type: "dip_reclaim_short" }, null, m);
  assert.equal(wide.ok, false);
  assert.equal(wide.reason, "sl_too_wide");
  assert.equal(validateProposedSl({ side: "short", entry: 4167.36, sl: 4170.5, setup_type: "dip_reclaim_short" }, null, m).ok, true);
  assert.equal(validateProposedSl({ side: "short", entry: 4167.36, sl: 4168.5, setup_type: "dip_reclaim_short" }, null, m).reason, "sl_too_tight");
});

test("TP beyond the mode's reach is rejected", async () => {
  const { validateTpDistance } = await import("../tools/setup-gates.js");
  const m = { ...mode, maxTpPips: 150 };
  const far = validateTpDistance({ entry: 4167.36, tp_levels: [{ price: 4068 }, { price: 4030 }] }, m);
  assert.equal(far.ok, false);
  assert.equal(far.reason, "tp_too_far");
  assert.equal(validateTpDistance({ entry: 4167.36, tp_levels: [{ price: 4160 }, { price: 4155 }] }, m).ok, true);
});
