import { config } from "./config.js";
import { getActiveMode, getCurrentSession, getModeIntervals } from "./modes.js";
import { getOpenSetups, getSetupsSummary } from "./setups.js";
import { getActiveStrategy, isStrategyApproved } from "./strategies.js";
import { getPerformanceSummary } from "./lessons.js";
import { getSetupMemorySummary } from "./setup-memory.js";
import { getWeightsSummary } from "./signal-weights.js";
import { getScreeningSummary } from "./screening-log.js";

export function formatAgentStatus() {
  const mode = getActiveMode();
  const strategy = getActiveStrategy();
  const { screeningIntervalMin, managementIntervalMin } = getModeIntervals();
  const open = getOpenSetups();

  const lines = [
    "🥋 SHAOLIN STATUS",
    `Mode: ${mode.id} (${mode.label}) | Session: ${getCurrentSession()}`,
    `Symbol: ${config.market.dataExchange}:${config.market.dataSymbol} → MT5 ${config.broker.name}`,
    `Cron: screen ${screeningIntervalMin}m | manage ${managementIntervalMin}m`,
    `Strategy: ${strategy.name} (${strategy.id}) — ${isStrategyApproved(strategy.id) ? "approved" : "not approved"}`,
    `Backtest gate: ${config.strategy.requireBacktestApproval ? "ON" : "off"}`,
    `Open setups: ${open.length}`,
  ];

  if (open.length) {
    lines.push("", getSetupsSummary());
  }

  lines.push(
    "",
    getPerformanceSummary(),
    "",
    "Thesis memory:",
    getSetupMemorySummary(3),
  );

  if (config.darwin?.enabled !== false) {
    lines.push("", getWeightsSummary().split("\n").slice(0, 6).join("\n"));
  }

  lines.push("", "Recent screening:", getScreeningSummary(3));

  return lines.join("\n");
}
