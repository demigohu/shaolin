import { test } from "node:test";
import assert from "node:assert/strict";
import { candle } from "./helpers.js";
import { findFractals, previousDayHL, asianRange, detectBos, findOrderBlocks } from "../smc-analysis.js";
import { detectLiquidityEvents, sideOfLiquidity } from "../smc.js";
import { mergeZoneLevels } from "../mtf-zones.js";
import { getCurrentSession, isSessionAllowed, isWeekendMarketClosed } from "../modes.js";
import { aggregateCandles } from "../tools/candles.js";

const H = 60 * 60_000;

test("findFractals picks confirmed swing highs/lows", () => {
  const highs = [1, 2, 5, 2, 1, 2, 3, 2, 1];
  const ks = highs.map((h, i) => candle(i, h, h, h - 1, h));
  const { highs: sh, lows: sl } = findFractals(ks);
  assert.deepEqual(sh.map((f) => f.price), [5, 3]);
  assert.deepEqual(sl.map((f) => f.price), [0]);
});

test("previousDayHL skips the in-progress session bar", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const d1 = [candle(Date.parse("2026-10-12T04:00:00Z"), 1, 10, 5, 7), candle(Date.parse("2026-10-13T04:00:00Z"), 7, 12, 6, 8)];
  assert.deepEqual([previousDayHL(d1, now).pdh, previousDayHL(d1, now).pdl], [10, 5]);
});

test("asianRange uses 00–06 UTC (07–13 WIB) of the WIB day", () => {
  const day = Date.parse("2026-10-13T00:00:00Z");
  const ks = [];
  for (let i = -4; i < 12; i++) ks.push(candle(day + i * 15 * 60_000 * 4, 100, 100 + i, 99 - i, 100));
  const r = asianRange(ks, new Date("2026-10-13T08:00:00Z"));
  assert.equal(r.date, "2026-10-13");
  assert.equal(r.high, 100 + 5); // bars at 00:00..05:00 → i = 0..5
  assert.equal(r.low, 99 - 5);
  assert.equal(r.complete, true);
});

test("detectBos flags a close above the last swing high", () => {
  const hs = [1, 2, 5, 2, 1, 2, 3, 4, 6];
  const ks = hs.map((h, i) => candle(i, h - 0.5, h, h - 1, h - 0.1));
  assert.equal(detectBos(ks).bos, "bullish_bos");
});

test("findOrderBlocks finds the last down candle before a displacement up", () => {
  const ks = [];
  for (let i = 0; i < 12; i++) ks.push(candle(i, 100, 100.5, 99.5, 100.1));
  ks.push(candle(12, 100, 100.2, 99, 99.2)); // bearish OB candle
  ks.push(candle(13, 99.2, 103, 99.1, 102.8)); // displacement
  for (let i = 14; i < 18; i++) ks.push(candle(i, 102.8, 103.2, 102.5, 103));
  const { bullish } = findOrderBlocks(ks);
  assert.deepEqual([bullish.low, bullish.high], [99, 100.2]);
});

test("liquidity: taken vs swept vs near", () => {
  const pools = [{ name: "asian", high: 2010, low: 1990 }];
  assert.deepEqual(detectLiquidityEvents(2011, pools).events, ["bsl_taken_asian"]);
  const wickAbove = [candle(0, 2008, 2012, 2007, 2008)];
  assert.deepEqual(detectLiquidityEvents(2008, pools, wickAbove).events, ["bsl_swept_asian"]);
  assert.deepEqual(detectLiquidityEvents(1990.3, pools).events, ["ssl_near_asian"]);
  assert.deepEqual(sideOfLiquidity(["ssl_near_asian"]), { ssl: false, bsl: false }, "near is not a raid");
});

