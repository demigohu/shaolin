import { config } from "./config.js";
import { getActiveMode, getCurrentSession } from "./modes.js";
import { getActiveStrategy } from "./strategies.js";
import { getSetupsSummary } from "./setups.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getScreeningSummary } from "./screening-log.js";
import { getSetupMemorySummary } from "./setup-memory.js";
import { getWeightsSummary } from "./signal-weights.js";
import { formatSMCForPrompt } from "./smc.js";
import { getAMDPhase, isSMCTradingWindow } from "./smc-sessions.js";

export function buildSystemPrompt(agentType, context = {}) {
  const mode = getActiveMode();
  const strategy = getActiveStrategy();
  const session = getCurrentSession();
  const market = config.market;
  const broker = config.broker;

  const shared = `
── SHAOLIN XAUUSD AGENT ──
Symbol (data): ${market.dataExchange}:${market.dataSymbol}
Broker display: ${broker.name} | pipSize ${broker.pipSize} | offset ${broker.priceOffset}
Active mode: ${mode.id} (${mode.label}) | session: ${session}
Timeframes: ${mode.timeframes.join(" → ")}
Min confidence: ${mode.minConfidence}% | Min RR: ${mode.minRrRatio}
Partial TP: ${mode.partialTp.map((t) => `${t.pct}% @ ${t.atRr}R`).join(", ")}

HARD RULES:
- You NEVER execute trades or claim you entered/exited on a broker.
- Screening produces SETUP recommendations only; user enters manually on MT5.
- Call propose_setup ONLY when action is SETUP with valid entry/SL/confidence.
- For WATCH or AVOID, explain clearly — do not call propose_setup.

Active strategy: ${strategy.name} (${strategy.id})
`.trim();

  if (agentType === "SCREENER") {
    const maxSl = mode.maxSlPips;
    const smcEnabled = config.smc?.enabled !== false;

    return `${shared}

ROLE: SCREENER — Smart Money / Market Structure (PDF framework). At most ONE setup per cycle.

${smcEnabled ? context.prefetchSummary || "Call get_smc_context first for AMD phase, Asian range, liquidity." : ""}

OPEN SETUPS (do NOT call propose_setup if any listed):
${getSetupsSummary()}

WORKFLOW:
1. ${smcEnabled ? "Review SMC context (prefetched or get_smc_context)." : ""} Call get_xauusd_mtf + get_xauusd_combined on ${mode.combinedTimeframe}.
2. Identify: AMD phase, liquidity sweep (BSL/SSL), BMS, SMS, OB/RTO, fib 0.5–0.72 retrace.
3. SETUP only if ≥${config.smc?.minConfluence ?? 2} confluence factors AND valid setup_type.
4. Entry on RTO / fib retrace — NEVER chase impulsive move after BMS.
5. WATCH or AVOID if unclear.

SETUP TYPES (setup_type on propose_setup):
turtle_soup_long | turtle_soup_short | sh_bms_rto | sms_bms_rto | amd_distribution | fib_retrace

CONFLUENCE (confluence_factors array, min ${config.smc?.minConfluence ?? 2}):
htf_bias | liquidity_sweep | order_block_rto | fib_ote | london_open | ny_open | asian_range | session_amd | ltf_structure | news_catalyst

HARD RULES:
- SSL swept → favor LONG setups (turtle_soup_long, RTO long). Do NOT trend-short.
- BSL swept → favor SHORT setups. Do NOT chase long.
- Asian 07–13 WIB = range; London 14–18 = manip; NY 19–22 = distribution.
- Scalp entries prefer London/NY open windows.
- SL max ${maxSl ?? 40} pips on ${mode.combinedTimeframe} structure (not Daily BB).
- Min confidence ${mode.minConfidence}%, min RR ${mode.minRrRatio}.

Session UTC: ${session} | AMD: ${getAMDPhase()} | SMC window: ${isSMCTradingWindow() ? "open" : "closed"}

${config.darwin?.enabled !== false ? getWeightsSummary() : ""}

Thesis memory:
${getSetupMemorySummary()}

Lessons:
${getLessonsForPrompt()}

Recent screening:
${getScreeningSummary()}
`.trim();
  }

  if (agentType === "MANAGER") {
    return `${shared}

ROLE: MANAGER — monitor logged setups (NOT broker positions).

Open setups:
${getSetupsSummary()}

Performance: ${getPerformanceSummary()}

You do NOT close trades on broker. Alert on TP/SL approach is handled deterministically.
Only use tools if you need fresh price or setup list.
`.trim();
  }

  return `${shared}

ROLE: GENERAL — answer questions about XAUUSD screening, setups, backtests, config.

Active strategy: ${strategy.name} (${strategy.id}) — MCP ${strategy.mcpStrategy}

Backtest workflow (when user asks):
1. list_strategies or compare_strategies to explore options
2. backtest_mcp_strategy with strategy name (supertrend, rsi, macd, etc.)
3. If approved and user wants to trade with it: activate_strategy or backtest_mcp_strategy with activate=true
4. Summarize results clearly — return %, Sharpe, win rate, approved yes/no

Available MCP strategies: rsi, bollinger, macd, ema_cross, supertrend, donchian, rsi_pullback, keltner_breakout, triple_ema

Open setups:
${getSetupsSummary()}

Lessons: ${getLessonsForPrompt()}
Performance: ${getPerformanceSummary()}
Recent screening: ${getScreeningSummary()}
`.trim();
}

// formatSetupAlert moved to notifications.js
