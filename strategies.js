import fs from "fs";
import { repoPath } from "./repo-root.js";
import { config } from "./config.js";
import { runBacktest } from "./tools/backtest.js";
import { log } from "./logger.js";

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

export function getStrategy(strategyId) {
  const data = load();
  return data.strategies[strategyId] || null;
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
  const minSharpe = config.strategy.minSharpe ?? 0.5;
  s.approved = verdict === "ROBUST" || verdict === "MODERATE" || (sharpe != null && sharpe >= minSharpe);
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
  if (s.approved === false) return false;
  if (config.strategy.requireBacktestApproval && !s.backtest) return false;
  return true;
}

function evaluateApproval(result) {
  const verdict = result?.verdict || result?.walk_forward?.verdict;
  const sharpe = result?.sharpe_ratio ?? result?.metrics?.sharpe_ratio;
  const minSharpe = config.strategy.minSharpe ?? 0.5;
  return verdict === "ROBUST"
    || verdict === "MODERATE"
    || (sharpe != null && sharpe >= minSharpe);
}

export async function ensureStrategyApproved(strategyId = null) {
  const id = strategyId || config.strategy.activeStrategyId;
  const strategy = getStrategy(id) || getActiveStrategy();

  if (!config.strategy.requireBacktestApproval) {
    return { approved: true, skipped: true, strategy_id: strategy.id };
  }

  if (isStrategyApproved(strategy.id) && strategy.backtest) {
    return { approved: true, strategy_id: strategy.id, backtest: strategy.backtest };
  }

  log("backtest_gate", `Running backtest for ${strategy.id} (${strategy.mcpStrategy})`);
  const result = await runBacktest({
    strategy: strategy.mcpStrategy,
    period: config.strategy.backtestPeriod,
    interval: config.strategy.backtestInterval,
    strategyId: strategy.id,
  });

  if (result?.error) {
    return {
      approved: false,
      strategy_id: strategy.id,
      error: result.error,
      backtest: result,
    };
  }

  const updated = getStrategy(strategy.id);
  return {
    approved: evaluateApproval(result) && updated?.approved !== false,
    strategy_id: strategy.id,
    backtest: updated?.backtest || result,
  };
}
