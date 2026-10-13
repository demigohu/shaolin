import "dotenv/config";
import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const EXAMPLE_CONFIG_PATH = repoPath("user-config.example.json");

if (!fs.existsSync(USER_CONFIG_PATH) && fs.existsSync(EXAMPLE_CONFIG_PATH)) {
  fs.copyFileSync(EXAMPLE_CONFIG_PATH, USER_CONFIG_PATH);
}

/** Custom RPC (non-OpenRouter): prefer LLM_MODEL from .env over stale openrouter/* in user-config. */
function resolveLlmModel(configured) {
  const envModel = process.env.LLM_MODEL?.trim() || null;
  const baseUrl = process.env.LLM_BASE_URL || "";
  const customEndpoint = baseUrl && !baseUrl.includes("openrouter.ai");
  if (customEndpoint && envModel && (!configured || String(configured).startsWith("openrouter/"))) {
    return envModel;
  }
  return configured ?? envModel ?? "openrouter/healer-alpha";
}

function readUserConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(`user-config.json is not valid JSON: ${error.message}`);
  }
}

const u = readUserConfig();

if (u.llmModel) process.env.LLM_MODEL ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL ||= u.llmBaseUrl;
if (u.llmApiKey) process.env.LLM_API_KEY ||= u.llmApiKey;
if (u.telegramBotToken) process.env.TELEGRAM_BOT_TOKEN ||= String(u.telegramBotToken);
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const defaultModes = {
  scalp: {
    label: "Scalping",
    timeframes: ["5m", "15m", "1h", "4h"],
    mtfStyle: "intraday",
    screeningIntervalMin: 10,
    managementIntervalMin: 3,
    setupMaxAgeMin: 90,
    entryZonePips: 3,
    maxSlPips: 40,
    minSlPips: 15,
    maxStaleDistancePips: 15,
    maxLimitEntryPips: 25,
    minConfidence: 65,
    minRrRatio: 1.2,
    combinedTimeframe: "5m",
    partialTp: [{ pct: 50, atRr: 1.0 }, { pct: 50, atRr: 2.0 }],
    sessions: ["any"],
  },
  day: {
    label: "Day Trading",
    timeframes: ["15m", "1h", "4h"],
    screeningIntervalMin: 30,
    managementIntervalMin: 5,
    setupMaxAgeMin: 480,
    entryZonePips: 5,
    maxSlPips: 80,
    minSlPips: 20,
    maxStaleDistancePips: 40,
    maxLimitEntryPips: 60,
    minConfidence: 65,
    minRrRatio: 1.5,
    combinedTimeframe: "1h",
    partialTp: [{ pct: 40, atRr: 1.0 }, { pct: 30, atRr: 1.5 }, { pct: 30, atRr: 2.5 }],
    sessions: ["london", "new_york"],
  },
  swing: {
    label: "Swing / Week",
    timeframes: ["4h", "1D", "1W"],
    screeningIntervalMin: 240,
    managementIntervalMin: 30,
    setupMaxAgeMin: 7200,
    entryZonePips: 15,
    maxSlPips: 300,
    minSlPips: 50,
    maxStaleDistancePips: 150,
    maxLimitEntryPips: 200,
    minConfidence: 70,
    minRrRatio: 2.0,
    combinedTimeframe: "4h",
    partialTp: [{ pct: 33, atRr: 1.0 }, { pct: 33, atRr: 2.0 }, { pct: 34, atRr: 3.0 }],
    sessions: ["any"],
  },
};

function mergeModes(userModes = {}) {
  const ids = new Set([...Object.keys(defaultModes), ...Object.keys(userModes)]);
  return Object.fromEntries([...ids].map((id) => [id, { ...(defaultModes[id] || {}), ...(userModes[id] || {}) }]));
}

const s = u.screening || {};
const n = u.notifications || {};
const m = u.management || {};

