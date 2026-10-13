import { config } from "./config.js";
import { getActiveMode, getCurrentSession, getModeIntervals } from "./modes.js";
import { getOpenSetups, getSetupsSummary } from "./setups.js";
import { getPerformanceSummary } from "./lessons.js";
import { getSetupMemorySummary } from "./setup-memory.js";
import { formatPerformanceStats } from "./performance-stats.js";
import { getScreeningSummary } from "./screening-log.js";

export function formatAgentStatus() {
  const mode = getActiveMode();
  const { screeningIntervalMin, managementIntervalMin } = getModeIntervals();
  const open = getOpenSetups();

  const lines = [
    "🥋 SHAOLIN STATUS",
    `Mode: ${mode.id} (${mode.label}) | Session: ${getCurrentSession()}`,
    `Feed: ${config.market.feedLabel} (structure candles: Yahoo ${config.market.yahooSymbol}, basis-adjusted) → MT5 ${config.broker.name}`,
    `Cron: screen ${screeningIntervalMin}m | manage ${managementIntervalMin}m`,
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

  lines.push("", formatPerformanceStats(mode.id).split("\n").slice(0, 6).join("\n"));

  lines.push("", "Recent screening:", getScreeningSummary(3));

  return lines.join("\n");
}
