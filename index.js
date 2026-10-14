import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getActiveMode, getModeIntervals, isSessionAllowed, isWeekendMarketClosed, switchMode } from "./modes.js";
import { appendScreeningDecision, getRecentScreeningDecisions } from "./screening-log.js";
import { getOpenSetups, getSetupsSummary, persistSetups, cancelSetup, cancelAllOpenSetups } from "./setups.js";
import { evaluateSetup, evaluateExpiry } from "./management.js";
import { recordSetupOutcome } from "./lessons.js";
import { updatePriceStream, clearPriceStream, resetStreamCooldown } from "./price-stream.js";
import {
  formatSetupAlert,
  shouldNotifyTelegram,
  formatSessionSkip,
  formatWeekendSkip,
  formatOpenSetupSkip,
  formatManagementDigest,
  formatEventAlert,
  formatScreeningDigest,
} from "./notifications.js";
import { sendMessage, startPolling, isEnabled as telegramEnabled, getTelegramStatus } from "./telegram.js";
import { closeMcp } from "./tools/mcp-client.js";
import { getManagementPrice, fetchAnalysis, extractPriceFromAnalysis, isTradingViewBackingOff } from "./tools/market.js";
import { getActivePlan, createPlan, checkPlanInvalidation, formatPlanForPrompt, formatPlanMessage } from "./planner.js";
import { detectTriggers, poolsFromContext } from "./watcher.js";
import { formatAgentStatus } from "./status.js";
import { formatPerformanceStats } from "./performance-stats.js";
import { getSetupMemorySummary } from "./setup-memory.js";
import { clearStagedSignals } from "./signal-tracker.js";
import { cleanContent, parseVerdict, verdictReason } from "./verdict.js";
import { getCalendarEvents, checkNewsBlackout, formatCalendarForPrompt, upcomingEvents, formatEvent } from "./tools/calendar.js";
import { buildSMCContext, formatSMCForPrompt, getLastSMCContext } from "./smc.js";

let _screeningBusy = false;
let _managementBusy = false;
let _mgmtCycleCount = 0;
let _screenCycleCount = 0;
let cronTasks = [];
let fastMgmtTimer = null;
let watcherTimer = null;
let _planningBusy = false;
let _lastPlanAt = 0;
let _lastScreeningAt = 0;
const _firedTriggers = new Map();

export function syncFastManagementTimer() {
  const open = getOpenSetups();
  if (!open.length || config.management?.fastPollEnabled === false) {
    if (fastMgmtTimer) {
      clearInterval(fastMgmtTimer);
      fastMgmtTimer = null;
    }
    clearPriceStream().catch((e) => log("price_stream_error", e.message));
    return;
  }
  if (fastMgmtTimer) return;

  const sec = config.management?.fastPollSec ?? 45;
  fastMgmtTimer = setInterval(() => {
    runManagementCycle({ silent: true, streamUpdate: true }).catch((e) => log("cron_error", e.message));
  }, sec * 1000);

  log("cron", `Fast management every ${sec}s (${open.length} open setup(s))`);
  resetStreamCooldown();
}

function extractLastSetupFromMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    try {
      const parsed = JSON.parse(m.content);
      if (parsed?.success && parsed.setup?.id) return parsed.setup;
    } catch { /* not JSON */ }
  }
  return null;
}

