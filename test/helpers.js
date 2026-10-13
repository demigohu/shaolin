import { config } from "../config.js";

// Pin config so tests don't depend on the local user-config.json.
Object.assign(config.broker, { pipSize: 0.1, digits: 2 });
Object.assign(config.screening, {
  maxEntrySlippagePips: 3,
  maxLimitEntryPips: 25,
  maxStaleDistancePips: 15,
  requireEntryNearPrice: true,
  llmOwnsTpSl: true,
  enforceMinRr: true,
  blockExtremeRsi: true,
  rsiNoShortBelow: 35,
  rsiNoLongAbove: 65,
  nearTpSlAlertPct: 80,
});
config.management.breakevenAlertAfterTp1 = true;
config.smc.asianNearPips = 5;

export const mode = {
  id: "scalp",
  entryZonePips: 3,
  maxLimitEntryPips: 25,
  maxStaleDistancePips: 15,
  minConfidence: 65,
  minRrRatio: 1.2,
  setupMaxAgeMin: 90,
};

export function makeSetup(overrides = {}) {
  return {
    id: "setup-test",
    side: "long",
    entry: 2000,
    sl: 1996,
    status: "active",
    entry_style: "market",
    proposed_at: new Date().toISOString(),
    activated_at: new Date().toISOString(),
    remaining_pct: 100,
    partial_filled: [],
    tp_levels: [
      { level: 1, price: 2004, close_pct: 50, status: "pending" },
      { level: 2, price: 2008, close_pct: 50, status: "pending" },
    ],
    ...overrides,
  };
}

export const candle = (t, o, h, l, c) => ({ t, o, h, l, c });
