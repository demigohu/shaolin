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
    const requireWindow = config.smc?.requireTradingWindow !== false;
    const windowRule = requireWindow
      ? "Scalp entries prefer London 14–19 / NY 19–22 WIB; off-window → WATCH unless turtle soup + liquidity sweep."
      : "requireTradingWindow is OFF — do NOT reject SETUP solely because London/NY window is closed. Still require confluence, valid setup_type, and entry rules.";
    const windowStatus = requireWindow
      ? `SMC window: ${isSMCTradingWindow() ? "open" : "closed"}`
      : "window gate: OFF (any hour OK if rules met)";

    const maxMarketPips = config.screening?.maxEntrySlippagePips ?? mode.entryZonePips ?? 3;
    const maxLimitPips = mode.maxLimitEntryPips ?? config.screening?.maxLimitEntryPips ?? 25;

    const prefetchBlock = smcEnabled && context.prefetchSummary
      ? `${context.prefetchSummary}

PREFETCH ACTIVE — SMC + MTF zones already loaded above.
- Do NOT call get_smc_context or get_mtf_zones (duplicate fetch).
- Start with get_xauusd_mtf + get_xauusd_combined on ${mode.combinedTimeframe}.
- Only call get_xauusd_price if prefetch Price is "?" or null.`
      : smcEnabled
        ? "Call get_smc_context first, then get_xauusd_mtf + get_xauusd_combined."
        : "Call get_mtf_zones, then get_xauusd_mtf + get_xauusd_combined.";

    return `${shared}

ROLE: SCREENER — Smart Money / Market Structure (PDF framework). At most ONE setup per cycle.

${prefetchBlock}

OPEN SETUPS (do NOT call propose_setup if any listed):
${getSetupsSummary()}

WORKFLOW (max ~4 tool calls when prefetch active):
1. Review prefetch SMC: AMD phase, liquidity events, MTF S/R map, suggested_setups.
2. get_xauusd_mtf + get_xauusd_combined (${mode.combinedTimeframe}) — RSI, momentum, news.
3. Decide SETUP / WATCH / AVOID. If Price is null after tools → WATCH immediately (no blind propose).
4. SETUP → propose_setup once. WATCH/AVOID → no propose_setup.

SETUP TYPES (setup_type on propose_setup):
turtle_soup_long | turtle_soup_short | sh_bms_rto | sms_bms_rto | amd_distribution | fib_retrace

CONFLUENCE (confluence_factors array, min ${config.smc?.minConfluence ?? 2}):
htf_bias | mtf_sr_zone | liquidity_sweep | order_block_rto | fib_ote | london_open | ny_open | asian_range | session_amd | ltf_structure | news_catalyst

LIQUIDITY SWEEP → SETUP vs WATCH (you decide — use judgment, not one rigid rule):
| Event | Favor | When to SETUP | When to WATCH |
| ssl_raid_* (below Asian low / PDL) | turtle_soup_long | Price at/near sweep zone (within ~${mode.entryZonePips ?? 5}p of Asian low/SSL level); market entry at SMC Price | Price already bounced far above zone, or no live price |
| bsl_raid_* (above Asian high / PDH) | turtle_soup_short | Price at/near sweep zone (within ~${mode.entryZonePips ?? 5}p above Asian high/BSL level); market entry at SMC Price | Price extended >${maxLimitPips}p above raid level with no rejection yet — wait RTO/limit |
| Sweep + HTF conflict (e.g. BSL + HTF bull) | counter-trend turtle soup | liquidity_sweep + asian_range + ltf_structure (omit htf_bias OR note as risk) | Chase after extended move without structure |

Turtle soup at active sweep ≠ wait for perfect candle — if SMC lists the raid event AND price is in the zone, propose with entry_style "market" and entry = SMC Price.

MTF S/R: reference map only — pick entry/SL from zones + structure; tag mtf_sr_zone when entry aligns.

HARD RULES:
- SSL swept → do NOT trend-short into the sweep. BSL swept → do NOT trend-long chase.
- After BMS without retrace: WATCH or limit — no impulsive chase.
- ${windowRule}
- SL max ${maxSl ?? 40} pips | min confidence ${mode.minConfidence}% | min RR ${mode.minRrRatio}.

ENTRY (propose_setup):
- market: entry = SMC/live price (within ${maxMarketPips}p; executor may snap). Use when sweep/RTO is NOW.
- limit: retrace level within ${maxLimitPips}p of live price (fib/RTO/deeper support).
- Never limit-entry to a level >${maxLimitPips}p away — WATCH instead.

Session UTC: ${session} | AMD: ${getAMDPhase()} | ${windowStatus}

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
