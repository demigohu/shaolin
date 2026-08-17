import fs from "fs";
import { repoPath } from "./repo-root.js";
import { config } from "./config.js";
import { runBacktest } from "./tools/backtest.js";
import { log } from "./logger.js";

const FILE = repoPath("strategies.json");

export const MCP_STRATEGIES = [
  "rsi", "bollinger", "macd", "ema_cross", "supertrend",
  "donchian", "rsi_pullback", "keltner_breakout", "triple_ema",
];

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

export function strategyIdFor(mcpStrategy, modeId = config.activeMode) {
  return `${modeId}_${mcpStrategy}`;
}

export function ensureStrategyEntry(mcpStrategy, modeId = config.activeMode) {
  if (!MCP_STRATEGIES.includes(mcpStrategy)) {
    throw new Error(`Unknown MCP strategy: ${mcpStrategy}`);
  }
  const data = load();
  const id = strategyIdFor(mcpStrategy, modeId);
  if (!data.strategies[id]) {
    data.strategies[id] = {
      id,
      name: `${modeId} / ${mcpStrategy}`,
      mode: modeId,
      mcpStrategy,
      description: `MCP ${mcpStrategy} on XAUUSD`,
      backtest: null,
      approved: false,
    };
    save(data);
  }
  return data.strategies[id];
}

export function setActiveStrategy(strategyId) {
  const data = load();
  const s = data.strategies[strategyId];
  if (!s) throw new Error(`Unknown strategy: ${strategyId}`);

  if (config.strategy.requireBacktestApproval && !isStrategyApproved(strategyId)) {
    throw new Error(`Strategy ${strategyId} belum backtest-approved. Jalankan /backtest ${s.mcpStrategy} dulu.`);
  }

  data.active = strategyId;
  save(data);
  config.strategy.activeStrategyId = strategyId;
  log("strategy", `Active strategy → ${strategyId} (${s.mcpStrategy})`);
  return s;
}

export function formatBacktestSummary(result, strategy = null) {
  const sharpe = result?.sharpe_ratio ?? result?.metrics?.sharpe_ratio;
  const winRate = result?.win_rate ?? result?.metrics?.win_rate;
  const totalReturn = result?.total_return ?? result?.metrics?.total_return ?? result?.total_return_pct;
  const maxDd = result?.max_drawdown ?? result?.metrics?.max_drawdown;
  const approved = strategy?.approved ?? evaluateApproval(result);

  const fmtPct = (v) => {
    if (v == null) return "n/a";
    const n = Number(v);
    if (!Number.isFinite(n)) return "n/a";
    return `${(Math.abs(n) <= 1 ? n * 100 : n).toFixed(1)}%`;
  };

  return [
    `📊 Backtest: ${strategy?.mcpStrategy || result?.strategy}`,
    `ID: ${strategy?.id || "—"}`,
    `Period: ${result?.period || config.strategy.backtestPeriod} | Interval: ${result?.interval || config.strategy.backtestInterval}`,
    `Return: ${fmtPct(totalReturn)} | Sharpe: ${sharpe != null ? Number(sharpe).toFixed(2) : "n/a"}`,
    `Win rate: ${fmtPct(winRate)} | Max DD: ${fmtPct(maxDd)}`,
    `Approved: ${approved ? "✅ yes" : "❌ no"} (min Sharpe ${config.strategy.minSharpe ?? 0.5})`,
  ].join("\n");
}

export function formatStrategiesList() {
  const data = load();
  const activeId = data.active;
  return Object.values(data.strategies).map((s) => {
    const mark = s.id === activeId ? "→ ACTIVE" : "";
    const bt = s.backtest?.last_run ? `backtest ${s.backtest.last_run.slice(0, 10)}` : "no backtest";
    return `${mark} ${s.id} (${s.mcpStrategy}) — ${s.approved ? "approved" : "not approved"} | ${bt}`.trim();
  }).join("\n") || "No strategies registered.";
}

export async function backtestMcpStrategy(mcpStrategy, { period, interval, activate = false, modeId } = {}) {
  if (!MCP_STRATEGIES.includes(mcpStrategy)) {
    return { error: `Unknown strategy. Available: ${MCP_STRATEGIES.join(", ")}` };
  }

  const entry = ensureStrategyEntry(mcpStrategy, modeId ?? config.activeMode);
  const result = await runBacktest({
    strategy: mcpStrategy,
    period: period || config.strategy.backtestPeriod,
    interval: interval || config.strategy.backtestInterval,
    strategyId: entry.id,
  });

  if (result?.error) {
    return { error: result.error, strategy_id: entry.id };
  }

  const strategy = getStrategy(entry.id);
  const approved = isStrategyApproved(entry.id);
  let activated = false;

  if (activate) {
    if (approved) {
      setActiveStrategy(entry.id);
      activated = true;
    } else {
      return {
        strategy,
        result,
        approved: false,
        activated: false,
        summary: formatBacktestSummary(result, strategy),
        message: "Backtest selesai tapi belum memenuhi syarat approval — strategy tidak diaktifkan.",
      };
    }
  }

  return {
    strategy,
    result,
    approved,
    activated,
    summary: formatBacktestSummary(result, strategy),
    message: activated
      ? `✅ Strategy ${entry.id} aktif untuk screening.`
      : approved
        ? `Approved. Pakai /use ${mcpStrategy} untuk aktifkan.`
        : "Belum approved — coba strategy lain atau ubah minSharpe di config.",
  };
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
