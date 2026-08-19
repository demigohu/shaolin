/** One-line / multi-line summaries of MCP tool results for CLI + logs. */

import { extractPriceFromYahoo } from "./market.js";

export function summarizeToolResult(name, result, args = {}) {
  if (!result) return "empty result";
  if (result.error) return `ERROR: ${result.error}`;
  if (result.blocked) return `BLOCKED: ${result.reason || "unknown"}`;

  switch (name) {
    case "get_xauusd_mtf":
      return summarizeMtf(result);
    case "get_smc_context":
      return result.summary || `SMC ${result.amd_phase} price=${result.price} events=${(result.liquidity_events || []).join(",") || "none"}`;
    case "get_xauusd_combined":
      return summarizeCombined(result, args);
    case "get_xauusd_price": {
      const p = extractPriceFromYahoo(result) ?? result?.price;
      return `price=${p ?? "?"} (${result?.symbol || "XAUUSD"})${result?.error ? ` ERR ${result.error}` : ""}`;
    }
    case "get_gold_news":
      return `news count=${result.count ?? result.items?.length ?? 0}`;
    case "get_market_context":
      return `market snapshot keys=${Object.keys(result).slice(0, 6).join(",")}`;
    case "propose_setup":
      if (result.skipped) return `skipped: ${result.reason}${result.existing ? ` (${result.existing})` : ""}`;
      if (result.setup) {
        const s = result.setup;
        return `SETUP ${s.setup_type || "?"} ${s.side} entry=${s.entry} sl=${s.sl} conf=${s.confidence}% id=${s.id}`;
      }
      return result.success === false ? `failed: ${result.reason || "unknown"}` : "propose_setup ok";
    default:
      return JSON.stringify(result).slice(0, 240);
  }
}

function summarizeMtf(result) {
  if (result.analysis_type === "Scalp Intraday MTF" && result.timeframes) {
    const lines = Object.entries(result.timeframes).map(([tf, t]) => {
      if (t.error) return `${tf}: ERR ${t.error}`;
      const rsi = t.rsi != null ? t.rsi.toFixed?.(1) ?? t.rsi : "?";
      return `${tf}: ${t.bias} rsi=${rsi} score=${t.score ?? 0} px=${t.price ?? "?"}`;
    });
    const align = result.alignment || {};
    return [
      `MTF ${align.status || "?"} | net=${align.net_score ?? "?"} conf=${align.confidence || "?"}`,
      ...lines.map((l) => `  ${l}`),
    ].join("\n");
  }

  if (result.timeframes && typeof result.timeframes === "object") {
    const lines = Object.entries(result.timeframes).map(([tf, t]) => {
      if (t?.error) return `${tf}: ERR ${t.error}`;
      return `${tf}: ${t?.bias || t?.signal || JSON.stringify(t).slice(0, 60)}`;
    });
    return lines.join("\n  ");
  }

  return JSON.stringify(result).slice(0, 320);
}

function summarizeCombined(result, args) {
  const tf = result.timeframe || args.timeframe || "?";
  const tech = result.technical || {};
  const ms = tech.market_sentiment || {};
  const ind = tech.indicators || tech;
  const rsi = ind.rsi ?? tech.rsi;
  const momentum = ms.momentum || ms.buy_sell_signal || "?";
  const sent = result.sentiment?.sentiment_label
    ?? (result.sentiment?.sentiment_score != null ? result.sentiment.sentiment_score : "?");
  const news = result.news?.count ?? 0;
  const note = result.sentiment?.note || result.news?.note || "";
  const conf = result.confluence?.confidence || "?";
  const agree = result.confluence?.signals_agree;
  const lines = [
    `combined@${tf}: ${momentum} RSI=${rsi ?? "?"} sentiment=${sent} news=${news} confluence=${conf}${agree != null ? ` agree=${agree}` : ""}`,
  ];
  if (note) lines.push(`  note: ${String(note).slice(0, 120)}`);
  const headlines = result.news?.latest || result.news?.items || [];
  for (const h of headlines.slice(0, 2)) {
    if (h?.title) lines.push(`  • ${String(h.title).slice(0, 90)}`);
  }
  return lines.join("\n");
}
