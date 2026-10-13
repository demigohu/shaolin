/**
 * Recent gold headlines from Marketaux.
 *
 * The MCP's own Marketaux lookup searches "XAU" without a date filter and returns
 * relevance-ranked articles from years ago (plus a keyword "sentiment" score built
 * on them), so Shaolin queries Marketaux directly: gold-related text, last N
 * hours, newest first. Headlines only — the LLM reads them; no synthetic score.
 *
 * Free plan: 100 requests/day, 3 articles/request → cached for `news.cacheMin`
 * and capped at `news.dailyBudget` live requests per day.
 */

import { config } from "../config.js";
import { log } from "../logger.js";

const API_URL = "https://api.marketaux.com/v1/news/all";

let cache = null;
const budget = { day: "", used: 0 };

function budgetLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (budget.day !== today) {
    budget.day = today;
    budget.used = 0;
  }
  return (config.news?.dailyBudget ?? 60) - budget.used;
}

/** Marketaux expects published_after as YYYY-MM-DDTHH:mm (UTC). */
export function marketauxDate(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

export function toHeadlines(articles, now = Date.now(), lookbackHours = 24) {
  const cutoff = now - lookbackHours * 3_600_000;
  return (articles || [])
    .map((a) => ({
      title: String(a.title || "").trim(),
      source: a.source || null,
      published: a.published_at || null,
      age_min: a.published_at ? Math.round((now - Date.parse(a.published_at)) / 60_000) : null,
      summary: String(a.description || a.snippet || "").replace(/<[^>]+>/g, "").trim().slice(0, 240),
      url: a.url || null,
    }))
    .filter((h) => h.title && h.published && Date.parse(h.published) >= cutoff)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}

export async function getGoldHeadlines() {
  const token = process.env.MARKETAUX_API_TOKEN;
  if (!token) return { count: 0, items: [], note: "MARKETAUX_API_TOKEN not set" };

  const cacheMs = (config.news?.cacheMin ?? 30) * 60_000;
  const lookbackHours = config.news?.lookbackHours ?? 24;
  if (cache && Date.now() - cache.at < cacheMs) return cache.result;
  if (budgetLeft() <= 0) {
    return cache ? { ...cache.result, note: "daily news budget used — showing last fetch" } : { count: 0, items: [], note: "daily news budget used" };
  }

  budget.used += 1;
  const params = new URLSearchParams({
    api_token: token,
    search: config.news?.query ?? "gold | bullion | xau",
    language: "en",
    published_after: marketauxDate(Date.now() - lookbackHours * 3_600_000),
    sort: "published_on",
    sort_order: "desc",
    limit: "3",
  });

  try {
    const res = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
    const items = toHeadlines(json.data, Date.now(), lookbackHours);
    const result = { count: items.length, items, lookback_hours: lookbackHours, fetched_at: new Date().toISOString() };
    cache = { at: Date.now(), result };
    return result;
  } catch (error) {
    log("news_warn", `Marketaux: ${error.message}`);
    return cache ? { ...cache.result, note: `fetch failed (${error.message}) — showing last fetch` } : { count: 0, items: [], error: error.message };
  }
}