export async function runScreeningCycle({ silent = false, trigger = null } = {}) {
  if (_screeningBusy) {
    log("screen", "Screening skipped — previous cycle still running");
    return "Screening already running.";
  }
  _screeningBusy = true;
  _lastScreeningAt = Date.now();
  _screenCycleCount += 1;
  const mode = getActiveMode();
  const notify = config.notifications?.enabled !== false && !silent;

  try {
    log("cron", `Screening cycle [${mode.id}]`);

    if (config.screening?.skipWeekends !== false && isWeekendMarketClosed()) {
      const msg = "Weekend — XAUUSD market closed, skipping screening";
      appendScreeningDecision({ action: "AVOID", summary: msg, reason: "weekend_market_closed" });
      log("screen", msg);
      if (notify && config.notifications?.notifyWeekendSkip && shouldNotifyTelegram("weekend_market_closed")) {
        await sendMessage(formatWeekendSkip(mode));
      }
      return msg;
    }

    if (!isSessionAllowed(mode)) {
      const msg = `Session not allowed for ${mode.id} — skipping screening`;
      appendScreeningDecision({ action: "AVOID", summary: msg, reason: "off_session" });
      log("screen", msg);
      if (notify && config.notifications?.notifySessionSkip && shouldNotifyTelegram("off_session")) {
        await sendMessage(formatSessionSkip(mode));
      }
      return msg;
    }

    await expireOpenSetups(mode, null, { notify: true });

    const open = getOpenSetups();
    if (open.length > 0) {
      const msg = `Open setup(s) active (${open.length}) — skipping new screening. Management monitors TP/SL every ${mode.managementIntervalMin}m.`;
      appendScreeningDecision({ action: "WATCH", summary: msg, reason: "open_setup_active" });
      log("screen", msg);
      const sendScreenDigest = notify && config.notifications?.notifyScreeningDigest
        && _screenCycleCount % (config.notifications?.digestEveryScreeningCycles ?? 1) === 0
        && shouldNotifyTelegram("screening_digest");
      if (sendScreenDigest) {
        await sendMessage(formatScreeningDigest({ action: "WATCH", summary: msg, smc: getLastSMCContext(), openCount: open.length }));
      } else if (notify && config.notifications?.notifyOpenSetupSkip && shouldNotifyTelegram("open_setup_skip")) {
        await sendMessage(formatOpenSetupSkip(open, mode));
      }
      return msg;
    }

    const calendarEvents = await getCalendarEvents();
    const blackout = checkNewsBlackout(calendarEvents);
    if (!blackout.ok) {
      appendScreeningDecision({ action: "AVOID", summary: blackout.message, reason: "news_blackout" });
      log("screen", blackout.message);
      return blackout.message;
    }

    clearStagedSignals();
    let smcSummary = null;
    let smcCtx = null;
    if (config.smc?.enabled !== false) {
      try {
        smcCtx = await buildSMCContext();
        smcSummary = formatSMCForPrompt(smcCtx);
      } catch (error) {
        log("smc_error", error.message);
      }
    }
    // No live price / no candle history → no trigger can be verified; don't spend an LLM call on it.
    if (smcCtx && (smcCtx.price == null || !smcCtx.data.candles)) {
      const msg = smcCtx.price == null
        ? "WATCH — no live TradingView price this cycle (feed unavailable / rate-limited)"
        : `WATCH — no candle history this cycle (${smcCtx.data.candle_error || "unavailable"}); triggers can't be verified`;
      appendScreeningDecision({ action: "WATCH", summary: msg, reason: smcCtx.price == null ? "no_price" : "no_candles" });
      log("screen", msg);
      return msg;
    }

    const goal = [
      `Run XAUUSD ${mode.label} screening.`,
      trigger ? `Triggered by: ${trigger}.` : "Periodic check.",
      "Is price at a plan POI / HTF key level, and has the LTF trigger (sweep / BMS / RTO) completed? SETUP only if yes, else WATCH with what you are waiting for.",
      "REPLY FORMAT (strict): line 1 = exactly SETUP, WATCH or AVOID. Line 2 = one plain sentence: the trigger step still missing and the exact level/close you wait for (or why it is a setup). Then at most 6 short lines of detail — no headers, no tables.",
    ].join(" ");

    const onToolStart = ({ name, args }) => {
      if (!silent && args && Object.keys(args).length) log("tool", `${name}(${JSON.stringify(args)})`);
    };
    let { content, messages } = await agentLoop(goal, config.llm.maxSteps, "SCREENER", config.llm.screeningModel, {
      context: {
        prefetchSummary: smcSummary,
        calendarSummary: formatCalendarForPrompt(calendarEvents),
        planSummary: formatPlanForPrompt(getActivePlan(), getLastSMCContext()?.price),
        trigger,
      },
      onToolStart,
    });
    content = cleanContent(content);

    // Some models describe a SETUP in prose instead of calling the tool — nothing gets logged then.
    if (!extractLastSetupFromMessages(messages) && parseVerdict(content) === "SETUP") {
      log("screen", "Model concluded SETUP without calling propose_setup — asking it to call the tool");
      ({ content, messages } = await agentLoop(
        "You concluded SETUP but did not call propose_setup, so nothing was logged. Call propose_setup now with side, entry, sl, sl_anchor, tp_levels (price + label), confidence, setup_type, confluence_factors and reason. If you cannot fill those from the data, reply WATCH with the reason.",
        4, "SCREENER", config.llm.screeningModel, { history: messages, onToolStart },
      ));
      content = cleanContent(content);
    }

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
      // Setup alerts always go out — they are the product, even on silent/manual runs.
      await sendMessage(formatSetupAlert(setup));
      log("screen", `Setup logged: ${setup.id} [${setup.entry_style || "market"}]`);
      syncFastManagementTimer();
      return formatSetupAlert(setup);
    }

    const action = parseVerdict(content) === "AVOID" ? "AVOID" : "WATCH";
    const why = verdictReason(content) || content.replace(/\s+/g, " ").slice(0, 200);
    log("screen", `Result: ${action} — ${why}`);
    appendScreeningDecision({ action, summary: why, reason: content });
    const sendDigest = notify && config.notifications?.notifyScreeningDigest
      && _screenCycleCount % (config.notifications?.digestEveryScreeningCycles ?? 1) === 0
      && shouldNotifyTelegram("screening_digest");
    if (sendDigest) {
      await sendMessage(formatScreeningDigest({ action, summary: content, smc: getLastSMCContext() }));
    } else if (notify && config.notifications?.notifyScreeningResult
      && shouldNotifyTelegram(`screen_${action}`, config.notifications?.cooldownMin?.screen_watch ?? 30)) {
      await sendMessage(`🥋 Screening: ${action}\n${(content || "").slice(0, 500)}`);
    }
    return content;
  } finally {
    _screeningBusy = false;
  }
}

