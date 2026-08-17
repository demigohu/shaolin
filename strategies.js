import fs from "fs";
import { repoPath } from "./repo-root.js";

const FILE = repoPath("strategies.json");

const DEFAULTS = {
  active: "scalp_mtf_default",
  strategies: {
    scalp_mtf_default: {
      id: "scalp_mtf_default",
      name: "MTF Scalp Default",
      mode: "scalp",
      mcpStrategy: "supertrend",
      description: "Multi-timeframe alignment scalp on XAUUSD",
      backtest: null,
      approved: true,
    },
  },
};

function load() {
  if (!fs.existsSync(FILE)) return structuredClone(DEFAULTS);
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { ...DEFAULTS, ...data, strategies: { ...DEFAULTS.strategies, ...(data.strategies || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function getActiveStrategy() {
  const data = load();
  return data.strategies[data.active] || data.strategies.scalp_mtf_default;
}

export function saveBacktestResult(strategyId, result) {
  const data = load();
  const s = data.strategies[strategyId];
  if (!s) throw new Error(`Unknown strategy: ${strategyId}`);
  s.backtest = { ...result, last_run: new Date().toISOString() };
  const verdict = result.verdict || result.walk_forward?.verdict;
  const sharpe = result.sharpe_ratio ?? result.metrics?.sharpe_ratio;
  s.approved = verdict === "ROBUST" || verdict === "MODERATE" || (sharpe != null && sharpe >= 0.5);
  save(data);
  return s;
}

export function listStrategies(mode = null) {
  const data = load();
  return Object.values(data.strategies).filter((s) => !mode || s.mode === mode);
}

export function isStrategyApproved(strategyId) {
  const data = load();
  const s = data.strategies[strategyId];
  if (!s) return false;
  return s.approved !== false;
}
