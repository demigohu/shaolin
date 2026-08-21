import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { getActiveMode } from "./modes.js";
import { computeTpLevels, computeRrRatio, roundToPips, toPips } from "./tools/price.js";
import { config } from "./config.js";
import { isThesisOnCooldown } from "./setup-memory.js";
import { getActiveStrategy } from "./strategies.js";
import {
  isInEntryZone,
  distanceFromEntryPips,
  shouldExpireStaleByDistance,
  shouldInvalidatePreFill,
} from "./tools/setup-gates.js";

export { isInEntryZone, distanceFromEntryPips, shouldExpireStaleByDistance, shouldInvalidatePreFill };

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

export function findOpenSetupSameSide(side, modeId = null) {
  return findActiveSetups().find(
    (s) => s.side === side && (!modeId || s.mode === modeId),
  ) || null;
}

export function findDuplicateThesis(candidate) {
  const active = findActiveSetups();
  const mode = getActiveMode();
  const zonePips = mode.entryZonePips ?? 3;
  const pip = config.broker.pipSize || 0.1;
  const zone = zonePips * pip;

  // Same side + similar entry zone → treat as duplicate even if SL differs
  for (const s of active) {
    if (s.side !== candidate.side) continue;
    if (modeIdOrAny(s.mode, candidate.mode) && Math.abs(s.entry - candidate.entry) <= zone * 3) {
      return s;
    }
  }

  const fp = thesisFingerprint(candidate);
  for (const s of active) {
    if (thesisFingerprint(s) !== fp) continue;
    if (Math.abs(s.entry - candidate.entry) <= zone) return s;
  }
  return null;
}

function modeIdOrAny(a, b) {
  if (!a || !b) return true;
  return a === b;
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
    strategy_id: input.strategy_id || getActiveStrategy().id,
    mode: mode.id,
  };

  const duplicate = findDuplicateThesis(candidate);
  if (duplicate) {
    return { skipped: true, reason: "duplicate_thesis", existing: duplicate.id };
  }

  const sameSideOpen = findOpenSetupSameSide(side, mode.id);
  if (sameSideOpen) {
    return { skipped: true, reason: "open_setup_exists", existing: sameSideOpen.id };
  }

  const slPips = toPips(Math.abs(entry - sl));
  const maxSl = mode.maxSlPips;
  const minSl = mode.minSlPips;
  if (maxSl != null && slPips > maxSl) {
    return { skipped: true, reason: "sl_too_wide", sl_pips: slPips, max_sl_pips: maxSl };
  }
  if (minSl != null && slPips < minSl) {
    return {
      skipped: true,
      reason: "sl_too_tight",
      sl_pips: slPips,
      min_sl_pips: minSl,
    };
  }

  const minRr = mode.minRrRatio ?? 1.2;
  if (minRr > 0 && rr < minRr) {
    return { skipped: true, reason: "rr_too_low", rr_ratio: rr, min_rr: minRr };
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
  const entryStyle = input.entry_style || "market";
  const priceAtPropose = input.price_at_propose ?? null;
  const entryDistancePips = input.entry_distance_pips
    ?? (priceAtPropose != null ? distanceFromEntryPips({ entry }, priceAtPropose) : null);

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
    entry_style: entryStyle,
    price_at_propose: priceAtPropose,
    entry_distance_pips: entryDistancePips,
    status: entryStyle === "limit" ? "proposed" : "active",
    proposed_at: new Date().toISOString(),
    activated_at: entryStyle === "limit" ? null : new Date().toISOString(),
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
    setup_type: sanitize(input.setup_type, 40),
    confluence_factors: Array.isArray(input.confluence_factors)
      ? input.confluence_factors.map((c) => sanitize(c, 40)).filter(Boolean).slice(0, 8)
      : [],
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
  if (extra.stale_distance_pips != null) setup.stale_distance_pips = extra.stale_distance_pips;
  if (extra.partial_filled) setup.partial_filled = extra.partial_filled;
  save(data);
  return setup;
}

/** User-initiated cancel — removes setup from active monitoring. */
export function cancelSetup(id, reason = "user_cancelled") {
  const setup = resolveSetup(id, "cancelled", { pnl_pips: 0, reason });
  if (setup) log("setups", `Cancelled ${id}: ${reason}`);
  return setup;
}

export function cancelAllOpenSetups(reason = "user_cancelled_all") {
  const open = findActiveSetups();
  for (const s of open) {
    resolveSetup(s.id, "cancelled", { pnl_pips: 0, reason });
  }
  if (open.length) log("setups", `Cancelled ${open.length} open setup(s): ${reason}`);
  return open.map((s) => s.id);
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
    const style = s.entry_style ? ` ${s.entry_style}` : "";
    return `${i + 1}. [${s.status}${style}] ${s.side.toUpperCase()} ${s.symbol} entry ${s.entry} SL ${s.sl} | ${tps || `TP ${s.tp}`} | conf ${s.confidence}% | ${s.id}`;
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

/** Expire limit setups when price drifts too far without fill. Returns resolved setups. */
export function expireStaleByDistance(open, price, mode) {
  const resolved = [];
  for (const setup of open) {
    if (!shouldExpireStaleByDistance(setup, price, mode)) continue;
    const r = resolveSetup(setup.id, "stale_no_fill", {
      pnl_pips: 0,
      stale_distance_pips: distanceFromEntryPips(setup, price),
    });
    if (r) resolved.push(r);
  }
  return resolved;
}

export function persistSetup(setup) {
  const data = load();
  data.setups[setup.id] = setup;
  save(data);
  return setup;
}
