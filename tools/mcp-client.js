import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPO_ROOT } from "../repo-root.js";
import { log } from "../logger.js";

const MCP_BIN = path.join(REPO_ROOT, "mcp", ".venv", "bin", "tradingview-mcp");

let client = null;
let transport = null;
let connectPromise = null;

export function getMcpBinPath() {
  return MCP_BIN;
}

export function mcpBinaryExists() {
  return fs.existsSync(MCP_BIN);
}

async function connectMcp() {
  if (client) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    if (!fs.existsSync(MCP_BIN)) {
      throw new Error(`TradingView MCP not installed. Run: npm run mcp:install (${MCP_BIN})`);
    }

    transport = new StdioClientTransport({
      command: MCP_BIN,
      args: [],
      env: {
        ...process.env,
        MARKETAUX_API_TOKEN: process.env.MARKETAUX_API_TOKEN || "",
      },
    });

    client = new Client({ name: "shaolin", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    log("mcp", "TradingView MCP connected");
    return client;
  })();

  try {
    return await connectPromise;
  } catch (error) {
    connectPromise = null;
    client = null;
    throw error;
  }
}

export async function callMcpTool(name, args = {}, timeoutMs = 120000) {
  await connectMcp();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { signal: controller.signal });
    clearTimeout(timer);

    const text = (result.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");

    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text, isError: result.isError };
      }
    }

    if (result.structuredContent) return result.structuredContent;
    return { success: !result.isError, content: result.content };
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") throw new Error(`MCP tool ${name} timed out after ${timeoutMs}ms`);
    throw error;
  }
}

export async function closeMcp() {
  if (transport) {
    await transport.close();
    transport = null;
    client = null;
    connectPromise = null;
    log("mcp", "TradingView MCP disconnected");
  }
}

export async function listMcpTools() {
  await connectMcp();
  const { tools } = await client.listTools();
  return tools;
}
