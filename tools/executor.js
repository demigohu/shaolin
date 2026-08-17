import { logAction } from "../logger.js";
import { createSetup, getOpenSetups } from "../setups.js";
import { getRecentScreeningDecisions } from "../screening-log.js";
import { getActiveMode, getCurrentSession } from "../modes.js";
import * as market from "./market.js";
import * as backtest from "./backtest.js";

const PROTECTED_TOOLS = new Set(["propose_setup"]);

const toolMap = {
  get_xauusd_mtf: () => market.getXauusdMtf(),
  get_xauusd_combined: (args) => market.getXauusdCombined(args?.timeframe || getActiveMode().combinedTimeframe),
  get_xauusd_price: () => market.getXauusdPrice(),
  get_gold_news: (args) => market.getGoldNews(args?.limit ?? 5),
  get_market_context: () => market.getMarketSnapshot(),
  get_active_setups: () => ({ setups: getOpenSetups() }),
  get_recent_screening: (args) => ({ decisions: getRecentScreeningDecisions(args?.limit ?? 10) }),
  backtest_strategy: (args) => backtest.runBacktest(args),
  compare_strategies: (args) => backtest.compareStrategies(args),
  propose_setup: (args) => {
    const result = createSetup({
      ...args,
      session: getCurrentSession(),
      screening_snapshot: args.screening_snapshot || {},
    });
    if (result.skipped) {
      return { success: false, skipped: true, reason: result.reason, existing: result.existing };
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
      success: !result?.error && result?.success !== false,
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