test("mergeZoneLevels clusters nearby levels and sums strength", () => {
  const z = mergeZoneLevels([
    { price: 2000, kind: "support", label: "a", tf: "1h", weight: 3, source: "swing" },
    { price: 2000.5, kind: "support", label: "b", tf: "4h", weight: 4, source: "swing" },
    { price: 2010, kind: "resistance", label: "c", tf: "1h", weight: 3, source: "swing" },
  ], 8);
  assert.equal(z.length, 2);
  assert.equal(z[0].strength, 7);
  assert.equal(z[0].confluence_tfs, 2);
});

test("aggregateCandles builds 4h bars", () => {
  const ks = [0, 1, 2, 3, 4].map((i) => candle(i * H, 10 + i, 11 + i, 9 + i, 10.5 + i));
  const h4 = aggregateCandles(ks, 4 * H);
  assert.equal(h4.length, 2);
  assert.deepEqual([h4[0].o, h4[0].h, h4[0].l, h4[0].c], [10, 14, 9, 13.5]);
});

test("sessions: London/NY overlap counts for both", () => {
  const t = new Date("2026-10-13T14:00:00Z");
  assert.equal(getCurrentSession(t), "overlap");
  assert.equal(isSessionAllowed({ sessions: ["new_york"] }, t), true);
  assert.equal(isSessionAllowed({ sessions: ["london"] }, new Date("2026-10-13T18:00:00Z")), false);
});

test("weekend: Friday close to Sunday reopen", () => {
  assert.equal(isWeekendMarketClosed(new Date("2026-10-16T20:00:00Z")), false); // Fri
  assert.equal(isWeekendMarketClosed(new Date("2026-10-16T21:30:00Z")), true);
  assert.equal(isWeekendMarketClosed(new Date("2026-10-17T12:00:00Z")), true); // Sat
  assert.equal(isWeekendMarketClosed(new Date("2026-10-18T21:00:00Z")), true); // Sun
  assert.equal(isWeekendMarketClosed(new Date("2026-10-18T22:30:00Z")), false);
});

test("DST: weekend and killzones follow New York / London local time", async () => {
  const { getAMDPhase, describeTradingWindowsWib } = await import("../smc-sessions.js");
  // January (EST/GMT): market reopens Sunday 23:00 UTC, not 22:00.
  assert.equal(isWeekendMarketClosed(new Date("2027-01-10T22:30:00Z")), true);
  assert.equal(isWeekendMarketClosed(new Date("2027-01-10T23:30:00Z")), false);
  // 07:30 UTC is London killzone in summer (08:30 BST) but not in winter (07:30 GMT).
  assert.equal(getAMDPhase(new Date("2026-07-14T07:30:00Z")), "london_manipulation");
  assert.equal(getAMDPhase(new Date("2027-01-12T07:30:00Z")), "off_hours");
  assert.equal(describeTradingWindowsWib(new Date("2026-07-14T07:30:00Z")), "London 14–19 / NY 19–22 WIB");
  assert.equal(describeTradingWindowsWib(new Date("2027-01-12T07:30:00Z")), "London 15–20 / NY 20–23 WIB");
});

test("inferStructureBias over arbitrary timeframes", async () => {
  const { inferStructureBias } = await import("../smc-analysis.js");
  const a = (trend) => ({ market_structure: { trend } });
  const r = inferStructureBias([["1W", a("Bullish")], ["1D", a("Bullish")], ["4h", a("Bearish")]]);
  assert.equal(r.bias, "bullish");
  assert.equal(r.bms_hint, "potential_bearish_bms_on_ltf");
});

test("aggregateWeekly starts weeks on Monday", async () => {
  const { aggregateWeekly } = await import("../tools/candles.js");
  const day = (iso, h, l) => candle(Date.parse(iso), 1, h, l, 1);
  const w = aggregateWeekly([day("2026-10-09T04:00:00Z", 5, 1), day("2026-10-12T04:00:00Z", 7, 2), day("2026-10-13T04:00:00Z", 9, 3)]);
  assert.equal(w.length, 2);
  assert.deepEqual([w[1].h, w[1].l], [9, 2]);
});
