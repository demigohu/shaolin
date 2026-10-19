/**
 * OHLC history for structure levels (PDH/PDL, Asian range, swings, OBs).
 *
 * The TradingView MCP only exposes the CURRENT bar + monthly pivots, so candle
 * history comes from Twelve Data (XAU/USD spot, real time) when TWELVEDATA_API_KEY
 * is set, with Yahoo's chart API (GC=F futures) as the fallback. Futures trade at a
 * basis to spot (TVC:GOLD, what the agent screens/manages on), so every candle is
 * shifted by that basis.
 *
 * Yahoo's COMEX feed is ~10 minutes delayed, so "latest futures − live spot" is
 * wrong by however far gold moved in those minutes. The basis is instead measured
 * at a shared instant: the open of the current TradingView 1h/15m bar vs the
 * Yahoo 5m candle starting at the same timestamp.
 */

import fs from "fs";
import { proxyDispatcher, describeError, httpGet } from "./http.js";
import { repoPath } from "../repo-root.js";
import { sessionDailies } from "../smc-analysis.js";
import { tzOffsetHours } from "../smc-sessions.js";
import { config } from "../config.js";
import { log } from "../logger.js";

const TTL_MS = { "5m": 60_000, "15m": 120_000, "1h": 300_000, "1d": 900_000 };
const RANGE = { "5m": "2d", "15m": "5d", "1h": "1mo", "1d": "1y" };
const STALE_OK_MS = 30 * 60_000;
const H4_MS = 4 * 60 * 60_000;
const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
const PROXY_ATTEMPTS = 3;

const BASIS_FILE = repoPath("basis-state.json");
const cache = new Map();

// Persisted so a restart in the first ~10 min of an hour (before Yahoo publishes the
// anchor candle) can still reuse a recent measurement.
let lastBasis = (() => {
  try {
    const b = JSON.parse(fs.readFileSync(BASIS_FILE, "utf8"));
    return Number.isFinite(b.basis) && Number.isFinite(b.at) ? b : null;
  } catch {
    return null;
  }
})();

function rememberBasis(basis) {
  lastBasis = { basis, at: Date.now() };
  try {
    fs.writeFileSync(BASIS_FILE, JSON.stringify(lastBasis));
  } catch (error) {
    log("candles_warn", `Could not persist basis: ${error.message}`);
  }
}

/** Try each Yahoo host; through a proxy, each attempt uses a fresh session (another exit IP). */
async function fetchChart(interval) {
  const symbol = encodeURIComponent(config.market.yahooSymbol);
  const errors = [];
  const attempts = proxyDispatcher() ? PROXY_ATTEMPTS : 1;
  let viaProxy = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const dispatcher = proxyDispatcher();
    viaProxy = Boolean(dispatcher);
    for (const host of HOSTS) {
      const url = `https://${host}/v8/finance/chart/${symbol}?interval=${interval}&range=${RANGE[interval]}`;
      try {
        const res = await httpGet(url, { dispatcher });
        if (res.ok) return res.json();
        errors.push(`${host} HTTP ${res.status}`);
      } catch (error) {
        errors.push(`${host} ${describeError(error)}`);
      }
    }
  }
  throw new Error(`${[...new Set(errors)].join(", ")}${viaProxy ? " (via proxy)" : " (no proxy — set PROXY_* in .env)"}`);
}

export async function fetchCandles(interval) {
  const hit = cache.get(interval);
  if (hit && Date.now() - hit.at < TTL_MS[interval]) return hit;

  try {
    const json = await fetchChart(interval);
    const r = json?.chart?.result?.[0];
    if (!r?.timestamp?.length) throw new Error("empty chart");
    const q = r.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      if (![o, h, l, c].every((v) => typeof v === "number" && Number.isFinite(v))) continue;
      candles.push({ t: r.timestamp[i] * 1000, o, h, l, c });
    }
    const entry = { at: Date.now(), candles, last: r.meta?.regularMarketPrice ?? candles.at(-1)?.c ?? null };
    cache.set(interval, entry);
    return entry;
  } catch (error) {
    if (hit && Date.now() - hit.at < STALE_OK_MS) {
      log("candles_warn", `Yahoo ${interval} failed (${error.message}) — using cached candles`);
      return { ...hit, stale: true };
    }
    throw new Error(`Yahoo ${interval} candles: ${error.message}`);
  }
}

export function shiftCandles(candles, basis) {
  if (!basis) return candles;
  return candles.map((k) => ({ t: k.t, o: k.o - basis, h: k.h - basis, l: k.l - basis, c: k.c - basis }));
}

