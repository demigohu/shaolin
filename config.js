import "dotenv/config";
import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

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

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

if (u.llmModel) process.env.LLM_MODEL ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL ||= u.llmBaseUrl;
if (u.llmApiKey) process.env.LLM_API_KEY ||= u.llmApiKey;
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

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
    minConfidence: 70,
    minRrRatio: 2.0,
    combinedTimeframe: "4h",
    partialTp: [{ pct: 33, atRr: 1.0 }, { pct: 33, atRr: 2.0 }, { pct: 34, atRr: 3.0 }],
    sessions: ["any"],
  },
};

export const config = {
  activeMode: u.activeMode ?? "scalp",
  market: {
    dataSymbol: u.dataSymbol ?? u.market?.dataSymbol ?? "XAUUSD",
    dataExchange: u.dataExchange ?? u.market?.dataExchange ?? "OANDA",
    displayName: u.displayName ?? u.market?.displayName ?? "XAUUSD",
    yahooSymbol: u.yahooSymbol ?? u.market?.yahooSymbol ?? "GC=F",
  },
  broker: {
    name: u.brokerName ?? u.broker?.name ?? "HFM",
    pipSize: u.pipSize ?? u.broker?.pipSize ?? 0.1,
    digits: u.digits ?? u.broker?.digits ?? 2,
    priceOffset: u.priceOffset ?? u.broker?.priceOffset ?? 0,
  },
  modes: { ...defaultModes, ...(u.modes || {}) },
  screening: {
    maxSetupsPerDay: u.maxSetupsPerDay ?? 8,
    newsBlackoutMinutes: u.newsBlackoutMinutes ?? 0,
    nearTpSlAlertPct: u.nearTpSlAlertPct ?? 80,
    blockExtremeRsi: u.screening?.blockExtremeRsi !== false,
    rsiNoShortBelow: u.screening?.rsiNoShortBelow ?? 35,
    rsiNoLongAbove: u.screening?.rsiNoLongAbove ?? 65,
    requireEntryNearPrice: u.screening?.requireEntryNearPrice !== false,
    maxEntrySlippagePips: u.screening?.maxEntrySlippagePips ?? null,
    maxLimitEntryPips: u.screening?.maxLimitEntryPips ?? null,
    maxStaleDistancePips: u.screening?.maxStaleDistancePips ?? 15,
  },
  management: {
    breakevenAlertAfterTp1: u.breakevenAlertAfterTp1 ?? true,
    fastPollEnabled: u.management?.fastPollEnabled !== false,
    fastPollSec: u.management?.fastPollSec ?? 45,
    priceStreamTelegram: u.management?.priceStreamTelegram !== false,
    priceStreamEditMinSec: u.management?.priceStreamEditMinSec ?? 15,
  },
  notifications: {
    enabled: u.notifications?.enabled !== false,
    notifyScreeningDigest: u.notifications?.notifyScreeningDigest ?? true,
    notifyManagementDigest: u.notifications?.notifyManagementDigest ?? true,
    notifyScreeningResult: u.notifications?.notifyScreeningResult ?? true,
    notifyOpenSetupSkip: u.notifications?.notifyOpenSetupSkip ?? true,
    notifySessionSkip: u.notifications?.notifySessionSkip ?? false,
    digestEveryManagementCycles: u.notifications?.digestEveryManagementCycles ?? 5,
    digestEveryScreeningCycles: u.notifications?.digestEveryScreeningCycles ?? 1,
    cooldownMin: {
      off_session: u.notifications?.cooldownMin?.off_session ?? 240,
      open_setup_skip: u.notifications?.cooldownMin?.open_setup_skip ?? 15,
      management_digest: u.notifications?.cooldownMin?.management_digest ?? 15,
      screening_digest: u.notifications?.cooldownMin?.screening_digest ?? 15,
      screen_watch: u.notifications?.cooldownMin?.screen_watch ?? 30,
      ...(u.notifications?.cooldownMin || {}),
    },
  },
  llm: {
    temperature: u.temperature ?? u.llm?.temperature ?? 0.35,
    maxTokens: u.maxTokens ?? u.llm?.maxTokens ?? 4096,
    maxSteps: u.maxSteps ?? u.llm?.maxSteps ?? 15,
    screeningModel: resolveLlmModel(u.screeningModel ?? u.llm?.screeningModel),
    managementModel: resolveLlmModel(u.managementModel ?? u.llm?.managementModel),
    generalModel: resolveLlmModel(u.generalModel ?? u.llm?.generalModel),
  },
  strategy: {
    requireBacktestApproval: u.requireBacktestApproval ?? false,
    activeStrategyId: u.activeStrategyId ?? "scalp_mtf_default",
    backtestPeriod: u.strategy?.backtestPeriod ?? "1y",
    backtestInterval: u.strategy?.backtestInterval ?? "1h",
    minSharpe: u.strategy?.minSharpe ?? 0.5,
  },
  darwin: {
    enabled: u.darwin?.enabled ?? true,
    windowDays: u.darwin?.windowDays ?? 60,
    minSamples: u.darwin?.minSamples ?? 8,
    boostFactor: u.darwin?.boostFactor ?? 1.05,
    decayFactor: u.darwin?.decayFactor ?? 0.95,
    weightFloor: u.darwin?.weightFloor ?? 0.3,
    weightCeiling: u.darwin?.weightCeiling ?? 2.5,
    recalcEveryN: u.darwin?.recalcEveryN ?? 5,
  },
  setupMemory: {
    cooldownMinSetups: u.setupMemory?.cooldownMinSetups ?? 3,
    cooldownMaxWinRate: u.setupMemory?.cooldownMaxWinRate ?? 25,
    cooldownHours: u.setupMemory?.cooldownHours ?? 24,
  },
  smc: {
    enabled: u.smc?.enabled !== false,
    minConfluence: u.smc?.minConfluence ?? 2,
    requireTradingWindow: u.smc?.requireTradingWindow ?? true,
    blockTrendFollowAtLiquidity: u.smc?.blockTrendFollowAtLiquidity !== false,
    bootstrapAsianRange: u.smc?.bootstrapAsianRange !== false,
    asianRangeMaxPips: u.smc?.asianRangeMaxPips ?? 50,
  },
  mtfZones: {
    enabled: u.mtfZones?.enabled !== false,
    mergePips: u.mtfZones?.mergePips ?? 8,
    proximityPips: u.mtfZones?.proximityPips ?? 5,
    minZoneStrength: u.mtfZones?.minZoneStrength ?? 3,
    timeframes: u.mtfZones?.timeframes ?? ["4h", "1h", "15m", "5m"],
  },
};

export { REPO_ROOT, repoPath };
