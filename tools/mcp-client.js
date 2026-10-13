import fs from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_ROOT } from "../repo-root.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { proxyUrl } from "./http.js";

const MCP_BIN = path.join(REPO_ROOT, "mcp", ".venv", "bin", "tradingview-mcp");
const SECRET_ENV = ["LLM_API_KEY", "OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"];

let client = null;
let transport = null;
let connectPromise = null;

export function mcpBinaryExists() {
  return fs.existsSync(MCP_BIN);
}

function resetConnection() {
  client = null;
  transport = null;
  connectPromise = null;
}

async function connectMcp() {
  if (client) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    if (!fs.existsSync(MCP_BIN)) {
      throw new Error(`TradingView MCP not installed. Run: npm run mcp:install (${MCP_BIN})`);
    }

    const env = {
      ...process.env,
      MARKETAUX_API_TOKEN: process.env.MARKETAUX_API_TOKEN || "",
      // The MCP serves its last good TradingView result for up to 6h when TradingView
      // fails ("stale-while-error"). Live SL/TP tracking must never run on such prices,
      // so cap it: past this age a failure surfaces as an error instead.
      TRADINGVIEW_MCP_STALE_TTL: process.env.TRADINGVIEW_MCP_STALE_TTL || "90",
    };
    // Cloud IPs get throttled by TradingView's scanner; route the MCP (requests/httpx honour
    // HTTPS_PROXY) through a Webshare session. Each (re)connect picks a new exit IP.
    const tvProxy = config.market.tradingviewViaProxy ? proxyUrl() : null;
    if (tvProxy) {
      env.HTTPS_PROXY = tvProxy;
      env.HTTP_PROXY = tvProxy;
    }
    for (const key of SECRET_ENV) delete env[key];

    transport = new StdioClientTransport({ command: MCP_BIN, args: [], env, stderr: "pipe" });
    // Server logs every request to stderr — surface only real failures.
    transport.stderr?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (/error|traceback|exception/i.test(line)) log("mcp_stderr", line.trim().slice(0, 300));
      }
    });

    const c = new Client({ name: "shaolin", version: "0.1.0" }, { capabilities: {} });
    c.onclose = () => {
      if (client !== c) return; // closed intentionally via closeMcp()
      log("mcp_warn", "TradingView MCP connection closed — will reconnect on next call");
      resetConnection();
    };
    await c.connect(transport);
    client = c;
    log("mcp", `TradingView MCP connected${tvProxy ? " (via proxy)" : ""}`);
    return client;
  })();

  try {
    return await connectPromise;
  } catch (error) {
    resetConnection();
    throw error;
  }
}

/** MCP tools return errors as { error: { code, message } } — flatten to a string. */
function normalizeError(result) {
  if (result && typeof result === "object" && result.error && typeof result.error === "object") {
    return { ...result, error: result.error.message || JSON.stringify(result.error), error_code: result.error.code };
  }
  return result;
}

export async function callMcpTool(name, args = {}, timeoutMs = 120000) {
  const c = await connectMcp();
  // SDK default request timeout is 60s — must be passed explicitly for slow tools.
  const result = await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });

  const text = (result.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  if (text) {
    try {
      return normalizeError(JSON.parse(text));
    } catch {
      return result.isError ? { error: text.slice(0, 500) } : { raw: text };
    }
  }

  if (result.structuredContent) return normalizeError(result.structuredContent);
  return { success: !result.isError, content: result.content };
}

export async function closeMcp() {
  if (transport) {
    const t = transport;
    resetConnection();
    await t.close();
    log("mcp", "TradingView MCP disconnected");
  }
}
