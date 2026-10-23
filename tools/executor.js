import { logAction } from "../logger.js";
import { createSetup, getOpenSetups } from "../setups.js";
import { getRecentScreeningDecisions, logProposeBlocked } from "../screening-log.js";
import { getActiveMode, getCurrentSession } from "../modes.js";
import { recallForThesis } from "../setup-memory.js";
import { recordSetupOutcome } from "../lessons.js";
import { checkTrackRecord } from "../performance-stats.js";
import { getActivePlan, gradeSetup } from "../planner.js";
import { config } from "../config.js";
import { getCalendarEvents, checkNewsBlackout, formatCalendarForPrompt, upcomingEvents } from "./calendar.js";
import { stageSignals, getAndClearStagedSignals, extractSignalsFromMtf, extractSignalsFromCombined } from "../signal-tracker.js";
import { buildSMCContext, validateSMCSetup, getLastSMCContext, formatSMCForPrompt } from "../smc.js";
import { formatMtfZonesForPrompt } from "../mtf-zones.js";
import {
  validateProposedEntry,
  validateProposedSl,
  validateProposedTp,
  validateSetupReason,
  validateMinRr,
  validateConfidence,
  validateRsi,
  validateTpDistance,
  validateTriggerComplete,
  validateSlBuffer,
} from "./setup-gates.js";
import * as market from "./market.js";

function blocked(check, args) {
  const { ok, ...rest } = check;
  const result = { success: false, blocked: true, ...rest };
  logProposeBlocked(result, args);
  return result;
}

const SKIP_MESSAGES = {
  open_setup_exists: (r) => `Open setup ${r.existing} on the same side is still being managed — WATCH.`,
  thesis_cooldown: () => "This thesis (side + setup type + price area) is on cooldown after repeated losses — WATCH.",
  max_setups_per_day: () => "Daily setup cap reached — WATCH.",
};

async function proposeSetup(args) {
  const mode = getActiveMode();
  const ctx = getLastSMCContext();
  const staged = getAndClearStagedSignals();
  const rsi = staged.rsi ?? ctx?.ltf?.rsi ?? null;

  const smcCheck = validateSMCSetup(args, ctx);
  const trackRecord = checkTrackRecord({ setup_type: args.setup_type, session: getCurrentSession(), mode: mode.id });
  const blackout = checkNewsBlackout(await getCalendarEvents());
  for (const check of [blackout, validateConfidence(args, mode), validateRsi(args, rsi), smcCheck, validateTriggerComplete(args, ctx), trackRecord]) {
    if (!check.ok) return blocked(check, args);
  }

  // Fresh quote — the SMC context can be minutes old by the time the LLM proposes.
  const quote = await market.getManagementPrice().catch(() => null);
  const price = quote?.price ?? ctx?.price ?? null;

  const entryCheck = validateProposedEntry(args, price, mode);
  if (!entryCheck.ok) return blocked(entryCheck, args);

  const tpCheck = validateProposedTp(args);
  for (const check of [validateProposedSl(args, ctx, mode), validateSlBuffer(args, ctx), tpCheck, validateTpDistance(args, mode), validateSetupReason(args), validateMinRr(args, mode)]) {
    if (!check.ok) return blocked(check, args);
  }

  // Plan grading: A at a POI on its side, B off-plan (stricter), "unplanned" without a plan.
  const grade = gradeSetup(args, getActivePlan(), mode, smcCheck.confluence || []);
  if (!grade.ok) return blocked(grade, args);
  // plan_poi is only true when the setup actually sits at a POI.
  const confluence = (smcCheck.confluence || []).filter((c) => c !== "plan_poi");
  if (grade.grade === "A") confluence.push("plan_poi");
  const minConf = config.smc?.minConfluence ?? 2;
  if (confluence.length < minConf) {
    return blocked({ reason: "insufficient_confluence", message: `plan_poi only counts at a plan POI — ${confluence.length} valid confluence factors, need ≥${minConf}.` }, args);
  }

  const screeningSnapshot = {
    ...staged,
    rsi,
    session: getCurrentSession(),
    setup_confidence: Number(args.confidence) || null,
  };

  const result = createSetup({
    ...args,
    tp_levels: tpCheck.tp_levels ?? args.tp_levels,
    setup_type: smcCheck.setup_type || args.setup_type,
    confluence_factors: confluence,
    grade: grade.grade,
    poi_id: grade.poi_id ?? null,
    plan_id: grade.plan_id ?? null,
    session: getCurrentSession(),
    screening_snapshot: screeningSnapshot,
    entry_style: entryCheck.entry_style,
    price_at_propose: entryCheck.price_at_propose,
  });

  if (result.skipped) {
    const recall = result.reason === "thesis_cooldown"
      ? recallForThesis({ side: args.side, entry: args.entry, setup_type: args.setup_type, mode: mode.id })
      : null;
    const out = { success: false, skipped: true, ...result, message: SKIP_MESSAGES[result.reason]?.(result), recall };
    logProposeBlocked(out, args);
    return out;
  }

  if (result.invalidated) recordSetupOutcome(result.invalidated);
  return { success: true, setup: result.setup, invalidated: result.invalidated?.id ?? null };
}

const toolMap = {
  get_xauusd_mtf: async () => {
    const result = await market.getXauusdMtf();
    stageSignals(extractSignalsFromMtf(result));
    return result;
  },
  get_xauusd_combined: async (args) => {
    const result = await market.getXauusdCombined(args?.timeframe || getActiveMode().combinedTimeframe);
    stageSignals(extractSignalsFromCombined(result));
    return result;
  },
  get_xauusd_price: () => market.getManagementPrice(),
  get_gold_news: (args) => market.getGoldNews(args?.limit ?? 3),
  get_economic_calendar: async (args) => {
    const events = await getCalendarEvents();
    return {
      events: upcomingEvents(events, Date.now(), args?.hours ?? 48),
      blackout: checkNewsBlackout(events),
      summary: formatCalendarForPrompt(events),
    };
  },
  get_market_context: () => market.getMarketSnapshot(),
  get_mtf_zones: async () => {
    const ctx = await buildSMCContext();
    return ctx.mtf_zones
      ? { ...ctx.mtf_zones, summary: formatMtfZonesForPrompt(ctx.mtf_zones) }
      : { disabled: true, summary: "MTF zones disabled in config." };
  },
  get_smc_context: async () => {
    const ctx = await buildSMCContext();
    return { ...ctx, summary: formatSMCForPrompt(ctx) };
  },
  get_active_setups: () => ({ setups: getOpenSetups() }),
  get_recent_screening: (args) => ({ decisions: getRecentScreeningDecisions(args?.limit ?? 10) }),
  propose_setup: proposeSetup,
};

export async function executeTool(name, args = {}) {
  const clean = name.replace(/<.*$/, "").trim();
  const fn = toolMap[clean];
  if (!fn) return { error: `Unknown tool: ${clean}` };

  const start = Date.now();
  let result;
  try {
    result = await fn(args || {});
  } catch (error) {
    result = { error: error.message, success: false };
  }
  logAction({
    tool: clean,
    args,
    result,
    duration_ms: Date.now() - start,
    success: !result?.error && result?.success !== false && !result?.blocked,
  });
  return result;
}
