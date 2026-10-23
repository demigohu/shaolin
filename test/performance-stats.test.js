import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { config } from "../config.js";
import { buildPerformanceStats, checkTrackRecord, recentTrades } from "../performance-stats.js";

config.performanceGate = { enabled: true, windowDays: 60, minTrades: 5, maxWinRate: 30 };
const now = Date.now();
const trade = (setup_type, session, pnl, extra = {}) => ({
  mode: "scalp", strategy_version: config.strategyVersion, setup_type, session, side: "long", pnl_pips: pnl, filled: true, outcome: pnl > 0 ? "tp_hit" : "sl_hit",
  confluence_factors: ["htf_bias"], resolved_at: new Date(now - 60_000).toISOString(), ...extra,
});

test("recentTrades keeps filled trades of the mode inside the window", () => {
  const rows = [
    trade("bms_rto_ote", "london", 10),
    trade("bms_rto_ote", "london", 0, { filled: false, outcome: "stale_no_fill" }),
    trade("bms_rto_ote", "london", 10, { mode: "swing" }),
    trade("bms_rto_ote", "london", 10, { resolved_at: new Date(now - 90 * 864e5).toISOString() }),
    trade("bms_rto_ote", "london", 10, { strategy_version: "v0-old" }),
  ];
  assert.equal(recentTrades("scalp", rows, now).length, 1);
});

test("stats group by setup type, session and confluence tag", () => {
  const s = buildPerformanceStats([trade("bms_rto_ote", "london", 20), trade("bms_rto_ote", "asian", -10)]);
  assert.deepEqual(s.by_setup_type.bms_rto_ote, { n: 2, wins: 1, win_rate: 50, net_pips: 10, avg_pips: 5 });
  assert.equal(s.by_type_session["bms_rto_ote@asian"].n, 1);
  assert.equal(s.by_confluence.htf_bias.n, 2);
});

test("losing setup type in a session is blocked; other sessions are not", () => {
  const trades = [
    ...Array.from({ length: 4 }, () => trade("turtle_soup_short", "asian", -20)),
    trade("turtle_soup_short", "asian", 15),
    ...Array.from({ length: 3 }, () => trade("turtle_soup_short", "london", 25)),
  ];
  const asian = checkTrackRecord({ setup_type: "turtle_soup_short", session: "asian", mode: "scalp" }, trades);
  assert.equal(asian.ok, false);
  assert.equal(asian.reason, "poor_track_record");
  assert.equal(checkTrackRecord({ setup_type: "turtle_soup_short", session: "london", mode: "scalp" }, trades).ok, true);
});

test("too few trades or net positive → not blocked", () => {
  const few = Array.from({ length: 4 }, () => trade("bms_rto_ote", "asian", -10));
  assert.equal(checkTrackRecord({ setup_type: "bms_rto_ote", session: "asian", mode: "scalp" }, few).ok, true);
  const bigWinner = [...Array.from({ length: 4 }, () => trade("bms_rto_ote", "asian", -10)), trade("bms_rto_ote", "asian", 100)];
  assert.equal(checkTrackRecord({ setup_type: "bms_rto_ote", session: "asian", mode: "scalp" }, bigWinner).ok, true);
});

test("confidence calibration compares stated confidence with realised win rate", async () => {
  const { formatConfidenceCalibration, confidenceBucket } = await import("../performance-stats.js");
  assert.equal(confidenceBucket(72), "70-74");
  assert.equal(confidenceBucket(60), "<65");
  assert.equal(confidenceBucket(90), "85+");
  const t = (conf, pnl) => ({ confidence: conf, pnl_pips: pnl });
  const trades = [t(72, 50), t(71, -30), t(70, -30), t(73, -30), t(74, -30), t(66, 10)];
  const lines = formatConfidenceCalibration(trades, 5);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /70-74: stated ~72%, won 20% \(n=5/);
  assert.match(lines[1], /overconfident by 52/);
});