/** Aggregate candles into fixed UTC buckets (e.g. 1h → 4h). */
export function aggregateCandles(candles, bucketMs) {
  const out = [];
  for (const k of candles) {
    const t = Math.floor(k.t / bucketMs) * bucketMs;
    const cur = out.at(-1);
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
    } else {
      out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c });
    }
  }
  return out;
}

/** Aggregate daily candles into Monday-start weeks (UTC). */
export function aggregateWeekly(candles) {
  const out = [];
  for (const k of candles) {
    // +12h: session-dated bars opening Sunday 22:00 UTC belong to Monday's week.
    const d = new Date(k.t + 12 * 3_600_000);
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const cur = out.at(-1);
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
    } else {
      out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c });
    }
  }
  return out;
}

/**
 * Basis from bar opens at the same instant. `anchors` = [{ t, spot }] where spot
 * is the TradingView bar open at UTC time t; returns null if Yahoo has no 5m
 * candle starting at any anchor yet (its feed lags ~10 min).
 */
export function measureBasis(m5Candles, anchors) {
  for (const { t, spot } of [...anchors].sort((a, b) => b.t - a.t)) {
    const k = m5Candles.find((c) => c.t === t);
    if (k && Number.isFinite(spot)) return k.o - spot;
  }
  return null;
}

// ── Twelve Data (XAU/USD spot, real time) ────────────────────────────────────
// Free plan: 800 credits/day, 8/min, 1 credit per request. One 5min series feeds
// 5m + 15m, one 1h series feeds 1h + 4h, the daily series feeds PDH/PWH/PMH.
const TD_URL = "https://api.twelvedata.com/time_series";
const TD_SERIES = {
  // One 1min request (1 credit) also yields 5m/15m: 5000 bars ≈ 83h ≥ the 600 5m bars needed.
  "1min": { size: 5000, ttl: 55_000 },
  "5min": { size: 600, ttl: 60_000 },
  "1h": { size: 400, ttl: 300_000 },
  "1day": { size: 400, ttl: 30 * 60_000 },
};
const M15_MS = 15 * 60_000;
const M5_MS = 5 * 60_000;
const MIN_M1_BARS = 3000;
const MAX_SPOT_GAP = 10; // $ — larger means one of the feeds is wrong

/** Twelve Data `values` (UTC datetimes, strings) → ascending candles. */
export function parseTwelveData(json) {
  if (json?.status !== "ok" || !Array.isArray(json.values)) {
    throw new Error(json?.message || `unexpected response (${json?.code ?? "no status"})`);
  }
  return json.values
    .map((v) => ({
      t: Date.parse(`${String(v.datetime).replace(" ", "T")}${String(v.datetime).length <= 10 ? "T00:00:00" : ""}Z`),
      o: Number(v.open),
      h: Number(v.high),
      l: Number(v.low),
      c: Number(v.close),
    }))
    .filter((k) => [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite))
    .sort((a, b) => a.t - b.t);
}

async function fetchTwelveData(interval) {
  const key = `td:${interval}`;
  const spec = TD_SERIES[interval];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < spec.ttl) return hit.candles;
  const params = new URLSearchParams({
    symbol: "XAU/USD",
    interval,
    outputsize: String(spec.size),
    timezone: "UTC",
    apikey: process.env.TWELVEDATA_API_KEY,
  });
  const res = await httpGet(`${TD_URL}?${params}`);
  const candles = parseTwelveData(await res.json().catch(() => ({})));
  cache.set(key, { at: Date.now(), candles });
  return candles;
}

let m1Unavailable = false;

/** 1m bars (and 5m built from them); falls back to the 5min series without 1m. */
async function fetchEntrySeries() {
  if (!m1Unavailable) {
    try {
      const m1 = await fetchTwelveData("1min");
      if (m1.length >= MIN_M1_BARS) return { m1, m5: aggregateCandles(m1, M5_MS) };
      throw new Error(`only ${m1.length} bars`);
    } catch (error) {
      log("candles_warn", `Twelve Data 1min unusable (${error.message}) — using 5min without 1m refinement for 1h`);
      m1Unavailable = true;
      setTimeout(() => { m1Unavailable = false; }, 3_600_000).unref?.();
    }
  }
  return { m1: null, m5: await fetchTwelveData("5min") };
}

/** Both feeds are spot and real time: the residual gap is a small, live-measured offset. */
function spotBasis(series, spotPrice) {
  const basis = series.length ? series.at(-1).c - spotPrice : 0;
  if (Math.abs(basis) > MAX_SPOT_GAP) {
    log("candles_warn", `Twelve Data vs feed gap ${basis.toFixed(2)} too large — using 0`);
    return 0;
  }
  return basis;
}