/**
 * Time-stop open setups; filled ones need a live price to book the exit.
 * Returns the events; sends them itself only when `notify` (the management
 * cycle batches them into its own alert).
 */
async function expireOpenSetups(mode, price, { notify = false } = {}) {
  const changed = [];
  const events = [];
  for (const setup of getOpenSetups()) {
    const event = evaluateExpiry(setup, mode.setupMaxAgeMin, price);
    if (event) {
      changed.push(setup);
      events.push(event);
    }
  }
  for (const s of persistSetups(changed)) recordSetupOutcome(s);
  if (notify && events.length && config.notifications?.enabled !== false) await sendMessage(formatEventAlert(events));
  return events;
}

const _warnedEvents = new Set();

/** One-time heads-up when a high-impact release is close and setups are open. */
async function newsWarnings(open) {
  const warnMin = config.calendar?.warnOpenSetupMin ?? 30;
  if (config.calendar?.enabled === false || warnMin <= 0) return [];
  const now = Date.now();
  const soon = upcomingEvents(await getCalendarEvents(), now, warnMin / 60).filter((e) => e.time >= now);
  const out = [];
  for (const e of soon) {
    const key = `${e.title}@${e.time}`;
    if (_warnedEvents.has(key)) continue;
    _warnedEvents.add(key);
    out.push(`📰 ${formatEvent(e, now)} — ${open.length} setup(s) open (${open.map((s) => s.id).join(", ")}). Consider tightening SL / taking partials before the release.`);
  }
  return out;
}

