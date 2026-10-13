/**
 * Daily plan — top-down analysis before each session (PDF: "HTF Analysis, LTF Entries").
 *
 * A planning model reads a higher-timeframe structure view and returns a bias,
 * day invalidation levels and up to 5 POIs (zones where a PDF setup can trigger).
 * The screener then waits for LTF triggers at those POIs; setups are graded
 * A (at a POI, matching side) or B (off-plan, stricter requirements).
 */

import fs from "fs";
import { jsonrepair } from "jsonrepair";
import { repoPath } from "./repo-root.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { getActiveMode } from "./modes.js";
import { buildSMCContext, formatSMCForPrompt, SETUP_TYPES } from "./smc.js";
import { getCalendarEvents, formatCalendarForPrompt } from "./tools/calendar.js";
import { getClient } from "./agent.js";
import { toPips } from "./tools/price.js";
import { tradingDayStart } from "./smc-analysis.js";
import { tzOffsetHours, getWIBNow } from "./smc-sessions.js";

const FILE = repoPath("plan-state.json");
const MAX_POIS = 5;

/** Higher-timeframe view used to plan each mode. */
const PLAN_PROFILE = { scalp: "day", day: "swing", swing: "swing" };
const DEFAULT_PLAN_REACH = { scalp: 400, day: 1000, swing: 3000 };

export function planReachPips(mode) {
  return mode.planReachPips ?? DEFAULT_PLAN_REACH[mode.id] ?? 400;
}

function load() {
  if (!fs.existsSync(FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (error) {
    log("plan_warn", `Invalid plan-state.json: ${error.message}`);
    return null;
  }
}

function save(plan) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, FILE);
}

/** Current plan if it belongs to the active mode, is still valid and not past its trading day. */
export function getActivePlan(now = Date.now()) {
  if (config.plan?.enabled === false) return null;
  const plan = load();
  if (!plan || plan.status !== "active" || plan.mode !== getActiveMode().id) return null;
  if (now >= Date.parse(plan.expires_at)) return null;
  return plan;
}

export function getLastPlan() {
  return load();
}

const SUBMIT_PLAN_TOOL = {
  type: "function",
  function: {
    name: "submit_plan",
    description: "Submit today's trading plan for XAUUSD.",
    parameters: {
      type: "object",
      properties: {
        bias: { type: "string", enum: ["bullish", "bearish", "neutral"] },
        bias_reason: { type: "string", description: "HTF structure + liquidity reasoning, 1–3 sentences" },
        invalidation_above: { type: "number", description: "Plan is void if price trades above this (omit if none)" },
        invalidation_below: { type: "number", description: "Plan is void if price trades below this (omit if none)" },
        pois: {
          type: "array",
          maxItems: MAX_POIS,
          items: {
            type: "object",
            properties: {
              side: { type: "string", enum: ["long", "short"] },
              zone_low: { type: "number" },
              zone_high: { type: "number" },
              level_type: { type: "string", description: "What the zone is, e.g. 'PDL + 1h EQL (SSL) + 4h bullish OB'" },
              setups: { type: "array", items: { type: "string", enum: SETUP_TYPES } },
              trigger: { type: "string", description: "Exact LTF trigger to wait for at this zone" },
              targets: { type: "array", items: { type: "number" }, description: "Opposite liquidity targets, nearest first" },
              note: { type: "string" },
            },
            required: ["side", "zone_low", "zone_high", "level_type", "setups", "trigger"],
          },
        },
        session_notes: { type: "string", description: "What to expect from Asian / London / NY today (AMD), news timing" },
      },
      required: ["bias", "bias_reason", "pois"],
    },
  },
};

function plannerPrompt(mode, reach) {
  return `You are the PLANNER for an XAUUSD ${mode.label} trading agent (feed ${config.market.feedLabel}, 1 pip = ${config.broker.pipSize}).
Do the top-down analysis BEFORE the session, following "Market Structure and Powerful Setups":
- HTF bias from market structure (bullish = breaks swing highs and respects swing lows; mirror for bearish).
- Key levels = HTF order blocks, liquidity pools (PDH/PDL, PWH/PWL, PMH/PML, Asian high/low, equal highs/lows, HOD/LOD), structure.
- When BSL is taken the market tends to reverse down; when SSL is taken it tends to reverse up.
- Daily range: Asian accumulates (range), London open manipulates (often makes HOD/LOD the wrong way), NY distributes / retraces.
- Entries happen later on LTF at these levels via: ${SETUP_TYPES.join(", ")}.

Produce up to ${MAX_POIS} POIs (points of interest) for today:
- Each POI is a ZONE at a real key level from the data, within ${reach} pips of the current price, width ≤ ${Math.round(reach / 4)} pips.
- Side = the trade you would take there (long at SSL/demand, short at BSL/supply), with the setup types and the exact trigger to wait for.
- Targets = the opposite liquidity, nearest first.
- Prefer POIs aligned with the HTF bias; include at most one counter-bias liquidity-raid POI.
- Invalidation: the price beyond which your bias/plan is wrong.
Never invent levels that are not in the data. Call submit_plan exactly once.`;
}

