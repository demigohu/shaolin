import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

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
    timeframes: ["5m", "15m", "1h"],
    screeningIntervalMin: 10,
    managementIntervalMin: 3,
    setupMaxAgeMin: 90,
    entryZonePips: 3,
    minConfidence: 65,
    minRrRatio: 1.2,
    combinedTimeframe: "15m",
    partialTp: [{ pct: 50, atRr: 1.0 }, { pct: 50, atRr: 2.0 }],
    sessions: ["london", "new_york", "overlap"],
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
    pipSize: u.pipSize ?? u.broker?.pipSize ?? 0.01,
    digits: u.digits ?? u.broker?.digits ?? 2,
    priceOffset: u.priceOffset ?? u.broker?.priceOffset ?? 0,
  },
  modes: { ...defaultModes, ...(u.modes || {}) },
  screening: {
    maxSetupsPerDay: u.maxSetupsPerDay ?? 8,
    newsBlackoutMinutes: u.newsBlackoutMinutes ?? 0,
    nearTpSlAlertPct: u.nearTpSlAlertPct ?? 80,
  },
  management: {
    breakevenAlertAfterTp1: u.breakevenAlertAfterTp1 ?? true,
  },
  llm: {
    temperature: u.temperature ?? 0.35,
    maxTokens: u.maxTokens ?? 4096,
    maxSteps: u.maxSteps ?? 15,
    screeningModel: u.screeningModel ?? u.llm?.screeningModel ?? "openrouter/healer-alpha",
    managementModel: u.managementModel ?? u.llm?.managementModel ?? "openrouter/healer-alpha",
    generalModel: u.generalModel ?? u.llm?.generalModel ?? "openrouter/healer-alpha",
  },
  strategy: {
    requireBacktestApproval: u.requireBacktestApproval ?? false,
    activeStrategyId: u.activeStrategyId ?? "scalp_mtf_default",
  },
};

export { REPO_ROOT, repoPath };
