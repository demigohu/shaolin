import { config } from "../config.js";
import { callMcpTool } from "./mcp-client.js";
import { getActiveMode } from "../modes.js";

function biasFromAnalysis(analysis) {
  if (!analysis || analysis.error) return { bias: "Unknown", score: 0 };
  const ms = analysis.market_sentiment || {};
  const signal = String(ms.buy_sell_signal || ms.momentum || "").toLowerCase();
  let score = 0;
  if (signal.includes("buy") || signal.includes("bull")) score = 1;
  if (signal.includes("sell") || signal.includes("bear")) score = -1;
  const rsi = analysis.indicators?.rsi ?? analysis.rsi;
  if (typeof rsi === "number") {
    if (rsi > 55) score += 0.5;
    if (rsi < 45) score -= 0.5;
  }
  const bias = score > 0.5 ? "Bullish" : score < -0.5 ? "Bearish" : "Neutral";
  return { bias, score: score > 0 ? 1 : score < 0 ? -1 : 0, rsi, signal: ms.buy_sell_signal || ms.momentum };
}

export async function getScalpIntradayMtf() {
  const mode = getActiveMode();
  const tfs = mode.timeframes || ["1m", "5m", "15m", "1h"];
  const tfResults = {};

  await Promise.all(tfs.map(async (tf) => {
    try {
      const analysis = await callMcpTool("coin_analysis", {
        symbol: config.market.dataSymbol,
        exchange: config.market.dataExchange,
        timeframe: tf,
      });
      const { bias, score, rsi, signal } = biasFromAnalysis(analysis);
      tfResults[tf] = {
        label: `${tf} intraday`,
        bias,
        score,
        rsi,
        signal,
        price: analysis?.price ?? analysis?.close ?? null,
      };
    } catch (error) {
      tfResults[tf] = { error: error.message };
    }
  }));

  const scores = Object.values(tfResults).map((t) => t.score).filter((s) => typeof s === "number");
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
  return callMcpTool("combined_analysis", {
    symbol: config.market.dataSymbol,
    exchange: config.market.dataExchange,
    timeframe: timeframe || "15m",
  });
}

export async function getXauusdPrice() {
  return callMcpTool("yahoo_price", {
    symbol: config.market.yahooSymbol,
  });
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
