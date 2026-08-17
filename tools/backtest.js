import { config } from "../config.js";
import { callMcpTool } from "./mcp-client.js";
import { saveBacktestResult } from "../strategies.js";

export async function runBacktest({ strategy, period = "1y", interval = "1h", strategyId = null }) {
  const symbol = config.market.yahooSymbol;
  const result = await callMcpTool("backtest_strategy", {
    symbol,
    strategy,
    period,
    interval,
    include_trade_log: false,
    include_equity_curve: false,
  }, 180000);

  if (strategyId && result && !result.error) {
    saveBacktestResult(strategyId, { ...result, strategy, period, interval, symbol });
  }
  return result;
}

export async function compareStrategies({ period = "1y", interval = "1h" } = {}) {
  return callMcpTool("compare_strategies", {
    symbol: config.market.yahooSymbol,
    period,
    interval,
  }, 300000);
}

export async function walkForwardBacktest({ strategy, period = "2y", interval = "1h", strategyId = null }) {
  const symbol = config.market.yahooSymbol;
  const result = await callMcpTool("walk_forward_backtest_strategy", {
    symbol,
    strategy,
    period,
    interval,
    n_splits: 3,
  }, 300000);

  if (strategyId && result && !result.error) {
    saveBacktestResult(strategyId, { ...result, strategy, period, interval, symbol, verdict: result.verdict });
  }
  return result;
}