export async function runManagementCycle({ silent = false, forceDigest = false, streamUpdate = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  _mgmtCycleCount += 1;
  const mode = getActiveMode();

  try {
    log("cron", streamUpdate ? "Management cycle [fast]" : "Management cycle");

    if (!getOpenSetups().length) {
      syncFastManagementTimer();
      return "No open setups";
    }

    const quote = await getManagementPrice();
    const price = quote?.price;
    if (price == null) {
      const detail = quote?.errors?.slice(-2).join(" | ") || "no price source available";
      log("mgmt_warn", `No price — ${detail}`);
      return [
        `⚠️ Management: cannot fetch price (${getOpenSetups().length} open setup(s)).`,
        detail,
        "",
        getSetupsSummary(),
        "",
        "TP/SL tracking paused until the price feed recovers.",
      ].join("\n");
    }
    log("mgmt", `Price ${price} from ${quote.source}${quote.timeframe ? ` ${quote.timeframe}` : ""}${quote.basis != null ? ` (basis ${quote.basis})` : ""}`);

    await handlePlanInvalidation(price);
    const events = await expireOpenSetups(mode, price);
    const updated = [];
    const resolved = [];
    for (const setup of getOpenSetups()) {
      const r = evaluateSetup(setup, price, mode);
      events.push(...r.events);
      updated.push(r.setup);
      if (r.resolved) resolved.push(r.setup.id);
    }
    const written = persistSetups(updated);
    for (const s of written) if (resolved.includes(s.id)) recordSetupOutcome(s);

    const stillOpen = getOpenSetups();
    if (stillOpen.length) events.push(...(await newsWarnings(stillOpen)));
    const notifyMgmt = config.notifications?.enabled !== false;
    // TP/SL/fill events are always pushed — fast-poll cycles are "silent" only for digests.
    if (notifyMgmt && events.length && !forceDigest) await sendMessage(formatEventAlert(events));
    if (streamUpdate && stillOpen.length) await updatePriceStream(stillOpen, price);

    const digestDue = stillOpen.length
      && config.notifications?.notifyManagementDigest !== false
      && _mgmtCycleCount % (config.notifications?.digestEveryManagementCycles ?? 5) === 0
      && shouldNotifyTelegram("management_digest");
    if (notifyMgmt && !silent && !streamUpdate && !forceDigest && digestDue) {
      await sendMessage(formatManagementDigest(stillOpen, price));
    }

    syncFastManagementTimer();
    if (forceDigest) {
      return stillOpen.length || events.length ? formatManagementDigest(stillOpen, price, events) : "No open setups";
    }
    return events.join("\n") || (stillOpen.length ? formatManagementDigest(stillOpen, price) : "Management OK");
  } finally {
    _managementBusy = false;
  }
}

/** Build today's plan and push it to Telegram. */
export async function runPlanning(reason = "scheduled") {
  if (config.plan?.enabled === false || _planningBusy) return null;
  if (config.screening?.skipWeekends !== false && isWeekendMarketClosed()) return null;
  _planningBusy = true;
  _lastPlanAt = Date.now();
  try {
    const plan = await createPlan({ reason });
    if (config.plan?.notifyTelegram !== false) {
      await sendMessage(formatPlanMessage(plan, formatCalendarForPrompt(await getCalendarEvents())));
    }
    return plan;
  } catch (error) {
    log("plan_error", error.message);
    if (config.plan?.notifyTelegram !== false && shouldNotifyTelegram("plan_error", 120)) {
      await sendMessage(`⚠️ Planner failed: ${error.message}\nScreening continues without a plan (normal rules).`);
    }
    return null;
  } finally {
    _planningBusy = false;
  }
}

/**
 * Every minute, without the LLM: void the plan if price broke its invalidation
 * (re-plan), and fire a screening when price reaches a POI or sweeps a pool.
 */
async function handlePlanInvalidation(price) {
  const invalidated = checkPlanInvalidation(price);
  if (!invalidated) return;
  if (config.plan?.notifyTelegram !== false) await sendMessage(`🗺 Plan invalidated — ${invalidated}. Re-planning…`);
  if (Date.now() - _lastPlanAt > (config.plan?.replanCooldownMin ?? 60) * 60_000) {
    runPlanning(`re-plan: ${invalidated}`).catch((e) => log("plan_error", e.message));
  }
}

async function runWatcher() {
  if (config.watcher?.enabled === false) return;
  if (config.screening?.skipWeekends !== false && isWeekendMarketClosed()) return;
  const mode = getActiveMode();
  if (!isSessionAllowed(mode)) return;
  // Open setups: the management fast poll already tracks price (and plan invalidation).
  if (_screeningBusy || getOpenSetups().length || isTradingViewBackingOff()) return;
  if (Date.now() - _lastScreeningAt < (config.watcher?.minGapMin ?? 3) * 60_000) return;

  // One TradingView request per minute: live price + the current 5m bar's wick for sweeps.
  const m5 = await fetchAnalysis("5m", { maxAgeMs: 50_000 });
  const price = extractPriceFromAnalysis(m5);
  if (price == null) return;
  await handlePlanInvalidation(price);

  const ctx = getLastSMCContext();
  const triggers = detectTriggers({
    price,
    bar: { high: Number(m5?.price_data?.high), low: Number(m5?.price_data?.low) },
    pois: getActivePlan()?.pois || [],
    pools: poolsFromContext(ctx),
    proximityPips: mode.entryZonePips ?? 5,
    lastFired: _firedTriggers,
    cooldownMs: (config.watcher?.cooldownMin ?? 30) * 60_000,
  });
  if (!triggers.length) return;

  for (const t of triggers) _firedTriggers.set(t.key, Date.now());
  const text = triggers.map((t) => t.text).join("; ");
  log("watcher", `Trigger: ${text}`);
  const announce = config.watcher?.notifyPoiTouch !== false && triggers.some((t) => t.kind === "poi");
  if (announce) {
    await sendMessage(`📍 ${triggers.filter((t) => t.kind === "poi").map((t) => t.text).join("\n")}\nScreening for a trigger now…`);
  }
  const startedAt = Date.now();
  const result = await runScreeningCycle({ trigger: text });
  // Close the loop on the 📍 message (a logged setup already sent its own alert).
  if (announce && typeof result === "string" && !result.startsWith("🥋 SHAOLIN SETUP")) {
    const blockedNow = getRecentScreeningDecisions(10)
      .filter((d) => d.action === "BLOCKED" && Date.parse(d.ts) >= startedAt)
      .map((d) => `⛔ ${d.summary}`);
    const verdict = parseVerdict(result);
    await sendMessage([`↳ ${verdict} — ${verdictReason(result) || "no reason given"}`, ...blockedNow].join("\n"));
  }
}

export function startCronJobs() {
  cronTasks.forEach((t) => t.stop());
  cronTasks = [];

  const { screeningIntervalMin, managementIntervalMin } = getModeIntervals();
  const schedule = (min) => (min >= 60 ? `0 */${Math.round(min / 60)} * * *` : `*/${min} * * * *`);

  cronTasks.push(cron.schedule(schedule(screeningIntervalMin), () => {
    runScreeningCycle().catch((e) => log("cron_error", e.message));
  }));
  cronTasks.push(cron.schedule(schedule(managementIntervalMin), () => {
    runManagementCycle().catch((e) => log("cron_error", e.message));
  }));

  if (config.plan?.enabled !== false) {
    for (const time of config.plan?.times ?? []) {
      const [h, m] = String(time).split(":").map(Number);
      if (!Number.isInteger(h) || !Number.isInteger(m)) continue;
      cronTasks.push(cron.schedule(`${m} ${h} * * 1-5`, () => {
        runPlanning("scheduled").catch((e) => log("plan_error", e.message));
      }, { timezone: "Asia/Jakarta" }));
    }
  }

  if (watcherTimer) clearInterval(watcherTimer);
  if (config.watcher?.enabled !== false) {
    watcherTimer = setInterval(() => {
      runWatcher().catch((e) => log("watcher_error", e.message));
    }, (config.watcher?.intervalSec ?? 60) * 1000);
  }

  log("cron", `Started — screening ${screeningIntervalMin}m, management ${managementIntervalMin}m, plan ${config.plan?.enabled === false ? "off" : `${(config.plan?.times ?? []).join("/")} WIB`}, watcher ${config.watcher?.enabled === false ? "off" : `${config.watcher?.intervalSec ?? 60}s`} [${config.activeMode}]`);
  syncFastManagementTimer();
}

const HELP = [
  "/screen — run screening now",
  "/manage — run management cycle",
  "/status — mode, setups, performance, memory",
  "/setups — open setups only",
  "/cancel all — cancel all open setups",
  "/cancel <setup-id> — cancel one setup",
  "/stats — track record by setup type / session / side",
  "/memory — thesis history",
  "/calendar — high-impact USD events this week",
  "/plan — today's plan (bias, POIs, triggers)",
  "/replan — rebuild today's plan now",
  "/mode scalp|day|swing — switch mode (saved to user-config.json)",
  "Anything else is answered by the GENERAL agent.",
].join("\n");

async function handleCommand(text, reply) {
  // Group chats append the bot name: /status@ShaolinBot
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@\S+$/, "").toLowerCase();

  switch (cmd) {
    case "/start":
    case "/help":
      return reply(HELP);
    case "/screen": {
      await reply("Running screening...");
      const out = await runScreeningCycle({ silent: true });
      // A logged setup was already pushed as an alert.
      if (!out?.startsWith?.("🥋 SHAOLIN SETUP")) await reply(String(out || "Screening finished.").slice(0, 4000));
      return;
    }
    case "/status":
      return reply(formatAgentStatus());
    case "/setups":
      return reply(getSetupsSummary());
    case "/cancel": {
      const id = args[0];
      if (!id || id === "all") {
        const ids = cancelAllOpenSetups();
        await reply(ids.length ? `Cancelled ${ids.length} setup(s):\n${ids.join("\n")}` : "No open setups.");
      } else {
        await reply(cancelSetup(id) ? `Cancelled ${id}` : `Open setup not found: ${id}`);
      }
      syncFastManagementTimer();
      return;
    }
    case "/manage": {
      if (!getOpenSetups().length) return reply("No open setups.");
      const result = await runManagementCycle({ silent: true, forceDigest: true });
      return reply(result?.slice(0, 4000) || "Management busy — try again in a few seconds.");
    }
    case "/stats":
      return reply(formatPerformanceStats(getActiveMode().id));
    case "/plan":
      return reply(formatPlanMessage(getActivePlan()));
    case "/replan": {
      await reply("🗺 Re-planning…");
      const plan = await runPlanning("manual");
      if (!plan) return reply("Planner failed or market closed — check logs.");
      // The plan itself is pushed by runPlanning unless Telegram plan notifications are off.
      return config.plan?.notifyTelegram === false ? reply(formatPlanMessage(plan)) : undefined;
    }
    case "/calendar": {
      const evs = upcomingEvents(await getCalendarEvents(), Date.now(), 24 * 7);
      return reply(evs.length ? `📅 High-impact events\n${evs.map((e) => `• ${formatEvent(e)}`).join("\n")}` : "No high-impact events left this week.");
    }
    case "/memory":
      return reply(`Thesis memory:\n${getSetupMemorySummary(8)}`);
    case "/mode": {
      switchMode(args[0]);
      startCronJobs();
      return reply(`Switched to mode: ${args[0]} (saved)`);
    }
    default:
      return null;
  }
}

