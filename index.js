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
  getSetupsSummary,
  markTpLevelHit,
  persistSetup,
  cancelSetup,
  cancelAllOpenSetups,
  resolveSetup,
} from "./setups.js";
import { recordSetupOutcome } from "./lessons.js";
import {
  formatSetupAlert,
  shouldNotifyTelegram,
  formatSessionSkip,
  formatOpenSetupSkip,
  formatManagementDigest,
  formatEventAlert,
} from "./notifications.js";
import { sendMessage, startPolling, isEnabled as telegramEnabled, getTelegramStatus } from "./telegram.js";
import { closeMcp } from "./tools/mcp-client.js";
import { getManagementPrice } from "./tools/market.js";
import { toPips } from "./tools/price.js";
import { isStrategyApproved, getActiveStrategy, ensureStrategyApproved, backtestMcpStrategy, formatStrategiesList, setActiveStrategy, MCP_STRATEGIES, strategyIdFor } from "./strategies.js";
import { compareStrategies } from "./tools/backtest.js";
import { formatAgentStatus } from "./status.js";
import { getWeightsSummary } from "./signal-weights.js";
import { getSetupMemorySummary } from "./setup-memory.js";

let _screeningBusy = false;
let _managementBusy = false;
let _mgmtCycleCount = 0;
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
      log("screen", msg);
      if (!silent && config.notifications?.notifySessionSkip && shouldNotifyTelegram("off_session")) {
        await sendMessage(formatSessionSkip(mode));
      }
      return msg;
    }

    const strategy = getActiveStrategy();
    if (config.strategy.requireBacktestApproval) {
      const gate = await ensureStrategyApproved(strategy.id);
      if (!gate.approved) {
        const msg = gate.error
          ? `Strategy ${strategy.id} backtest failed: ${gate.error}`
          : `Strategy ${strategy.id} not backtest-approved — skipping`;
        appendScreeningDecision({ action: "AVOID", summary: msg, reason: gate.error || "backtest_gate" });
        if (!silent) await sendMessage(`🥋 ${msg}`);
        return msg;
      }
    } else if (!isStrategyApproved(strategy.id)) {
      log("backtest_gate", `Strategy ${strategy.id} not approved but gate disabled`);
    }

    expireStaleSetups(mode.setupMaxAgeMin);

    const open = getOpenSetups();
    if (open.length > 0) {
      const msg = `Open setup(s) active (${open.length}) — skipping new screening. Management monitors TP/SL every ${mode.managementIntervalMin}m.`;
      appendScreeningDecision({ action: "WATCH", summary: msg, reason: "open_setup_active" });
      log("screen", msg);
      if (!silent && config.notifications?.notifyOpenSetupSkip && shouldNotifyTelegram("open_setup_skip")) {
        await sendMessage(formatOpenSetupSkip(open, mode));
      }
      return msg;
    }

    const maxSl = mode.maxSlPips ?? 40;
    const goal = `Run XAUUSD ${mode.label} screening. Intraday TFs: ${mode.timeframes.join(", ")}. Analyze scalp MTF + combined TA on ${mode.combinedTimeframe}. If SETUP: tight SL max ${maxSl} pips, min confidence ${mode.minConfidence}%, min RR ${mode.minRrRatio}. Do NOT use Daily/Weekly Bollinger as SL. Otherwise WATCH or AVOID.`;

    const { content, messages } = await agentLoop(
      goal,
      config.llm.maxSteps,
      "SCREENER",
      config.llm.screeningModel,
      {
        onToolStart: ({ name, args }) => {
          if (!silent && args && Object.keys(args).length) {
            log("tool", `${name}(${JSON.stringify(args)})`);
          }
        },
      },
    );

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
      if (!silent && shouldNotifyTelegram(`screen_${action}`, 30)) {
        await sendMessage(`🥋 Screening: ${action}\n${(content || "").slice(0, 500)}`);
      }
    }

    return content;
  } finally {
    _screeningBusy = false;
  }
}