export const config = {
  activeMode: u.activeMode ?? "scalp",
  market: {
    dataSymbol: u.dataSymbol ?? u.market?.dataSymbol ?? "XAUUSD",
    dataExchange: u.dataExchange ?? u.market?.dataExchange ?? "TVC",
    // The MCP resolves XAUUSD to TradingView's TVC:GOLD spot CFD feed regardless of exchange.
    feedLabel: u.market?.feedLabel ?? "TVC:GOLD",
    displayName: u.displayName ?? u.market?.displayName ?? "XAUUSD",
    yahooSymbol: u.yahooSymbol ?? u.market?.yahooSymbol ?? "GC=F",
  },
  broker: {
    name: u.brokerName ?? u.broker?.name ?? "HFM",
    accountType: u.broker?.accountType ?? "standard",
    pipSize: u.pipSize ?? u.broker?.pipSize ?? 0.1,
    digits: u.digits ?? u.broker?.digits ?? 2,
    spreadPips: u.broker?.spreadPips ?? null,
    priceOffset: u.priceOffset ?? u.broker?.priceOffset ?? 0,
  },
  modes: mergeModes(u.modes),
  screening: {
    maxSetupsPerDay: s.maxSetupsPerDay ?? u.maxSetupsPerDay ?? 8,
    nearTpSlAlertPct: s.nearTpSlAlertPct ?? u.nearTpSlAlertPct ?? 80,
    blockExtremeRsi: s.blockExtremeRsi !== false,
    rsiNoShortBelow: s.rsiNoShortBelow ?? 35,
    rsiNoLongAbove: s.rsiNoLongAbove ?? 65,
    requireEntryNearPrice: s.requireEntryNearPrice !== false,
    maxEntrySlippagePips: s.maxEntrySlippagePips ?? null,
    maxLimitEntryPips: s.maxLimitEntryPips ?? null,
    maxStaleDistancePips: s.maxStaleDistancePips ?? 15,
    skipWeekends: s.skipWeekends !== false,
    llmOwnsTpSl: s.llmOwnsTpSl !== false,
    enforceMinRr: s.enforceMinRr !== false,
    slStructureBufferPips: s.slStructureBufferPips ?? 3,
    minSlPipsBySetup: s.minSlPipsBySetup ?? { turtle_soup_long: 20, turtle_soup_short: 20 },
  },
  management: {
    breakevenAlertAfterTp1: m.breakevenAlertAfterTp1 ?? u.breakevenAlertAfterTp1 ?? true,
    fastPollEnabled: m.fastPollEnabled !== false,
    fastPollSec: m.fastPollSec ?? 45,
    priceStreamTelegram: m.priceStreamTelegram !== false,
    priceStreamEditMinSec: m.priceStreamEditMinSec ?? 15,
  },
  notifications: {
    enabled: n.enabled !== false,
    notifyScreeningDigest: n.notifyScreeningDigest ?? true,
    notifyManagementDigest: n.notifyManagementDigest ?? true,
    notifyScreeningResult: n.notifyScreeningResult ?? true,
    notifyOpenSetupSkip: n.notifyOpenSetupSkip ?? true,
    notifySessionSkip: n.notifySessionSkip ?? false,
    notifyWeekendSkip: n.notifyWeekendSkip ?? false,
    digestEveryManagementCycles: n.digestEveryManagementCycles ?? 5,
    digestEveryScreeningCycles: n.digestEveryScreeningCycles ?? 1,
    cooldownMin: {
      off_session: 240,
      open_setup_skip: 15,
      management_digest: 15,
      screening_digest: 15,
      screen_watch: 30,
      ...(n.cooldownMin || {}),
    },
  },
  llm: {
    temperature: u.temperature ?? u.llm?.temperature ?? 0.35,
    maxTokens: u.maxTokens ?? u.llm?.maxTokens ?? 4096,
    maxSteps: u.maxSteps ?? u.llm?.maxSteps ?? 15,
    screeningModel: resolveLlmModel(u.screeningModel ?? u.llm?.screeningModel),
    generalModel: resolveLlmModel(u.generalModel ?? u.llm?.generalModel),
  },
  calendar: {
    enabled: u.calendar?.enabled !== false,
    currencies: u.calendar?.currencies ?? ["USD"],
    impacts: u.calendar?.impacts ?? ["High"],
    blackoutBeforeMin: u.calendar?.blackoutBeforeMin ?? 15,
    blackoutAfterMin: u.calendar?.blackoutAfterMin ?? 15,
    warnOpenSetupMin: u.calendar?.warnOpenSetupMin ?? 30,
  },
  news: {
    query: u.news?.query ?? '"gold price" | "spot gold" | "gold futures" | bullion | xauusd',
    lookbackHours: u.news?.lookbackHours ?? 24,
    cacheMin: u.news?.cacheMin ?? 30,
    dailyBudget: u.news?.dailyBudget ?? 60,
  },
  performanceGate: {
    enabled: u.performanceGate?.enabled !== false,
    windowDays: u.performanceGate?.windowDays ?? 60,
    minTrades: u.performanceGate?.minTrades ?? 5,
    maxWinRate: u.performanceGate?.maxWinRate ?? 30,
  },
  setupMemory: {
    zonePips: u.setupMemory?.zonePips ?? 50,
    cooldownMinSetups: u.setupMemory?.cooldownMinSetups ?? 3,
    cooldownMaxWinRate: u.setupMemory?.cooldownMaxWinRate ?? 25,
    cooldownHours: u.setupMemory?.cooldownHours ?? 24,
  },
  smc: {
    enabled: u.smc?.enabled !== false,
    minConfluence: u.smc?.minConfluence ?? 2,
    requireTradingWindow: u.smc?.requireTradingWindow ?? true,
    blockTrendFollowAtLiquidity: u.smc?.blockTrendFollowAtLiquidity !== false,
    asianNearPips: u.smc?.asianNearPips ?? 5,
    asianRangeMinPips: u.smc?.asianRangeMinPips ?? 5,
    slBelowSweepPips: u.smc?.slBelowSweepPips ?? 10,
  },
  mtfZones: {
    enabled: u.mtfZones?.enabled !== false,
    minZoneStrength: u.mtfZones?.minZoneStrength ?? 3,
  },
};

/** Persist top-level keys back to user-config.json (e.g. activeMode from /mode). */
export function saveUserConfigPatch(patch) {
  const current = readUserConfig();
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify({ ...current, ...patch }, null, 2));
}

export { REPO_ROOT, repoPath };
