import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { getActiveMode } from "./modes.js";
import { computeTpLevels, computeRrRatio, roundToPips, toPips } from "./tools/price.js";
import { config } from "./config.js";
import { isThesisOnCooldown } from "./setup-memory.js";

const SETUPS_FILE = repoPath("setups.json");

function load() {
  if (!fs.existsSync(SETUPS_FILE)) return { setups: {}, lastUpdated: null };
  try {
    return JSON.parse(fs.readFileSync(SETUPS_FILE, "utf8"));
  } catch (error) {
    log("setups_warn", `Invalid setups.json: ${error.message}`);
    return { setups: {}, lastUpdated: null };
  }
}

function save(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SETUPS_FILE, JSON.stringify(data, null, 2));
}

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function thesisFingerprint(setup) {
  return [
    setup.side,
    setup.strategy_id || "",
    setup.mode || "",
    roundToPips(setup.entry),
    roundToPips(setup.sl),
  ].join("|");
}

export function findActiveSetups() {
  const data = load();
  return Object.values(data.setups || {}).filter(
    (s) => s.status === "proposed" || s.status === "active",
  );
}

export function findDuplicateThesis(candidate) {
  const active = findActiveSetups();
  const fp = thesisFingerprint(candidate);
  const mode = getActiveMode();
  const zonePips = mode.entryZonePips ?? 3;
  const pip = config.broker.pipSize || 0.01;
  const zone = zonePips * pip;

  for (const s of active) {
    if (thesisFingerprint(s) !== fp) continue;
    if (Math.abs(s.entry - candidate.entry) <= zone) return s;
  }
  return null;
}

export function countSetupsToday() {
  const data = load();
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(data.setups || {}).filter(
    (s) => s.proposed_at?.startsWith(today),
  ).length;
}

export function createSetup(input) {
  const mode = getActiveMode();
  const side = input.side;
  const entry = Number(input.entry);
  const sl = Number(input.sl);
  if (!["long", "short"].includes(side) || !Number.isFinite(entry) || !Number.isFinite(sl)) {
    throw new Error("Invalid setup: side, entry, sl required");
  }

  const partialTp = mode.partialTp || [];
  const tpLevels = computeTpLevels(side, entry, sl, partialTp);
  const tpFinal = tpLevels.length ? tpLevels[tpLevels.length - 1].price : Number(input.tp);
  const rr = computeRrRatio(side, entry, sl, tpFinal);

  const candidate = {
    side,
    entry,
    sl,
    tp: tpFinal,
    strategy_id: input.strategy_id || config.strategy.activeStrategyId,
    mode: mode.id,
  };

  const duplicate = findDuplicateThesis(candidate);
  if (duplicate) {
    return { skipped: true, reason: "duplicate_thesis", existing: duplicate.id };
  }

  if (isThesisOnCooldown(candidate)) {
    return { skipped: true, reason: "thesis_cooldown", thesis_id: input.thesis_id || null };
  }

  if (countSetupsToday() >= (config.screening.maxSetupsPerDay ?? 8)) {
    return { skipped: true, reason: "max_setups_per_day" };
  }

  const activeOpposite = findActiveSetups().find((s) => s.side !== side);
  if (activeOpposite) {
    resolveSetup(activeOpposite.id, "invalidated", { reason: "thesis_conflict", pnl_pips: 0 });
  }

  const id = input.id || `setup-${Date.now()}`;
  const setup = {
    id,
    symbol: config.market.displayName,
    data_symbol: `${config.market.dataExchange}:${config.market.dataSymbol}`,
    side,
    entry,
    sl,
    sl_pips: toPips(Math.abs(entry - sl)),
    tp: tpFinal,
    tp_levels: tpLevels,
    rr_ratio: rr,
    bias: sanitize(input.bias, 40),
    confidence: Number(input.confidence) || 0,
    strategy_id: candidate.strategy_id,
    mode: mode.id,
    session: input.session || null,
    status: "proposed",
    proposed_at: new Date().toISOString(),
    activated_at: null,
    resolved_at: null,
    outcome: null,
    pnl_pips: null,
    max_rr_reached: 0,
    partial_filled: [],
    remaining_pct: 100,
    screening_snapshot: input.screening_snapshot || {},
    reason: sanitize(input.reason, 500),
    risks: Array.isArray(input.risks) ? input.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    thesis_id: sanitize(input.thesis_id || input.reason?.slice(0, 80), 120),
  };

  const data = load();
  data.setups[id] = setup;
  save(data);
  return { skipped: false, setup };
}

export function getSetup(id) {
  const data = load();
  return data.setups?.[id] || null;
}

export function getOpenSetups() {
  return findActiveSetups();
}

export function updateSetup(id, patch) {
  const data = load();
  const setup = data.setups?.[id];
  if (!setup) return null;
  Object.assign(setup, patch);
  save(data);
  return setup;
}

export function resolveSetup(id, outcome, extra = {}) {
  const data = load();
  const setup = data.setups?.[id];
  if (!setup) return null;
  setup.status = "resolved";
  setup.outcome = outcome;
  setup.resolved_at = new Date().toISOString();
  setup.pnl_pips = extra.pnl_pips ?? setup.pnl_pips;
  setup.remaining_pct = extra.remaining_pct ?? setup.remaining_pct;
  if (extra.partial_filled) setup.partial_filled = extra.partial_filled;
  save(data);
  return setup;
}

export function markTpLevelHit(setup, levelIndex, currentPrice) {
  const level = setup.tp_levels?.[levelIndex];
  if (!level || level.status === "hit") return setup;

  level.status = "hit";
  level.hit_at = new Date().toISOString();
  level.hit_price = currentPrice;
  setup.partial_filled = setup.partial_filled || [];
  setup.partial_filled.push({ level: level.level, close_pct: level.close_pct, price: currentPrice });
  setup.remaining_pct = Math.max(0, (setup.remaining_pct || 100) - level.close_pct);

  if (setup.remaining_pct <= 0) {
    setup.status = "resolved";
    setup.outcome = setup.tp_levels.length > 1 ? "tp_full" : "tp_hit";
    setup.resolved_at = new Date().toISOString();
  }
  return setup;
}

export function getSetupsSummary() {
  const open = findActiveSetups();
  if (!open.length) return "No open setups.";
  return open.map((s, i) => {
    const tps = (s.tp_levels || []).map((t) => `TP${t.level}@${t.price}(${t.status})`).join(", ");
    return `${i + 1}. [${s.status}] ${s.side.toUpperCase()} ${s.symbol} entry ${s.entry} SL ${s.sl} | ${tps || `TP ${s.tp}`} | conf ${s.confidence}% | ${s.id}`;
  }).join("\n");
}

export function expireStaleSetups(maxAgeMin) {
  const data = load();
  const now = Date.now();
  let count = 0;
  for (const setup of Object.values(data.setups || {})) {
    if (setup.status !== "proposed" && setup.status !== "active") continue;
    const ageMin = (now - new Date(setup.proposed_at).getTime()) / 60000;
    if (ageMin > maxAgeMin) {
      setup.status = "resolved";
      setup.outcome = "expired";
      setup.resolved_at = new Date().toISOString();
      setup.pnl_pips = 0;
      count++;
    }
  }
  if (count) save(data);
  return count;
}

export function persistSetup(setup) {
  const data = load();
  data.setups[setup.id] = setup;
  save(data);
  return setup;
}
