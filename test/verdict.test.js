import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../verdict.js";

test("first-line verdict wins", () => {
  assert.equal(parseVerdict("WATCH\nSETUP checklist: sweep ✅ BMS ❌"), "WATCH");
  assert.equal(parseVerdict("**SETUP** — P1 turtle soup long"), "SETUP");
});

test("markdown-header answers: the last verdict word decides, not any SETUP mention", () => {
  const sonnet = "## 📍 XAUUSD Scalp Screening\n| step | status |\nSETUP checklist below\n...\nWATCH — SSL sweep ✅ and price inside P1 ✅, but the 5m BMS close has not printed.";
  assert.equal(parseVerdict(sonnet), "WATCH");
  assert.equal(parseVerdict("## Read\nAll confirmed.\nSETUP — entering P1 long"), "SETUP");
  assert.equal(parseVerdict("## Read\nnothing decided"), "WATCH");
});

test("verdictReason takes the one-line reason after the verdict", async () => {
  const { verdictReason } = await import("../verdict.js");
  assert.equal(verdictReason("WATCH\nP2: BSL sweep done, waiting for a 5m close below 4158.2 (BMS).\n## details"), "P2: BSL sweep done, waiting for a 5m close below 4158.2 (BMS).");
  assert.equal(verdictReason("**WATCH** — price below P1, no reclaim yet"), "price below P1, no reclaim yet");
});
