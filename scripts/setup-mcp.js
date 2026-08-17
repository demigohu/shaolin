#!/usr/bin/env node
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { REPO_ROOT } from "../repo-root.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SRC = path.join(REPO_ROOT, "mcp", "tradingview-mcp");
const VENV = path.join(REPO_ROOT, "mcp", ".venv");
const MCP_BIN = path.join(VENV, "bin", "tradingview-mcp");

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCapture(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  if (fs.existsSync(MCP_BIN)) {
    console.log("✓ TradingView MCP venv OK");
    process.exit(0);
  }
  console.log("⚠ TradingView MCP not installed — run: npm run mcp:install");
  process.exit(0);
}

if (!fs.existsSync(MCP_SRC)) {
  console.error("Missing submodule mcp/tradingview-mcp — run:");
  console.error("  git submodule update --init --recursive");
  process.exit(1);
}

console.log("Setting up TradingView MCP (Python 3.13 venv)...");

const uv = runCapture("which", ["uv"]).stdout?.trim() || "uv";
const pythonCheck = runCapture(uv, ["python", "list"]);
if (pythonCheck.status !== 0) {
  console.log("Installing Python 3.13 via uv...");
  run(uv, ["python", "install", "3.13"]);
}

if (fs.existsSync(VENV)) {
  console.log("Removing old venv...");
  fs.rmSync(VENV, { recursive: true, force: true });
}

run(uv, ["venv", VENV, "--python", "3.13"], { cwd: REPO_ROOT });
run(uv, ["pip", "install", "-e", MCP_SRC, "--python", path.join(VENV, "bin", "python")], { cwd: REPO_ROOT });

if (!fs.existsSync(MCP_BIN)) {
  console.error("Install failed — tradingview-mcp binary not found");
  process.exit(1);
}

console.log("✓ TradingView MCP installed at", MCP_BIN);