/** Clean model output into a plan: drop malformed / out-of-reach POIs, order zones, cap widths. */
export function sanitizePlan(raw, { price, reach }) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const pois = [];
  for (const p of Array.isArray(raw?.pois) ? raw.pois : []) {
    let lo = num(p.zone_low);
    let hi = num(p.zone_high);
    if (lo == null || hi == null || !["long", "short"].includes(p.side)) continue;
    if (lo > hi) [lo, hi] = [hi, lo];
    if (toPips(hi - lo) > reach / 4) continue;
    if (price != null && Math.min(Math.abs(toPips(lo - price)), Math.abs(toPips(hi - price))) > reach) continue;
    pois.push({
      id: `P${pois.length + 1}`,
      side: p.side,
      zone_low: lo,
      zone_high: hi,
      level_type: String(p.level_type || "").slice(0, 160),
      setups: (Array.isArray(p.setups) ? p.setups : []).filter((s) => SETUP_TYPES.includes(s)),
      trigger: String(p.trigger || "").slice(0, 500),
      targets: (Array.isArray(p.targets) ? p.targets : []).map(num).filter((t) => t != null).slice(0, 3),
      note: p.note ? String(p.note).slice(0, 200) : null,
    });
    if (pois.length >= MAX_POIS) break;
  }
  return {
    bias: ["bullish", "bearish", "neutral"].includes(raw?.bias) ? raw.bias : "neutral",
    bias_reason: String(raw?.bias_reason || "").slice(0, 400),
    invalidation: { above: num(raw?.invalidation_above), below: num(raw?.invalidation_below) },
    pois,
    session_notes: raw?.session_notes ? String(raw.session_notes).slice(0, 800) : null,
  };
}

function parseToolArgs(message) {
  const call = message?.tool_calls?.find((c) => c.function?.name === "submit_plan") || message?.tool_calls?.[0];
  const text = call?.function?.arguments ?? message?.content ?? "";
  const json = String(text).replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1");
  return JSON.parse(jsonrepair(json));
}

/** Build a fresh plan with the planning model, persist it and return it. */
export async function createPlan({ reason = "scheduled" } = {}) {
  const mode = getActiveMode();
  const reach = planReachPips(mode);
  const ctx = await buildSMCContext({ profileId: PLAN_PROFILE[mode.id] ?? "day", reachPips: reach, store: false });
  if (ctx.price == null || !ctx.data.candles) {
    throw new Error(`no ${ctx.price == null ? "price" : "candle history"} — cannot plan without structure levels`);
  }
  const calendar = formatCalendarForPrompt(await getCalendarEvents());
  const model = config.llm.planningModel || config.llm.screeningModel;

  let raw = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2 && !raw; attempt++) {
    try {
      const response = await getClient().chat.completions.create({
        model,
        messages: [
          { role: "system", content: plannerPrompt(mode, reach) },
          { role: "user", content: `${formatSMCForPrompt(ctx)}\n\n${calendar}\n\nBuild today's plan now.` },
        ],
        tools: [SUBMIT_PLAN_TOOL],
        tool_choice: "required",
        temperature: config.llm.temperature,
        max_tokens: config.llm.maxTokens,
      });
      raw = parseToolArgs(response.choices?.[0]?.message);
    } catch (error) {
      lastError = error;
      log("plan_warn", `Planner attempt ${attempt + 1} failed: ${error.message}`);
    }
  }
  if (!raw) throw new Error(`planner failed: ${lastError?.message || "no plan returned"}`);

  const clean = sanitizePlan(raw, { price: ctx.price, reach });
  const now = Date.now();
  const dayEnd = tradingDayStart(now, tzOffsetHours("America/New_York", new Date(now))) + 24 * 3_600_000;
  const plan = {
    id: `plan-${now}`,
    mode: mode.id,
    created_at: new Date(now).toISOString(),
    created_wib: getWIBNow(new Date(now)).label,
    reason,
    model,
    price_at_plan: ctx.price,
    reach_pips: reach,
    ...clean,
    status: "active",
    expires_at: new Date(dayEnd).toISOString(),
  };
  save(plan);
  log("plan", `Plan ${plan.id} [${mode.id}] bias=${plan.bias} pois=${plan.pois.map((p) => `${p.id}:${p.side}@${p.zone_low}-${p.zone_high}`).join(" ") || "none"}`);
  return plan;
}

/** Mark the plan void when price trades through its invalidation. Returns the reason, or null. */
export function checkPlanInvalidation(price, plan = getActivePlan()) {
  if (!plan || price == null) return null;
  const { above, below } = plan.invalidation || {};
  let reason = null;
  if (above != null && price > above) reason = `price ${price} above invalidation ${above}`;
  if (below != null && price < below) reason = `price ${price} below invalidation ${below}`;
  if (!reason) return null;
  save({ ...plan, status: "invalidated", invalidated_at: new Date().toISOString(), invalidated_reason: reason });
  log("plan", `Plan ${plan.id} invalidated: ${reason}`);
  return reason;
}