async function telegramHandler(msg) {
  const chatId = msg.chat?.id;
  const reply = (text) => sendMessage(text, chatId);
  const text = (msg.text || "").trim();

  try {
    if (text.startsWith("/")) {
      const handled = await handleCommand(text, reply);
      if (handled !== null) return;
    }
    const { content } = await agentLoop(text, config.llm.maxSteps, "GENERAL", config.llm.generalModel);
    await reply(content?.slice(0, 4000) || "Done.");
  } catch (error) {
    log("telegram_error", `${text.slice(0, 60)}: ${error.message}`);
    await reply(`❌ ${error.message}`);
  }
}

const indexPath = fileURLToPath(import.meta.url);
const entrypoint = process.env.pm_exec_path || process.argv[1] || "";
const isMain = entrypoint && path.resolve(entrypoint) === indexPath;
if (isMain) {
  log("startup", `Shaolin starting — mode ${config.activeMode} — feed ${config.market.feedLabel}`);

  const tg = getTelegramStatus();
  if (tg.enabled) {
    log("startup", `Telegram ON → chat ${tg.chatId}`);
  } else {
    log("startup_warn", `Telegram OFF — token=${tg.hasToken ? "yes" : "NO"}, chatId=${tg.hasChatId ? "yes" : "NO"}. Set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in .env`);
  }

  startCronJobs();
  if (telegramEnabled()) startPolling(telegramHandler);
  (async () => {
    if (config.plan?.enabled !== false && !getActivePlan()) await runPlanning("startup");
    await runScreeningCycle({ silent: true });
  })().catch((e) => log("startup_error", e.message));

  const shutdown = async () => {
    if (fastMgmtTimer) clearInterval(fastMgmtTimer);
    if (watcherTimer) clearInterval(watcherTimer);
    cronTasks.forEach((t) => t.stop());
    await closeMcp().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
