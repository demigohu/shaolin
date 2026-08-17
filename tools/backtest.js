import { config } from "../config.js";
import { callMcpTool } from "./mcp-client.js";
import { log } from "../logger.js";

const RETRY_DELAYS_MS = [0, 30_000, 90_000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  return [
    result.error,
    result.message,
    result.detail,
    result.details,
  ].filter(Boolean).join(" ");
}

export function isYahooRateLimitError(result) {
  const text = extractErrorText(result).toLowerCase();
  return text.includes("429")
    || text.includes("too many requests")
    || text.includes("rate limit");
}

export function formatBacktestError(result) {
  if (isYahooRateLimitError(result)) {
    return [
      "Yahoo Finance rate limit (HTTP 429).",
      "IP VPS kena throttle — bukan bug Shaolin.",
      "",
      "Coba:",
      "• Tunggu 5–10 menit, lalu /backtest supertrend lagi",
      "• Jangan spam compare + backtest beruntun",
      "• Opsional: set PROXY_* di .env (Webshare) — lihat .env.example",
      "",
      "Screening tetap jalan (pakai OANDA/TradingView, bukan Yahoo).",
    ].join("\n");
  }
  return extractErrorText(result) || "Backtest failed";
}

export async function runBacktest({ strategy, period = "1y", interval = "1h", strategyId = null }) {
  const symbol = config.market.yahooSymbol;
  let lastResult = null;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      log("backtest", `Yahoo 429 — retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }

    const result = await callMcpTool("backtest_strategy", {
      symbol,
      strategy,
      period,
      interval,
      include_trade_log: false,
      include_equity_curve: false,
    }, 180000);

    lastResult = result;

    if (!result?.error && !isYahooRateLimitError(result)) {
      if (strategyId && result) {
        const { saveBacktestResult } = await import("../strategies.js");
        saveBacktestResult(strategyId, { ...result, strategy, period, interval, symbol });
      }
      return result;
    }

    if (!isYahooRateLimitError(result)) {
      return result;
    }
  }

  return {
    error: formatBacktestError(lastResult),
    rate_limited: true,
    symbol,
    strategy,
  };
}

export async function compareStrategies({ period = "1y", interval = "1h" } = {}) {
  const result = await callMcpTool("compare_strategies", {
    symbol: config.market.yahooSymbol,
    period,
    interval,
  }, 300000);

  if (isYahooRateLimitError(result)) {
    return { error: formatBacktestError(result), rate_limited: true };
  }
  return result;
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

  if (isYahooRateLimitError(result)) {
    return { error: formatBacktestError(result), rate_limited: true };
  }

  if (strategyId && result && !result.error) {
    const { saveBacktestResult } = await import("../strategies.js");
    saveBacktestResult(strategyId, { ...result, strategy, period, interval, symbol, verdict: result.verdict });
  }
  return result;
}