/** POI that matches a proposed setup: same side, entry inside the zone (± tolerance). */
export function matchPoi(plan, side, entry, tolPips) {
  if (!plan) return null;
  const tol = tolPips * (config.broker.pipSize || 0.1);
  return plan.pois.find((p) => p.side === side && entry >= p.zone_low - tol && entry <= p.zone_high + tol) || null;
}

/**
 * A = at a plan POI on the planned side. B = off-plan: needs higher confidence and
 * more confluence. "unplanned" = no active plan (normal rules).
 */
export function gradeSetup(args, plan, mode, validConfluence) {
  if (!plan) return { ok: true, grade: "unplanned" };
  const poi = matchPoi(plan, args.side, Number(args.entry), mode.entryZonePips ?? 3);
  if (poi) return { ok: true, grade: "A", poi_id: poi.id, plan_id: plan.id };

  const minConf = config.plan?.offPlanMinConfidence ?? 75;
  const minTags = config.plan?.offPlanMinConfluence ?? 3;
  const tags = validConfluence.filter((t) => t !== "plan_poi");
  if (Number(args.confidence) < minConf || tags.length < minTags) {
    return {
      ok: false,
      reason: "off_plan_weak",
      message: `Not at a plan POI (${plan.pois.map((p) => `${p.id} ${p.side} ${p.zone_low}-${p.zone_high}`).join(", ") || "none"}). Off-plan setups need confidence ≥${minConf} and ≥${minTags} confluence (have ${args.confidence}, ${tags.length}). WATCH or wait for a POI.`,
    };
  }
  return { ok: true, grade: "B", plan_id: plan.id };
}

const f2 = (v) => (v == null ? "—" : Number(v).toFixed(2));

export function formatPlanForPrompt(plan, price) {
  if (config.plan?.enabled === false) return "";
  if (!plan) return "── TODAY'S PLAN ──\nNo active plan (planner unavailable or invalidated) — normal rules apply.";
  const lines = [
    `── TODAY'S PLAN (${plan.created_wib}, bias ${plan.bias.toUpperCase()}) ──`,
    plan.bias_reason,
    `Invalidation: above ${f2(plan.invalidation.above)} / below ${f2(plan.invalidation.below)}`,
  ];
  for (const p of plan.pois) {
    const inside = price != null && price >= p.zone_low && price <= p.zone_high;
    const dist = price == null ? "?" : inside ? "PRICE INSIDE" : `${Math.min(Math.abs(toPips(p.zone_low - price)), Math.abs(toPips(p.zone_high - price)))}p away`;
    lines.push(`${p.id} ${p.side.toUpperCase()} ${f2(p.zone_low)}–${f2(p.zone_high)} [${dist}] ${p.level_type}`);
    lines.push(`   setups: ${p.setups.join(", ") || "?"} | trigger: ${p.trigger}${p.targets.length ? ` | targets: ${p.targets.map(f2).join(", ")}` : ""}`);
  }
  if (plan.session_notes) lines.push(`Session notes: ${plan.session_notes}`);
  lines.push(`Grading: at a POI on its side = A-grade (add plan_poi to confluence). Off-plan = B-grade: needs confidence ≥${config.plan?.offPlanMinConfidence ?? 75} and ≥${config.plan?.offPlanMinConfluence ?? 3} confluence, otherwise WATCH.`);
  return lines.join("\n");
}

export function formatPlanMessage(plan, calendarSummary = "") {
  if (!plan) return "No active plan.";
  const lines = [
    `🗺 SHAOLIN PLAN — ${plan.mode} | ${plan.created_wib}${plan.reason !== "scheduled" ? ` (${plan.reason})` : ""}`,
    "━━━━━━━━━━━━━━━",
    `Bias: ${plan.bias.toUpperCase()} — ${plan.bias_reason}`,
    `Invalid: above ${f2(plan.invalidation.above)} / below ${f2(plan.invalidation.below)}`,
    "",
  ];
  for (const p of plan.pois) {
    lines.push(`${p.id} ${p.side === "long" ? "🟢 LONG" : "🔴 SHORT"} ${f2(p.zone_low)}–${f2(p.zone_high)}`);
    lines.push(`   ${p.level_type}`);
    lines.push(`   Wait: ${p.trigger}`);
    if (p.targets.length) lines.push(`   Targets: ${p.targets.map(f2).join(" → ")}`);
  }
  if (!plan.pois.length) lines.push("No POIs within reach — expect mostly WATCH.");
  if (plan.session_notes) lines.push("", `📝 ${plan.session_notes}`);
  const events = calendarSummary.split("\n").filter((l) => l.trim().startsWith("USD") || l.includes("No scheduled"));
  if (events.length) lines.push("", "📅 Events (24h):", ...events.map((l) => `• ${l.trim()}`));
  return lines.join("\n");
}
