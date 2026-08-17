import { logAction } from "../logger.js";
import { createSetup, getOpenSetups } from "../setups.js";
import { getRecentScreeningDecisions } from "../screening-log.js";
import { getActiveMode, getCurrentSession } from "../modes.js";
import { config } from "../config.js";
import { isStrategyApproved } from "../strategies.js";
import { recallForThesis } from "../setup-memory.js";
import {
  stageSignals,
  getAndClearStagedSignals,
  extractSignalsFromMtf,
  extractSignalsFromCombined,
} from "../signal-tracker.js";
import * as market from "./market.js";
import * as backtest from "./backtest.js";

const PROTECTED_TOOLS = new Set(["propose_setup"]);

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
  get_active_setups: () => ({ setups: getOpenSetups() }),
  get_recent_screening: (args) => ({ decisions: getRecentScreeningDecisions(args?.limit ?? 10) }),
  backtest_strategy: (args) => backtest.runBacktest(args),
  compare_strategies: (args) => backtest.compareStrategies(args),
  propose_setup: (args) => {
    const strategyId = args.strategy_id || config.strategy.activeStrategyId;
    if (config.strategy.requireBacktestApproval && !isStrategyApproved(strategyId)) {
      return {
        success: false,
        blocked: true,
        reason: "strategy_not_backtest_approved",
        strategy_id: strategyId,
      };
    }

    const mode = getActiveMode();
    const staged = getAndClearStagedSignals();
    const screeningSnapshot = {
      ...staged,
      ...(args.screening_snapshot || {}),
      session: getCurrentSession(),
      setup_confidence: args.confidence ?? staged.setup_confidence ?? null,
    };

    const result = createSetup({
      ...args,
      session: getCurrentSession(),
      screening_snapshot: screeningSnapshot,
    });
    if (result.skipped) {
      const extra = result.reason === "thesis_cooldown"
        ? { recall: recallForThesis({ side: args.side, entry: args.entry, sl: args.sl, strategy_id: strategyId, mode: mode.id }) }
        : {};
      return { success: false, skipped: true, reason: result.reason, existing: result.existing, thesis_id: result.thesis_id, ...extra };
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
