import { logAction } from "../logger.js";
import { createSetup, getOpenSetups } from "../setups.js";
import { getRecentScreeningDecisions, logProposeBlocked } from "../screening-log.js";
import { getActiveMode, getCurrentSession } from "../modes.js";
import { config } from "../config.js";
import { isStrategyApproved, setActiveStrategy, listStrategies, formatStrategiesList, backtestMcpStrategy, strategyIdFor, getActiveStrategy } from "../strategies.js";
import { recallForThesis } from "../setup-memory.js";
import {
  stageSignals,
  getAndClearStagedSignals,
  extractSignalsFromMtf,
  extractSignalsFromCombined,
} from "../signal-tracker.js";
import { buildSMCContext, validateSMCSetup, getLastSMCContext, formatSMCForPrompt } from "../smc.js";
import { resolveProposePrice, validateProposedEntry } from "./setup-gates.js";
import * as market from "./market.js";
import * as backtest from "./backtest.js";

const PROTECTED_TOOLS = new Set(["propose_setup"]);

function recordProposeBlocked(result, args) {
  if (result?.blocked || result?.skipped) {
    logProposeBlocked(result, args);
  }
  return result;
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
  get_xauusd_price: () => market.getXauusdPrice(),
  get_gold_news: (args) => market.getGoldNews(args?.limit ?? 5),
  get_market_context: () => market.getMarketSnapshot(),
  get_mtf_zones: () => market.getMtfZoneStack(),
  get_smc_context: async () => {
    const ctx = await buildSMCContext();
    return { ...ctx, summary: formatSMCForPrompt(ctx) };
  },
  get_active_setups: () => ({ setups: getOpenSetups() }),
  get_recent_screening: (args) => ({ decisions: getRecentScreeningDecisions(args?.limit ?? 10) }),
  backtest_strategy: (args) => backtest.runBacktest(args),
  compare_strategies: (args) => backtest.compareStrategies(args),
  list_strategies: () => ({
    active: getActiveStrategy().id,
    strategies: listStrategies(),
    summary: formatStrategiesList(),
  }),
  backtest_mcp_strategy: (args) => backtestMcpStrategy(args.strategy, {
    period: args.period,
    interval: args.interval,
    activate: args.activate === true,
  }),
  activate_strategy: (args) => {
    try {
      const id = args.strategy_id
        || (args.mcp_strategy ? strategyIdFor(args.mcp_strategy) : null);
      if (!id) return { error: "strategy_id or mcp_strategy required" };
      const s = setActiveStrategy(id);
      return { success: true, active: s.id, mcpStrategy: s.mcpStrategy, name: s.name };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
  propose_setup: async (args) => {
    const strategyId = args.strategy_id || getActiveStrategy().id;
    if (config.strategy.requireBacktestApproval && !isStrategyApproved(strategyId)) {
      return recordProposeBlocked({
        success: false,
        blocked: true,
        reason: "strategy_not_backtest_approved",
        strategy_id: strategyId,
      }, args);
    }

    const mode = getActiveMode();
    const staged = getAndClearStagedSignals();
    const screeningSnapshot = {
      ...staged,
      ...(args.screening_snapshot || {}),
      session: getCurrentSession(),
      setup_confidence: args.confidence ?? staged.setup_confidence ?? null,
    };

    const rsi = screeningSnapshot.rsi;
    if (config.screening?.blockExtremeRsi !== false && typeof rsi === "number") {
      const noShort = config.screening.rsiNoShortBelow ?? 35;
      const noLong = config.screening.rsiNoLongAbove ?? 65;
      if (args.side === "short" && rsi < noShort) {
        return recordProposeBlocked({
          success: false,
          blocked: true,
          reason: "rsi_oversold_no_short",
          rsi,
          message: `RSI ${rsi} oversold — avoid short scalp (bounce risk). Prefer WATCH or wait for pullback.`,
        }, args);
      }
      if (args.side === "long" && rsi > noLong) {
        return recordProposeBlocked({
          success: false,
          blocked: true,
          reason: "rsi_overbought_no_long",
          rsi,
          message: `RSI ${rsi} overbought — avoid long scalp. Prefer WATCH.`,
        }, args);
      }
    }

    const smcCheck = validateSMCSetup(
      { ...args, screening_snapshot: screeningSnapshot },
      getLastSMCContext(),
    );
    if (!smcCheck.ok) {
      return recordProposeBlocked({
        success: false,
        blocked: true,
        reason: smcCheck.reason,
        message: smcCheck.message,
      }, args);
    }

    const proposePrice = await resolveProposePrice(market);
    const entryCheck = validateProposedEntry(args, proposePrice, mode);
    if (!entryCheck.ok) {
      return recordProposeBlocked({
        success: false,
        blocked: true,
        reason: entryCheck.reason,
        message: entryCheck.message,
        price_at_propose: entryCheck.price_at_propose,
        entry_distance_pips: entryCheck.distPips,
        distPips: entryCheck.distPips,
      }, args);
    }

    const result = createSetup({
      ...args,
      entry: entryCheck.entry ?? args.entry,
      setup_type: smcCheck.setup_type || args.setup_type,
      confluence_factors: smcCheck.confluence || args.confluence_factors,
      session: getCurrentSession(),
      screening_snapshot: screeningSnapshot,
      entry_style: entryCheck.entry_style,
      price_at_propose: entryCheck.price_at_propose,
      entry_distance_pips: entryCheck.distPips,
    });
    if (result.skipped) {
      const extra = result.reason === "thesis_cooldown"
        ? { recall: recallForThesis({ side: args.side, entry: args.entry, sl: args.sl, strategy_id: strategyId, mode: mode.id }) }
        : {};
      return recordProposeBlocked({
        success: false,
        skipped: true,
        reason: result.reason,
        existing: result.existing,
        thesis_id: result.thesis_id,
        sl_pips: result.sl_pips,
        max_sl_pips: result.max_sl_pips,
        min_sl_pips: result.min_sl_pips,
        rr_ratio: result.rr_ratio,
        min_rr: result.min_rr,
        message: result.reason === "open_setup_exists"
          ? `Open setup ${result.existing} still active — management handles it`
          : result.reason === "sl_too_wide"
            ? `SL ${result.sl_pips} pips exceeds max ${result.max_sl_pips} for ${mode.id}`
            : result.reason === "sl_too_tight"
              ? `SL ${result.sl_pips} pips below min ${result.min_sl_pips} — place SL below next structure level, not on top of entry zone`
              : result.reason === "rr_too_low"
                ? `RR ${result.rr_ratio} below min ${result.min_rr}`
                : undefined,
        ...extra,
      }, args);
    }
    return { success: true, setup: result.setup };
  },
};

export async function executeTool(name, args = {}) {
  const clean = name.replace(/<.*$/, "").trim();
  const fn = toolMap[clean];
  if (!fn) return { error: `Unknown tool: ${clean}` };

  const start = Date.now();
  try {
    const result = await fn(args || {});
    logAction({
      tool: clean,
      args,
      result,
      duration_ms: Date.now() - start,
      success: !result?.error && result?.success !== false && !result?.blocked,
    });
    return result;
  } catch (error) {
    const result = { error: error.message, success: false };
    logAction({
      tool: clean,
      args,
      result,
      duration_ms: Date.now() - start,
      success: false,
    });
    return result;
  }
}

export { PROTECTED_TOOLS };
