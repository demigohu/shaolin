import { test } from "node:test";
import assert from "node:assert/strict";
import { mode, makeSetup } from "./helpers.js";
import { evaluateSetup, evaluateExpiry, realizedPnlPips } from "../management.js";

test("SL hit books loss at the SL level, not the poll price", () => {
  const { setup, resolved } = evaluateSetup(makeSetup(), 1990, mode);
  assert.equal(resolved, true);
  assert.equal(setup.outcome, "sl_hit");
  assert.equal(setup.pnl_pips, -40);
});

test("TP ladder: TP1 partial + breakeven alert, then TP2 resolves with weighted pnl", () => {
  const s = makeSetup();
  const r1 = evaluateSetup(s, 2004.5, mode);
  assert.equal(r1.resolved, false);
  assert.equal(s.remaining_pct, 50);
  assert.ok(r1.events.some((e) => e.includes("TP1 HIT")));
  assert.ok(r1.events.some((e) => e.includes("breakeven")));

  const r2 = evaluateSetup(s, 2008.2, mode);
  assert.equal(r2.resolved, true);
  assert.equal(s.outcome, "tp_full");
  assert.equal(s.pnl_pips, 60); // 50% × 40p + 50% × 80p
});

test("price gapping through both TPs in one poll closes everything", () => {
  const s = makeSetup();
  const r = evaluateSetup(s, 2010, mode);
  assert.equal(r.resolved, true);
  assert.equal(s.partial_filled.length, 2);
});

test("TP1 then SL is a partial, pnl weighted", () => {
  const s = makeSetup();
  evaluateSetup(s, 2004, mode);
  const r = evaluateSetup(s, 1995, mode);
  assert.equal(s.outcome, "tp_partial_then_sl");
  assert.equal(s.pnl_pips, 0); // +20 on half, -20 on half
  assert.equal(r.resolved, true);
});

test("near-TP alert fires once per level", () => {
  const s = makeSetup();
  const a = evaluateSetup(s, 2003.5, mode).events;
  const b = evaluateSetup(s, 2003.6, mode).events;
  assert.equal(a.filter((e) => e.includes("Near TP1")).length, 1);
  assert.equal(b.filter((e) => e.includes("Near TP1")).length, 0);
});

test("long limit fills when price trades down through entry (not only inside the zone)", () => {
  const s = makeSetup({ status: "proposed", entry_style: "limit", activated_at: null, entry_distance_pips: 20 });
  const r = evaluateSetup(s, 1999, mode);
  assert.equal(s.status, "active");
  assert.ok(r.events.some((e) => e.includes("limit filled")));
});

test("limit is stale only after running maxStale further than its proposal distance", () => {
  const s = makeSetup({ status: "proposed", entry_style: "limit", activated_at: null, entry_distance_pips: 20 });
  assert.equal(evaluateSetup(s, 2003, mode).resolved, false); // 30p away < 20 + 15
  const r = evaluateSetup(s, 2004, mode); // 40p away > 35
  assert.equal(r.resolved, true);
  assert.equal(s.outcome, "stale_no_fill");
  assert.equal(s.pnl_pips, 0);
});

test("SL crossed before a limit fills invalidates with zero pnl", () => {
  const s = makeSetup({ status: "proposed", entry_style: "limit", activated_at: null });
  evaluateSetup(s, 1995, mode);
  assert.equal(s.outcome, "invalidated_pre_fill");
  assert.equal(s.pnl_pips, 0);
});

test("expiry: unfilled after maxAge expires; filled gets a time exit at price", () => {
  const old = new Date(Date.now() - 120 * 60_000).toISOString();
  const p = makeSetup({ status: "proposed", entry_style: "limit", activated_at: null, proposed_at: old });
  assert.match(evaluateExpiry(p, 90), /EXPIRED/);
  assert.equal(p.outcome, "expired");

  const a = makeSetup({ activated_at: old, proposed_at: old });
  assert.equal(evaluateExpiry(a, 90, null), null, "no price → no time exit");
  assert.match(evaluateExpiry(a, 90, 2002), /TIME EXIT/);
  assert.equal(a.outcome, "time_exit");
  assert.equal(a.pnl_pips, 20);
});

test("realizedPnlPips for shorts", () => {
  const s = makeSetup({ side: "short", entry: 2000, sl: 2004, partial_filled: [{ level: 1, close_pct: 50, price: 1996 }], remaining_pct: 50 });
  assert.equal(realizedPnlPips(s, 2004), 0);
});
