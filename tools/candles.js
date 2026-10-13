/**
 * OHLC history for structure levels (PDH/PDL, Asian range, swings, OBs).
 *
 * The TradingView MCP only exposes the CURRENT bar + monthly pivots, so real
 * candle history comes from Yahoo's chart API (GC=F futures). Futures trade at a
 * basis to spot (TVC:GOLD, what the agent screens/manages on), so every candle is
 * shifted by `basis = futures_last - spot_last` measured at fetch time.
 */

import { fetch as undiciFetch, ProxyAgent } from "undici";
import { config } from "../config.js";
import { log } from "../logger.js";

const TTL_MS = { "5m": 60_000, "15m": 120_000, "1h": 300_000, "1d": 900_000 };
const RANGE = { "5m": "2d", "15m": "5d", "1h": "1mo", "1d": "1y" };
const STALE_OK_MS = 30 * 60_000;
const H4_MS = 4 * 60 * 60_000;
const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

const cache = new Map();
let lastBasis = null;

/**
 * Same Webshare env vars the MCP uses (PROXY_ENABLED / PROXY_HOST / PROXY_PORT /
 * PROXY_USERNAME_PREFIX / PROXY_PASSWORD) — cloud IPs are often 429'd by Yahoo.
 */
function proxyDispatcher() {
  const prefix = process.env.PROXY_USERNAME_PREFIX;
  const password = process.env.PROXY_PASSWORD;
  if ((process.env.PROXY_ENABLED ?? "true").toLowerCase() !== "true" || !prefix || !password) return null;
  const min = Number(process.env.PROXY_SESSION_MIN ?? 1);
  const max = Number(process.env.PROXY_SESSION_MAX ?? 250);
  const session = min + Math.floor(Math.random() * (max - min + 1));
  const host = process.env.PROXY_HOST || "p.webshare.io";
  const port = process.env.PROXY_PORT || "80";
  return new ProxyAgent(`http://${encodeURIComponent(`${prefix}-${session}`)}:${encodeURIComponent(password)}@${host}:${port}`);
}

const PROXY_ATTEMPTS = 3;

function describeError(error) {
  const cause = error.cause;
  return cause ? `${error.message}: ${cause.code || cause.message || cause}` : error.message;
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
        const res = await undiciFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(15_000),
          ...(dispatcher ? { dispatcher } : {}),
        });
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
      return hit;
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
    const d = new Date(k.t);
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
 * Fetch 5m/15m/1h/1d futures candles and shift them onto the spot feed.
 * Returns null when spot price is unknown (basis can't be measured).
 */
export async function getSpotCandleSet(spotPrice) {
  if (spotPrice == null) return null;

  // Sequential — Yahoo throttles bursts from VPS IPs.
  const m5 = await fetchCandles("5m");
  const m15 = await fetchCandles("15m");
  const h1 = await fetchCandles("1h");
  const d1 = await fetchCandles("1d");

  const futuresLast = m5.last;
  if (futuresLast == null) return null;
  const basis = futuresLast - spotPrice;
  lastBasis = { basis, at: Date.now() };

  const h1Spot = shiftCandles(h1.candles, basis);
  const d1Spot = shiftCandles(d1.candles, basis);
  return {
    basis: Number(basis.toFixed(2)),
    m5: shiftCandles(m5.candles, basis),
    m15: shiftCandles(m15.candles, basis),
    h1: h1Spot,
    h4: aggregateCandles(h1Spot, H4_MS),
    d1: d1Spot,
    w1: aggregateWeekly(d1Spot),
  };
}

/** Last measured futures→spot basis, if recent enough to convert a Yahoo quote. */
export function getRecentBasis(maxAgeMs = STALE_OK_MS) {
  if (!lastBasis || Date.now() - lastBasis.at > maxAgeMs) return null;
  return lastBasis.basis;
}