async function twelveDataCandleSet(spotPrice) {
  const { m1, m5 } = await fetchEntrySeries();
  const h1 = await fetchTwelveData("1h");
  const d1 = await fetchTwelveData("1day");
  const basis = spotBasis(m5, spotPrice);
  const h1Spot = shiftCandles(h1, basis);
  const m5Spot = shiftCandles(m5, basis);
  // Twelve Data dailies close at 00:00 UTC; gold sessions close 17:00 New York. Rebuild the
  // recent days from 1h on session boundaries (PDH/PDL/PWH/PWL match the broker), and keep
  // older UTC dailies only for monthly levels beyond the 1h window.
  const sessions = sessionDailies(h1Spot, (t) => tzOffsetHours("America/New_York", new Date(t)));
  const firstSession = sessions[0]?.t ?? Infinity;
  const d1Spot = [...shiftCandles(d1, basis).filter((k) => k.t < firstSession), ...sessions];
  return {
    source: "twelvedata",
    basis: Number(basis.toFixed(2)),
    m1: m1 ? shiftCandles(m1, basis) : null,
    m5: m5Spot,
    m15: aggregateCandles(m5Spot, M15_MS),
    h1: h1Spot,
    h4: aggregateCandles(h1Spot, H4_MS),
    d1: d1Spot,
    w1: aggregateWeekly(d1Spot),
  };
}

/**
 * Entry-timeframe candles only (watcher checks): one Twelve Data request, or the
 * cached Yahoo set as fallback (no 1m there). `key` = m1 | m5 | m15 | h1.
 */
export async function getEntryCandles(spotPrice, key = "m5") {
  if (spotPrice == null) return null;
  if (process.env.TWELVEDATA_API_KEY) {
    try {
      if (key === "h1") {
        const h1 = await fetchTwelveData("1h");
        return shiftCandles(h1, spotBasis(h1, spotPrice));
      }
      const { m1, m5 } = await fetchEntrySeries();
      const basis = spotBasis(m5, spotPrice);
      if (key === "m1") return m1 ? shiftCandles(m1, basis) : null;
      const spot = shiftCandles(m5, basis);
      return key === "m15" ? aggregateCandles(spot, M15_MS) : spot;
    } catch (error) {
      log("candles_warn", `Twelve Data entry candles failed (${error.message}) — falling back to Yahoo`);
    }
  }
  const set = await yahooCandleSet(spotPrice, []).catch(() => null);
  return set?.[key] ?? null;
}

/**
 * Candle history on the spot feed: Twelve Data (real time) when TWELVEDATA_API_KEY
 * is set, otherwise — or if it fails (credits, outage) — Yahoo GC=F shifted by the
 * futures→spot basis. Returns null when spot price is unknown.
 */
export async function getSpotCandleSet(spotPrice, anchors = []) {
  if (spotPrice == null) return null;
  if (process.env.TWELVEDATA_API_KEY) {
    try {
      return await twelveDataCandleSet(spotPrice);
    } catch (error) {
      log("candles_warn", `Twelve Data failed (${error.message}) — falling back to Yahoo`);
    }
  }
  return yahooCandleSet(spotPrice, anchors);
}

/** Yahoo GC=F futures candles shifted onto the spot feed (history ~10 min delayed). */
async function yahooCandleSet(spotPrice, anchors) {
  // Sequential — Yahoo throttles bursts from VPS IPs.
  const m5 = await fetchCandles("5m");
  const m15 = await fetchCandles("15m");
  const h1 = await fetchCandles("1h");
  const d1 = await fetchCandles("1d");

  let basis = measureBasis(m5.candles, anchors);
  if (basis != null) {
    rememberBasis(basis);
  } else {
    // First ~10 minutes of an hour: Yahoo hasn't published the anchor candle yet.
    basis = getRecentBasis();
    if (basis == null) throw new Error("cannot measure futures→spot basis yet (Yahoo feed lags ~10 min behind the bar opens)");
    log("candles_warn", `Reusing basis ${basis.toFixed(2)} measured ${Math.round((Date.now() - lastBasis.at) / 60000)}m ago`);
  }

  const h1Spot = shiftCandles(h1.candles, basis);
  const d1Spot = shiftCandles(d1.candles, basis);
  return {
    source: "yahoo",
    basis: Number(basis.toFixed(2)),
    m5: shiftCandles(m5.candles, basis),
    m15: shiftCandles(m15.candles, basis),
    h1: h1Spot,
    h4: aggregateCandles(h1Spot, H4_MS),
    d1: d1Spot,
    w1: aggregateWeekly(d1Spot),
  };
}

/** Last anchor-measured futures→spot basis, if recent enough. */
export function getRecentBasis(maxAgeMs = 2 * 60 * 60_000) {
  if (!lastBasis || Date.now() - lastBasis.at > maxAgeMs) return null;
  return lastBasis.basis;
}
