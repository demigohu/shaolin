import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { getActiveMode } from "./modes.js";
import { computeTpLevels, computeRrRatio, normalizeTpLevels, toPips } from "./tools/price.js";
import { config } from "./config.js";
import { isThesisOnCooldown } from "./setup-memory.js";
import { distanceFromEntryPips } from "./tools/setup-gates.js";
import { resolveInPlace } from "./management.js";

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
  const tmp = `${SETUPS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, SETUPS_FILE);
}

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

/**
 * Thesis = side + setup type + mode + price area (bucketed by setupMemory.zonePips),
 * so repeated attempts of the same idea in the same area share a history.
 */
export function thesisFingerprint(setup) {
  const pip = config.broker.pipSize || 0.1;
  const bucket = (config.setupMemory?.zonePips ?? 50) * pip;
  const area = Number.isFinite(Number(setup.entry)) ? Math.round(Number(setup.entry) / bucket) * bucket : "?";
  return [setup.side, setup.setup_type || "?", setup.mode || "", typeof area === "number" ? area.toFixed(config.broker.digits ?? 2) : area].join("|");
}

export function getOpenSetups() {
  return Object.values(load().setups || {}).filter((s) => s.status === "proposed" || s.status === "active");
}

export function countSetupsToday() {
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(load().setups || {}).filter((s) => s.proposed_at?.startsWith(today)).length;
}

/**
 * Persist a validated setup. Price/SL/TP gates live in tools/setup-gates.js;
 * this only enforces book-keeping rules (one open per side, cooldown, daily cap).
 * Returns { skipped, reason } or { setup, invalidated? } — `invalidated` is an
 * opposite-side setup closed because the new thesis contradicts it.
 */
export function createSetup(input) {
  const mode = getActiveMode();
  const side = input.side;
  const entry = Number(input.entry);
  const sl = Number(input.sl);
  if (!["long", "short"].includes(side) || !Number.isFinite(entry) || !Number.isFinite(sl)) {
    throw new Error("Invalid setup: side, entry, sl required");
  }

  const llmOwns = config.screening?.llmOwnsTpSl !== false;
  const llmTp = normalizeTpLevels(side, entry, sl, input.tp_levels);
  const tpLevels = llmTp.length || llmOwns ? llmTp : computeTpLevels(side, entry, sl, mode.partialTp || []);
  const tpFinal = tpLevels.at(-1)?.price ?? null;
  const rr = tpFinal != null ? computeRrRatio(side, entry, sl, tpFinal) : null;

  const candidate = {
    side,
    entry,
    sl,
    setup_type: sanitize(input.setup_type, 40),
    mode: mode.id,
  };

  const open = getOpenSetups();
  const sameSide = open.find((s) => s.side === side);
  if (sameSide) return { skipped: true, reason: "open_setup_exists", existing: sameSide.id };

  if (isThesisOnCooldown(candidate)) {
    return { skipped: true, reason: "thesis_cooldown", fingerprint: thesisFingerprint(candidate) };
  }

  const maxPerDay = config.screening.maxSetupsPerDay;
  if (maxPerDay > 0 && countSetupsToday() >= maxPerDay) {
    return { skipped: true, reason: "max_setups_per_day" };
  }

  const data = load();
  let invalidated = null;
  const opposite = open.find((s) => s.side !== side);
  if (opposite) {
    invalidated = resolveInPlace(data.setups[opposite.id], "invalidated", {
      exitPrice: input.price_at_propose ?? null,
      resolve_reason: "thesis_conflict",
    });
  }

  const id = `setup-${Date.now()}`;
  const entryStyle = input.entry_style || "market";
  const priceAtPropose = input.price_at_propose ?? null;
  const now = new Date().toISOString();

  const setup = {
    id,
    symbol: config.market.displayName,
    data_symbol: config.market.feedLabel,
    side,
    entry,
    sl,
    sl_pips: toPips(Math.abs(entry - sl)),
    tp: tpFinal,
    tp_levels: tpLevels,
    rr_ratio: rr,
    bias: sanitize(input.bias, 40),
    confidence: Number(input.confidence) || 0,
    mode: mode.id,
    session: input.session || null,
    entry_style: entryStyle,
    price_at_propose: priceAtPropose,
    entry_distance_pips: priceAtPropose != null ? distanceFromEntryPips({ entry }, priceAtPropose) : null,
    status: entryStyle === "limit" ? "proposed" : "active",
    proposed_at: now,
    activated_at: entryStyle === "limit" ? null : now,
    resolved_at: null,
    outcome: null,
    pnl_pips: null,
    max_rr_reached: 0,
    partial_filled: [],
    remaining_pct: 100,
    screening_snapshot: { ...(input.screening_snapshot || {}), rr_ratio: rr },
    reason: sanitize(input.reason, 500),
    sl_anchor: sanitize(input.sl_anchor, 120),
    risks: Array.isArray(input.risks) ? input.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    thesis_id: sanitize(input.thesis_id || input.reason?.slice(0, 80), 120),
    setup_type: candidate.setup_type,
    strategy_version: config.strategyVersion,
    grade: input.grade ?? null,
    poi_id: input.poi_id ?? null,
    plan_id: input.plan_id ?? null,
    confluence_factors: Array.isArray(input.confluence_factors)
      ? input.confluence_factors.map((c) => sanitize(c, 40)).filter(Boolean).slice(0, 8)
      : [],
  };

  data.setups[id] = setup;
  save(data);
  return { skipped: false, setup, invalidated };
}

export function resolveSetup(id, outcome, extra = {}) {
  const data = load();
  const setup = data.setups?.[id];
  if (!setup) return null;
  resolveInPlace(setup, outcome, extra);
  save(data);
  return setup;
}

/** User-initiated cancel — removes setup from active monitoring (not counted as a trade). */
export function cancelSetup(id, reason = "user_cancelled") {
  const data = load();
  const setup = data.setups?.[id];
  if (!setup || setup.status === "resolved") return null;
  setup.status = "resolved";
  setup.outcome = "cancelled";
  setup.resolved_at = new Date().toISOString();
  setup.pnl_pips = 0;
  setup.resolve_reason = reason;
  save(data);
  log("setups", `Cancelled ${id}: ${reason}`);
  return setup;
}

export function cancelAllOpenSetups(reason = "user_cancelled_all") {
  return getOpenSetups().map((s) => cancelSetup(s.id, reason)).filter(Boolean).map((s) => s.id);
}

export function getSetupsSummary() {
  const open = getOpenSetups();
  if (!open.length) return "No open setups.";
  return open.map((s, i) => {
    const tps = (s.tp_levels || []).map((t) => `TP${t.level}@${t.price}(${t.status})`).join(", ");
    const style = s.entry_style ? ` ${s.entry_style}` : "";
    return `${i + 1}. [${s.status}${style}] ${s.side.toUpperCase()} ${s.symbol} entry ${s.entry} SL ${s.sl} | ${tps || "no TP"} | conf ${s.confidence}% | ${s.id}`;
  }).join("\n");
}

/**
 * Write back setups mutated by the management cycle. A setup resolved elsewhere
 * meanwhile (e.g. /cancel from Telegram) is not resurrected.
 */
export function persistSetups(setups) {
  if (!setups.length) return [];
  const data = load();
  const written = [];
  for (const s of setups) {
    if (data.setups[s.id]?.status === "resolved") continue;
    data.setups[s.id] = s;
    written.push(s);
  }
  save(data);
  return written;
}
