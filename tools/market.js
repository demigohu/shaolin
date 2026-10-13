import { config } from "../config.js";
import { callMcpTool } from "./mcp-client.js";
import { getActiveMode } from "../modes.js";
import { log } from "../logger.js";

const ANALYSIS_TTL_MS = 30_000;
const analysisCache = new Map();

/** TradingView coin_analysis puts live price under price_data, not top-level. */
export function extractPriceFromAnalysis(analysis) {
  if (!analysis || analysis.error) return null;
  const pd = analysis.price_data || {};
  for (const candidate of [pd.current_price, pd.close, analysis.price, analysis.close]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** MCP returns RSI as { value, signal, ... }; older shapes used a bare number. */
export function extractRsi(source) {
  if (source == null) return null;
  if (typeof source === "number") return Number.isFinite(source) ? source : null;
  if (typeof source === "object") {
    const n = Number(source.value ?? source.rsi);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(source);
  return Number.isFinite(n) ? n : null;
}

/**
 * coin_analysis for the configured symbol, cached briefly and de-duplicated so
 * a screening cycle (SMC prefetch + MTF tool + management) doesn't hammer
 * TradingView with identical requests.
 */
export async function fetchAnalysis(timeframe, { maxAgeMs = ANALYSIS_TTL_MS } = {}) {
  const hit = analysisCache.get(timeframe);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.promise;

  const promise = callMcpTool("coin_analysis", {
    symbol: config.market.dataSymbol,
    exchange: config.market.dataExchange,
    timeframe,
  }).catch((error) => ({ error: error.message, timeframe }));
  analysisCache.set(timeframe, { at: Date.now(), promise });

  const result = await promise;
  if (result?.error) analysisCache.delete(timeframe);
  return result;
}

function biasFromAnalysis(analysis) {
  const ms = analysis.market_sentiment || {};
  const signal = String(ms.buy_sell_signal || "").toLowerCase();
  let score = 0;
  if (signal.includes("buy")) score = 1;
  if (signal.includes("sell")) score = -1;
  const rsi = extractRsi(analysis.rsi);
  if (rsi != null) {
    if (rsi > 55) score += 0.5;
    if (rsi < 45) score -= 0.5;
  }
  const bias = score > 0.5 ? "Bullish" : score < -0.5 ? "Bearish" : "Neutral";
  return { bias, score: score > 0.5 ? 1 : score < -0.5 ? -1 : 0, rsi, signal: ms.buy_sell_signal };
}

export async function getScalpIntradayMtf() {
  const mode = getActiveMode();
  const tfs = mode.timeframes || ["5m", "15m", "1h", "4h"];
  const tfResults = {};

  // Sequential — parallel bursts trigger TradingView failure cooldowns.
  for (const tf of tfs) {
    const analysis = await fetchAnalysis(tf);
    if (analysis?.error) {
      tfResults[tf] = { error: analysis.error };
      continue;
    }
    const { bias, score, rsi, signal } = biasFromAnalysis(analysis);
    tfResults[tf] = { label: `${tf} intraday`, bias, score, rsi, signal, price: extractPriceFromAnalysis(analysis) };
  }

  const valid = Object.entries(tfResults).filter(([, t]) => !t.error);
  const netScore = valid.reduce((a, [, t]) => a + t.score, 0);
  let status = "MIXED/RANGING";
  let confidence = "Low";
  if (netScore >= 3) { status = "FULLY ALIGNED BULLISH"; confidence = "High"; }
  else if (netScore <= -3) { status = "FULLY ALIGNED BEARISH"; confidence = "High"; }
  else if (netScore >= 2) { status = "LEAN BULLISH"; confidence = "Medium"; }
  else if (netScore <= -2) { status = "LEAN BEARISH"; confidence = "Medium"; }

  const dir = Math.sign(netScore);
  const divergent = dir === 0 ? [] : valid.filter(([, t]) => t.score === -dir).map(([tf]) => tf);

  return {
    symbol: config.market.feedLabel,
    analysis_type: "Scalp Intraday MTF",
    timeframes: tfResults,
    alignment: {
      status,
      confidence,
      net_score: netScore,
      divergent_timeframes: divergent,
      scores_by_tf: Object.fromEntries(Object.entries(tfResults).map(([tf, t]) => [tf, t.score ?? 0])),
    },
  };
}

export async function getXauusdMtf() {
  const mode = getActiveMode();
  if (mode.mtfStyle === "intraday" || mode.id === "scalp") {
    return getScalpIntradayMtf();
  }
  return callMcpTool("multi_timeframe_analysis", {
    symbol: config.market.dataSymbol,
    exchange: config.market.dataExchange,
  });
}

export async function getXauusdCombined(timeframe) {
  const tf = timeframe || getActiveMode().combinedTimeframe || "5m";
  return callMcpTool("combined_analysis", {
    symbol: config.market.dataSymbol,
    exchange: config.market.dataExchange,
    timeframe: tf,
  });
}

/**
 * Live price on the screening feed (TVC:GOLD). There is deliberately no Yahoo
 * fallback: its COMEX quote is futures (basis away from spot) and ~10 min
 * delayed, which could trigger SL/TP on a price that no longer exists.
 */
export async function getManagementPrice() {
  const errors = [];
  for (const tf of ["5m", "15m", "1h"]) {
    const analysis = await fetchAnalysis(tf, { maxAgeMs: 10_000 });
    if (analysis?.error) {
      errors.push(`tv/${tf}: ${analysis.error}`);
      continue;
    }
    const price = extractPriceFromAnalysis(analysis);
    if (price != null) {
      return { price, source: "tradingview", timeframe: tf, symbol: config.market.feedLabel };
    }
    errors.push(`tv/${tf}: no price in response`);
  }
  log("mgmt_warn", `All price sources failed: ${errors.join(" | ")}`);
  return { price: null, source: null, errors };
}

export async function getGoldNews(limit = 5) {
  return callMcpTool("financial_news", { symbol: "XAUUSD", category: "all", limit });
}

export async function getMarketSnapshot() {
  return callMcpTool("market_snapshot", {});
}
