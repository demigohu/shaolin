import "dotenv/config";
import cron from "node-cron";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getActiveMode, getModeIntervals, isSessionAllowed, switchMode } from "./modes.js";
import { appendScreeningDecision } from "./screening-log.js";
import {
  expireStaleSetups,
  getOpenSetups,
  markTpLevelHit,
  persistSetup,
  resolveSetup,
} from "./setups.js";
import { recordSetupOutcome } from "./lessons.js";
import { formatSetupAlert } from "./prompt.js";
import { sendMessage, startPolling, isEnabled as telegramEnabled } from "./telegram.js";
import { closeMcp } from "./tools/mcp-client.js";
import { getXauusdPrice } from "./tools/market.js";
import { toPips } from "./tools/price.js";
import { isStrategyApproved, getActiveStrategy } from "./strategies.js";

let _screeningBusy = false;
let _managementBusy = false;
let cronTasks = [];

function extractLastSetupFromMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (parsed?.setup?.id) return parsed.setup;
    } catch { /* skip */ }
  }
  return null;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) return null;
  _screeningBusy = true;
  const mode = getActiveMode();

  try {
    log("cron", `Screening cycle [${mode.id}]`);

    if (!isSessionAllowed(mode)) {
      const msg = `Session not allowed for ${mode.id} — skipping screening`;
      appendScreeningDecision({ action: "AVOID", summary: msg, reason: "off_session" });
      if (!silent) await sendMessage(`🥋 ${msg}`);
      return msg;
    }

    const strategy = getActiveStrategy();
    if (config.strategy.requireBacktestApproval && !isStrategyApproved(strategy.id)) {
      const msg = `Strategy ${strategy.id} not backtest-approved — skipping`;
      appendScreeningDecision({ action: "AVOID", summary: msg });
      if (!silent) await sendMessage(`🥋 ${msg}`);
      return msg;
    }

    expireStaleSetups(mode.setupMaxAgeMin);

    const goal = `Run XAUUSD screening for ${mode.label}. Analyze MTF + combined TA. If conditions meet min confidence ${mode.minConfidence}% and RR ${mode.minRrRatio}, call propose_setup once. Otherwise report WATCH or AVOID with reason.`;

    const { content, messages } = await agentLoop(goal, config.llm.maxSteps, "SCREENER", config.llm.screeningModel);

    const setup = extractLastSetupFromMessages(messages);
    if (setup) {
      appendScreeningDecision({
        action: "SETUP",
        setup_id: setup.id,
        summary: `${setup.side} @ ${setup.entry} SL ${setup.sl}`,
        reason: setup.reason,
        risks: setup.risks,
        metrics: { confidence: setup.confidence, rr: setup.rr_ratio },
      });
      await sendMessage(formatSetupAlert(setup));
      log("screen", `Setup logged: ${setup.id}`);
    } else {
      const action = /AVOID/i.test(content) ? "AVOID" : "WATCH";
      appendScreeningDecision({ action, summary: content?.slice(0, 200), reason: content?.slice(0, 500) });
      if (!silent) await sendMessage(`🥋 Screening: ${action}\n${(content || "").slice(0, 500)}`);
    }

    return content;
  } finally {
    _screeningBusy = false;
  }
}

