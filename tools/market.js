import { config } from "../config.js";
import { callMcpTool } from "./mcp-client.js";
import { getActiveMode } from "../modes.js";
import { log } from "../logger.js";
import { getAsianRange } from "../smc-state.js";
import { buildMtfZoneStack, formatMtfZonesForPrompt } from "../mtf-zones.js";

/** TradingView coin_analysis puts live price under price_data, not top-level. */
export function extractPriceFromAnalysis(analysis) {
  if (!analysis || analysis.error) return null;
  const pd = analysis.price_data || {};
  for (const candidate of [
    pd.current_price,
    pd.close,
    analysis.price,
    analysis.close,
    analysis.indicators?.close,
  ]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function extractPriceFromYahoo(quote) {
  if (!quote || quote.error) return null;
  for (const candidate of [
    quote.price,
    quote.regularMarketPrice,
    quote.last,
    quote.close,
  ]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** MCP may return RSI as number or { value, signal }. */
export function extractRsi(source) {
  if (source == null) return null;
  if (typeof source === "number" && Number.isFinite(source)) return source;
  if (typeof source === "object") {
    const n = Number(source.value ?? source.rsi);
    if (Number.isFinite(n)) return n;
  }
  const n = Number(source);
  return Number.isFinite(n) ? n : null;
}

function biasFromAnalysis(analysis) {
  if (!analysis || analysis.error) return { bias: "Unknown", score: 0 };
  const ms = analysis.market_sentiment || {};
  const signal = String(ms.buy_sell_signal || ms.momentum || "").toLowerCase();
  let score = 0;
  if (signal.includes("buy") || signal.includes("bull")) score = 1;
  if (signal.includes("sell") || signal.includes("bear")) score = -1;
  const rsi = extractRsi(analysis.indicators?.rsi ?? analysis.rsi);
  if (typeof rsi === "number") {
    if (rsi > 55) score += 0.5;
    if (rsi < 45) score -= 0.5;
  }
  const bias = score > 0.5 ? "Bullish" : score < -0.5 ? "Bearish" : "Neutral";
  return { bias, score: score > 0 ? 1 : score < 0 ? -1 : 0, rsi, signal: ms.buy_sell_signal || ms.momentum };
}

export async function getScalpIntradayMtf() {
  const mode = getActiveMode();
  const tfs = (mode.timeframes || ["5m", "15m", "1h", "4h"]).filter((tf) => tf !== "1m");
  const tfResults = {};

  await Promise.all(tfs.map(async (tf) => {
    try {
      const analysis = await callMcpTool("coin_analysis", {
        symbol: config.market.dataSymbol,
        exchange: config.market.dataExchange,
        timeframe: tf,
      });
      if (analysis?.error) {
        tfResults[tf] = { error: analysis.error };
        return;
      }
      const { bias, score, rsi, signal } = biasFromAnalysis(analysis);
      tfResults[tf] = {
        label: `${tf} intraday`,
        bias,
        score,
        rsi,
        signal,
        price: extractPriceFromAnalysis(analysis),
      };
    } catch (error) {
      tfResults[tf] = { error: error.message };
    }
  }));

  const scores = Object.values(tfResults)
    .map((t) => (t.error ? null : t.score))
    .filter((s) => typeof s === "number");
  const netScore = scores.reduce((a, b) => a + b, 0);
  let status = "MIXED/RANGING";
  let confidence = "Low";
  if (netScore >= 3) { status = "FULLY ALIGNED BULLISH"; confidence = "High"; }
  else if (netScore <= -3) { status = "FULLY ALIGNED BEARISH"; confidence = "High"; }
  else if (netScore >= 2) { status = "LEAN BULLISH"; confidence = "Medium"; }
  else if (netScore <= -2) { status = "LEAN BEARISH"; confidence = "Medium"; }

  return {
    symbol: config.market.dataSymbol,
    exchange: config.market.dataExchange,
    analysis_type: "Scalp Intraday MTF",
    timeframes: tfResults,
    alignment: {
      status,
      confidence,
      net_score: netScore,
      scores_by_tf: Object.fromEntries(
        Object.entries(tfResults).map(([tf, t]) => [tf, t.score ?? 0]),
      ),
    },
    recommendation: {
      action: netScore >= 2 ? "Scalp long bias — use 1m/5m trigger" : netScore <= -2 ? "Scalp short bias — use 1m/5m trigger" : "No scalp — wait for intraday alignment",
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

export async function getXauusdPrice() {
  return callMcpTool("yahoo_price", {
    symbol: config.market.yahooSymbol,
  });
}

/** Management TP/SL — OANDA/TradingView first, Yahoo GC=F fallback. */
export async function getManagementPrice() {
  const errors = [];

  for (const tf of ["5m", "15m", "1h"]) {
    try {
      const analysis = await callMcpTool("coin_analysis", {
        symbol: config.market.dataSymbol,
        exchange: config.market.dataExchange,
        timeframe: tf,
      });
      if (analysis?.error) {
        errors.push(`oanda/${tf}: ${analysis.error}`);
        continue;
      }
      const price = extractPriceFromAnalysis(analysis);
      if (price != null) {
        return {
          price,
          source: "oanda",
          timeframe: tf,
          symbol: `${config.market.dataExchange}:${config.market.dataSymbol}`,
        };
      }
      errors.push(`oanda/${tf}: no price in response`);
    } catch (error) {
      errors.push(`oanda/${tf}: ${error.message}`);
    }
  }

  try {
    const quote = await getXauusdPrice();
    const price = extractPriceFromYahoo(quote);
    if (price != null) {
      return {
        price,
        source: "yahoo",
        symbol: config.market.yahooSymbol,
        warnings: errors,
      };
    }
    if (quote?.error) errors.push(`yahoo: ${quote.error}`);
    else errors.push("yahoo: no price in response");
  } catch (error) {
    errors.push(`yahoo: ${error.message}`);
  }

  log("mgmt_warn", `All price sources failed: ${errors.join(" | ")}`);
  return { price: null, source: null, errors };
}

export async function getGoldNews(limit = 5) {
  return callMcpTool("financial_news", {
    symbol: "XAUUSD",
    category: "all",
    limit,
  });
}

export async function getMarketSnapshot() {
  return callMcpTool("market_snapshot", {});
}

export async function getCoinAnalysis(timeframe = "15m") {
  return callMcpTool("coin_analysis", {
    symbol: config.market.dataSymbol,
    exchange: config.market.dataExchange,
    timeframe,
  });
}

/** HTF→LTF S/R zone stack for scalp entries (independent of SMC prefetch). */
export async function getMtfZoneStack() {
  if (config.mtfZones?.enabled === false) {
    return { disabled: true, summary: "MTF zones disabled in config." };
  }

  const tfs = config.mtfZones?.timeframes ?? ["4h", "1h", "15m", "5m"];
  const analyses = {};

  await Promise.all(tfs.map(async (tf) => {
    try {
      analyses[tf] = await callMcpTool("coin_analysis", {
        symbol: config.market.dataSymbol,
        exchange: config.market.dataExchange,
        timeframe: tf,
      });
    } catch (error) {
      analyses[tf] = { error: error.message, timeframe: tf };
    }
  }));

  let daily = null;
  try {
    daily = await callMcpTool("coin_analysis", {
      symbol: config.market.dataSymbol,
      exchange: config.market.dataExchange,
      timeframe: "1D",
    });
    analyses["1D"] = daily;
  } catch (error) {
    analyses["1D"] = { error: error.message };
  }

  const price = extractPriceFromAnalysis(analyses["5m"])
    ?? extractPriceFromAnalysis(analyses["15m"])
    ?? extractPriceFromAnalysis(analyses["1h"]);

  const pd = daily?.price_data || {};
  const asian = getAsianRange();
  const h4Struct = analyses["4h"]?.market_structure;
  const h1Struct = analyses["1h"]?.market_structure;

  const stack = buildMtfZoneStack({
    analyses,
    price,
    extras: {
      pdh: pd.high ?? null,
      pdl: pd.low ?? null,
      asian,
    },
    htf: {
      h4_trend: h4Struct?.trend,
      h1_trend: h1Struct?.trend,
    },
  });

  return {
    ...stack,
    summary: formatMtfZonesForPrompt(stack),
  };
}