export async function runManagementCycle({ silent = false, forceDigest = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  _mgmtCycleCount += 1;
  const mode = getActiveMode();

  try {
    log("cron", "Management cycle");
    expireStaleSetups(mode.setupMaxAgeMin);

    const open = getOpenSetups();
    if (!open.length) return "No open setups";

    let quote;
    try {
      quote = await getManagementPrice();
    } catch (error) {
      log("mgmt_error", `Price fetch failed: ${error.message}`);
      return null;
    }

    const price = quote?.price;
    if (price == null) {
      log("mgmt_warn", "No price in quote");
      return null;
    }
    if (quote.source === "yahoo") {
      log("mgmt_warn", "Using Yahoo GC=F for management — may mismatch OANDA setup levels");
    }

    const events = [];

    for (const setup of open) {
      const side = setup.side;
      const entry = setup.entry;
      const sl = setup.sl;
      const slHit = side === "long" ? price <= sl : price >= sl;

      // Legacy setups may still be "proposed" — monitor TP/SL immediately, no activation alert.
      if (setup.status === "proposed") {
        setup.status = "active";
        setup.activated_at = setup.activated_at || new Date().toISOString();
      }

      const risk = Math.abs(entry - sl);
      if (risk > 0) {
        const rr = side === "long" ? (price - entry) / risk : (entry - price) / risk;
        setup.max_rr_reached = Math.max(setup.max_rr_reached || 0, rr);
      }

      if (slHit) {
        const pnlPips = side === "long" ? toPips(price - entry) : toPips(entry - price);
        const resolved = resolveSetup(setup.id, setup.partial_filled?.length ? "tp_partial_then_sl" : "sl_hit", {
          pnl_pips: pnlPips,
          remaining_pct: setup.remaining_pct,
          partial_filled: setup.partial_filled,
        });
        if (resolved) recordSetupOutcome(resolved);
        events.push(`🛑 SL HIT ${setup.id} @ ${price} (${pnlPips} pips)`);
        continue;
      }

      for (let i = 0; i < (setup.tp_levels || []).length; i++) {
        const tp = setup.tp_levels[i];
        if (tp.status === "hit") continue;
        const hit = side === "long" ? price >= tp.price : price <= tp.price;
        if (hit) {
          markTpLevelHit(setup, i, price);
          persistSetup(setup);
          events.push(`🎯 TP${tp.level} HIT ${setup.id} @ ${price} — take ${tp.close_pct}% on MT5`);
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
          events.push(`📍 Near TP${tp.level} ${setup.id}: ${price} → ${tp.price}`);
        }
      }

      persistSetup(setup);
    }

    const stillOpen = getOpenSetups();
    const digestEvery = config.notifications?.digestEveryManagementCycles ?? 5;
    const sendDigest = forceDigest
      || (stillOpen.length && _mgmtCycleCount % digestEvery === 0 && shouldNotifyTelegram("management_digest"));

    if (!silent) {
      if (forceDigest && stillOpen.length) {
        await sendMessage(formatManagementDigest(stillOpen, price, events));
      } else if (events.length) {
        await sendMessage(formatEventAlert(events));
      } else if (sendDigest && stillOpen.length) {
        await sendMessage(formatManagementDigest(stillOpen, price));
      }
    }

    if (forceDigest && stillOpen.length) {
      return formatManagementDigest(stillOpen, price, events);
    }
    return events.join("\n") || (stillOpen.length ? formatManagementDigest(stillOpen, price) : "Management OK");
  } finally {
    _managementBusy = false;
  }
}

export function startCronJobs() {
  cronTasks.forEach((t) => t.stop());
  cronTasks = [];

  const { screeningIntervalMin, managementIntervalMin } = getModeIntervals();

  cronTasks.push(cron.schedule(`*/${screeningIntervalMin} * * * *`, () => {
    runScreeningCycle({ silent: true }).catch((e) => log("cron_error", e.message));
  }));

  cronTasks.push(cron.schedule(`*/${managementIntervalMin} * * * *`, () => {
    runManagementCycle().catch((e) => log("cron_error", e.message));
  }));

  log("cron", `Started — screening ${screeningIntervalMin}m, management ${managementIntervalMin}m [${config.activeMode}]`);
}

async function telegramHandler(msg) {
  const chatId = msg.chat?.id;
  const reply = (text) => sendMessage(text, chatId);

  const text = (msg.text || "").trim();
  if (text === "/screen") {
    await reply("Running screening...");
    await runScreeningCycle();
    return;
  }
  if (text === "/status") {
    await reply(formatAgentStatus());
    return;
  }
  if (text === "/setups") {
    const open = getOpenSetups();
    await reply(open.length ? getSetupsSummary() : "No open setups.");
    return;
  }
  if (text.startsWith("/cancel")) {
    const id = text.split(/\s+/)[1];
    if (!id || id === "all") {
      const ids = cancelAllOpenSetups();
      await reply(ids.length ? `Cancelled ${ids.length} setup(s):\n${ids.join("\n")}` : "No open setups.");
    } else {
      const setup = cancelSetup(id);
      await reply(setup ? `Cancelled ${id}` : `Setup not found: ${id}`);
    }
    return;
  }
  if (text === "/strategies") {
    await reply(`📋 Strategies\n${formatStrategiesList()}\n\nAvailable MCP: ${MCP_STRATEGIES.join(", ")}`);
    return;
  }
  if (text.startsWith("/backtest")) {
    const parts = text.split(/\s+/).slice(1);
    const mcp = parts[0];
    const activate = parts.includes("activate");

    if (!mcp || mcp === "compare") {
      await reply("⏳ Comparing all strategies (~2-3 min)...");
      try {
        const result = await compareStrategies({ period: "1y", interval: "1h" });
        const top = result?.rankings?.slice?.(0, 5) || result?.strategies?.slice?.(0, 5) || result;
        await reply(`📊 Compare results (top):\n${JSON.stringify(top, null, 2).slice(0, 3500)}`);
      } catch (error) {
        await reply(`❌ Compare failed: ${error.message}`);
      }
      return;
    }

    if (!MCP_STRATEGIES.includes(mcp)) {
      await reply(`Unknown strategy: ${mcp}\nAvailable: ${MCP_STRATEGIES.join(", ")}`);
      return;
    }

    await reply(`⏳ Backtesting ${mcp} on XAUUSD (~1-2 min)...`);
    try {
      const out = await backtestMcpStrategy(mcp, { activate });
      if (out.error) {
        await reply(out.rate_limited ? out.error : `❌ ${out.error}`);
        return;
      }
      await reply([out.summary, "", out.message].filter(Boolean).join("\n"));
    } catch (error) {
      await reply(`❌ Backtest failed: ${error.message}`);
    }
    return;
  }
  if (text.startsWith("/use ")) {
    const mcp = text.split(/\s+/)[1];
    if (!mcp) {
      await reply("Usage: /use supertrend");
      return;
    }
    if (!MCP_STRATEGIES.includes(mcp)) {
      await reply(`Unknown: ${mcp}. Available: ${MCP_STRATEGIES.join(", ")}`);
      return;
    }
    const id = strategyIdFor(mcp);
    try {
      if (isStrategyApproved(id)) {
        const s = setActiveStrategy(id);
        await reply(`✅ Active strategy: ${s.id} (${s.mcpStrategy})`);
      } else {
        await reply(`Belum approved. Running backtest + activate...`);
        const out = await backtestMcpStrategy(mcp, { activate: true });
        await reply(out.error ? `❌ ${out.error}` : [out.summary, "", out.message].filter(Boolean).join("\n"));
      }
    } catch (error) {
      await reply(`❌ ${error.message}`);
    }
    return;
  }
  if (text === "/manage") {
    await reply("Running management...");
    const result = await runManagementCycle({ silent: true, forceDigest: true });
    await reply(result?.slice(0, 4000) || "No open setups.");
    return;
  }
  if (text === "/weights") {
    await reply(config.darwin?.enabled === false
      ? "Darwin signal weights disabled."
      : getWeightsSummary());
    return;
  }
  if (text === "/memory") {
    await reply(`Thesis memory:\n${getSetupMemorySummary(8)}`);
    return;
  }
  if (text.startsWith("/mode ")) {
    const id = text.split(" ")[1];
    try {
      switchMode(id);
      startCronJobs();
      await reply(`Switched to mode: ${id}`);
    } catch (error) {
      await reply(error.message);
    }
    return;
  }
  if (text === "/help") {
    await reply([
      "/screen — run screening now",
      "/manage — run management cycle",
      "/status — mode, setups, performance, memory",
      "/setups — open setups only",
      "/cancel all — cancel all open setups",
      "/cancel <setup-id> — cancel one setup",
      "/strategies — list backtest strategies",
      "/backtest supertrend — run backtest",
      "/backtest supertrend activate — backtest + activate if OK",
      "/backtest compare — compare all 9 strategies",
      "/use supertrend — activate strategy (backtest first if needed)",
      "/memory — thesis history",
      "/mode scalp|day|swing — switch mode",
    ].join("\n"));
    return;
  }

  const { content } = await agentLoop(text, config.llm.maxSteps, "GENERAL", config.llm.generalModel);
  await reply(content?.slice(0, 4000) || "Done.");
}

import path from "path";
import { fileURLToPath } from "url";

const indexPath = fileURLToPath(import.meta.url);
const entrypoint = process.env.pm_exec_path || process.argv[1] || "";
const isMain = process.env.pm_id != null
  || (entrypoint && path.resolve(entrypoint) === indexPath);
if (isMain) {
  log("startup", `Shaolin starting — mode ${config.activeMode} — ${process.env.DRY_RUN === "true" ? "DRY_RUN" : "LIVE"}`);

  const tg = getTelegramStatus();
  if (tg.enabled) {
    log("startup", `Telegram ON → chat ${tg.chatId}`);
  } else {
    log("startup_warn", `Telegram OFF — token=${tg.hasToken ? "yes" : "NO"}, chatId=${tg.hasChatId ? "yes" : "NO"}. Set TELEGRAM_BOT_TOKEN in .env`);
  }

  if (config.strategy.requireBacktestApproval) {
    ensureStrategyApproved()
      .then((gate) => {
        if (gate.approved) {
          log("backtest_gate", `Strategy ${gate.strategy_id} approved for screening`);
        } else {
          log("backtest_gate", `Strategy ${gate.strategy_id} NOT approved — screening will skip until backtest passes`);
        }
      })
      .catch((error) => log("backtest_gate_error", error.message));
  }

  startCronJobs();
  if (telegramEnabled()) startPolling(telegramHandler);
  runScreeningCycle({ silent: true }).catch((e) => log("startup_error", e.message));

  process.on("SIGINT", async () => {
    await closeMcp();
    process.exit(0);
  });
}