function getLivePrice(quote) {
  return quote?.price ?? quote?.regularMarketPrice ?? quote?.last ?? quote?.close ?? null;
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  const mode = getActiveMode();

  try {
    log("cron", "Management cycle");
    expireStaleSetups(mode.setupMaxAgeMin);

    const open = getOpenSetups();
    if (!open.length) return "No open setups";

    let quote;
    try {
      quote = await getXauusdPrice();
    } catch (error) {
      log("mgmt_error", `Price fetch failed: ${error.message}`);
      return null;
    }

    const price = getLivePrice(quote);
    if (price == null) {
      log("mgmt_warn", "No price in quote");
      return null;
    }

    const alerts = [];
    const pip = config.broker.pipSize || 0.01;
    const zone = (mode.entryZonePips ?? 3) * pip;

    for (const setup of open) {
      const side = setup.side;
      const entry = setup.entry;
      const sl = setup.sl;

      if (setup.status === "proposed") {
        const inZone = Math.abs(price - entry) <= zone;
        if (inZone) {
          setup.status = "active";
          setup.activated_at = new Date().toISOString();
          alerts.push(`Setup ${setup.id} ACTIVE — price ${price} in entry zone`);
        }
      }

      if (setup.status !== "active" && setup.status !== "proposed") continue;

      const risk = Math.abs(entry - sl);
      if (risk > 0) {
        const rr = side === "long" ? (price - entry) / risk : (entry - price) / risk;
        setup.max_rr_reached = Math.max(setup.max_rr_reached || 0, rr);
      }

      let slHit = side === "long" ? price <= sl : price >= sl;
      if (slHit && setup.status === "active") {
        const pnlPips = side === "long" ? toPips(price - entry) : toPips(entry - price);
        const resolved = resolveSetup(setup.id, setup.partial_filled?.length ? "tp_partial_then_sl" : "sl_hit", {
          pnl_pips: pnlPips,
          remaining_pct: setup.remaining_pct,
          partial_filled: setup.partial_filled,
        });
        if (resolved) recordSetupOutcome(resolved);
        alerts.push(`🛑 SL HIT ${setup.id} @ ${price} (${pnlPips} pips)`);
        continue;
      }

      for (let i = 0; i < (setup.tp_levels || []).length; i++) {
        const tp = setup.tp_levels[i];
        if (tp.status === "hit") continue;
        const hit = side === "long" ? price >= tp.price : price <= tp.price;
        if (hit && setup.status === "active") {
          markTpLevelHit(setup, i, price);
          persistSetup(setup);
          alerts.push(`🎯 TP${tp.level} HIT ${setup.id} @ ${price} — take ${tp.close_pct}% on MT5`);
          if (setup.status === "resolved") {
            const pnlPips = side === "long" ? toPips(tp.price - entry) : toPips(entry - tp.price);
            setup.pnl_pips = pnlPips;
            setup.outcome = setup.outcome || "tp_full";
            persistSetup(setup);
            recordSetupOutcome(setup);
          }
        }
      }

      for (const tp of setup.tp_levels || []) {
        if (tp.status !== "pending") continue;
        const dist = Math.abs(tp.price - price);
        const total = Math.abs(tp.price - entry);
        if (total > 0 && dist / total <= (1 - config.screening.nearTpSlAlertPct / 100)) {
          alerts.push(`📍 Near TP${tp.level} on ${setup.id}: ${price} → ${tp.price}`);
        }
      }

      persistSetup(setup);
    }

    if (alerts.length && !silent) {
      await sendMessage(alerts.join("\n"));
    }

    return alerts.join("\n") || "Management OK";
  } finally {
    _managementBusy = false;
  }
}

export function startCronJobs() {
  cronTasks.forEach((t) => t.stop());
  cronTasks = [];

  const { screeningIntervalMin, managementIntervalMin } = getModeIntervals();

  cronTasks.push(cron.schedule(`*/${screeningIntervalMin} * * * *`, () => {
    runScreeningCycle().catch((e) => log("cron_error", e.message));
  }));

  cronTasks.push(cron.schedule(`*/${managementIntervalMin} * * * *`, () => {
    runManagementCycle().catch((e) => log("cron_error", e.message));
  }));

  log("cron", `Started — screening ${screeningIntervalMin}m, management ${managementIntervalMin}m [${config.activeMode}]`);
}

async function telegramHandler(msg) {
  const text = (msg.text || "").trim();
  if (text === "/screen") {
    await sendMessage("Running screening...");
    await runScreeningCycle();
    return;
  }
  if (text === "/status") {
    const mode = getActiveMode();
    const open = getOpenSetups();
    await sendMessage(`Mode: ${mode.id}\nOpen setups: ${open.length}\nSymbol: OANDA:XAUUSD`);
    return;
  }
  if (text.startsWith("/mode ")) {
    const id = text.split(" ")[1];
    try {
      switchMode(id);
      startCronJobs();
      await sendMessage(`Switched to mode: ${id}`);
    } catch (error) {
      await sendMessage(error.message);
    }
    return;
  }
  if (text === "/help") {
    await sendMessage("/screen — run screening\n/status — agent status\n/mode scalp|day|swing — switch mode");
    return;
  }

  const { content } = await agentLoop(text, config.llm.maxSteps, "GENERAL", config.llm.generalModel);
  await sendMessage(content?.slice(0, 4000) || "Done.");
}

const isMain = process.argv[1]?.endsWith("index.js");
if (isMain) {
  log("startup", `Shaolin starting — mode ${config.activeMode} — ${process.env.DRY_RUN === "true" ? "DRY_RUN" : "LIVE"}`);
  startCronJobs();
  if (telegramEnabled()) startPolling(telegramHandler);
  runScreeningCycle({ silent: false }).catch((e) => log("startup_error", e.message));

  process.on("SIGINT", async () => {
    await closeMcp();
    process.exit(0);
  });
}
