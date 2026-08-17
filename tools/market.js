import { config } from "../config.js";
import { callMcpTool } from "./mcp-client.js";

export async function getXauusdMtf() {
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
