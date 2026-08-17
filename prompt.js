import { config } from "./config.js";
import { getActiveMode, getCurrentSession, isSessionAllowed } from "./modes.js";
import { getActiveStrategy } from "./strategies.js";
import { getSetupsSummary } from "./setups.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getScreeningSummary } from "./screening-log.js";
import { formatPriceDual } from "./tools/price.js";
import { getSetupMemorySummary } from "./setup-memory.js";
import { getWeightsSummary } from "./signal-weights.js";

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
    return `${shared}

ROLE: SCREENER — analyze XAUUSD and produce at most one setup per cycle.

WORKFLOW:
1. Call get_xauusd_mtf and get_xauusd_combined (and get_gold_news if macro risk).
2. Synthesize bias, key levels, and whether conditions meet min confidence/RR.
3. If actionable SETUP: call propose_setup with side, entry, sl, confidence, reason, thesis_id, risks.
   Respect thesis memory cooldowns and prioritize higher-weighted signals.
4. If not ready: respond with action WATCH or AVOID — no propose_setup.

Session allowed: ${isSessionAllowed(mode) ? "yes" : "no — prefer AVOID/WATCH"}

${config.darwin?.enabled !== false ? getWeightsSummary() : ""}

Thesis memory:
${getSetupMemorySummary()}

Lessons:
${getLessonsForPrompt()}

Recent screening:
${getScreeningSummary()}

Preloaded context:
${context.prefetchSummary || "None"}
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

Open setups:
${getSetupsSummary()}

Lessons: ${getLessonsForPrompt()}
Performance: ${getPerformanceSummary()}
Recent screening: ${getScreeningSummary()}
`.trim();
}

export function formatSetupAlert(setup) {
  const tps = (setup.tp_levels || []).map((t) => `TP${t.level}: ${formatPriceDual(t.price)} (${t.close_pct}%)`).join("\n");
  return [
    `🥋 SHAOLIN SETUP — ${setup.symbol} ${setup.side.toUpperCase()}`,
    `Entry: ${formatPriceDual(setup.entry)}`,
    `SL: ${formatPriceDual(setup.sl)} (${setup.sl_pips} pips)`,
    tps || `TP: ${formatPriceDual(setup.tp)}`,
    `RR: ${setup.rr_ratio} | Confidence: ${setup.confidence}% | Mode: ${setup.mode}`,
    `Reason: ${setup.reason}`,
    setup.risks?.length ? `⚠️ Risks: ${setup.risks.join("; ")}` : null,
    `→ Entry manual di MT5 (${config.broker.name})`,
    `Setup ID: ${setup.id}`,
  ].filter(Boolean).join("\n");
}
