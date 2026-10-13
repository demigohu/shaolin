/**
 * Outbound HTTP with optional Webshare proxy — same env vars the MCP uses
 * (PROXY_ENABLED / PROXY_HOST / PROXY_PORT / PROXY_USERNAME_PREFIX / PROXY_PASSWORD,
 * PROXY_SESSION_MIN/MAX). Cloud IPs are often throttled by Yahoo / Forex Factory.
 */

import { fetch as undiciFetch, ProxyAgent } from "undici";

/** New ProxyAgent on a random sticky session (another exit IP), or null when not configured. */
export function proxyDispatcher() {
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

export function describeError(error) {
  const cause = error.cause;
  return cause ? `${error.message}: ${cause.code || cause.message || cause}` : error.message;
}

export async function httpGet(url, { dispatcher = null, timeoutMs = 15_000 } = {}) {
  return undiciFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? { dispatcher } : {}),
  });
}

/** GET JSON directly; on failure retry once through the proxy (if configured). */
export async function getJsonWithProxyFallback(url) {
  const errors = [];
  const routes = [["direct", null]];
  const proxy = proxyDispatcher();
  if (proxy) routes.push(["proxy", proxy]);
  for (const [label, dispatcher] of routes) {
    try {
      const res = await httpGet(url, { dispatcher });
      if (res.ok) return await res.json();
      errors.push(`${label} HTTP ${res.status}`);
    } catch (error) {
      errors.push(`${label} ${describeError(error)}`);
    }
  }
  throw new Error(errors.join(", "));
}
