import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const ENV_PATH = repoPath(".env");
const CONFIG_PATH = repoPath("user-config.json");
const EXAMPLE_CONFIG = repoPath("user-config.example.json");

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function loadUserConfigTelegram() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  try {
    const u = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (u.telegramBotToken) process.env.TELEGRAM_BOT_TOKEN ||= String(u.telegramBotToken);
    if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);
  } catch (error) {
    log("telegram_warn", `Failed to read user-config.json: ${error.message}`);
  }
}

loadEnvFile();
loadUserConfigTelegram();

function getAllowedUserIds() {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function isSenderAllowed(msg) {
  const allowed = getAllowedUserIds();
  if (!allowed.length) return true;
  const fromId = msg?.from?.id != null ? String(msg.from.id) : null;
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : null;
  return allowed.includes(fromId) || allowed.includes(chatId);
}

export function getTelegramStatus() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  return {
    enabled: Boolean(token && chatId),
    hasToken: Boolean(token),
    hasChatId: Boolean(chatId),
    chatId: chatId || null,
    allowedUsers: getAllowedUserIds(),
  };
}

export function isEnabled() {
  return getTelegramStatus().enabled;
}

export async function sendMessage(text, chatId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const targetChatId = chatId ?? process.env.TELEGRAM_CHAT_ID?.trim();

  if (!token || !targetChatId) {
    log("telegram", `[not configured] ${text.slice(0, 200)}`);
    return { ok: false, skipped: true, reason: "telegram_not_configured" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: targetChatId, text: text.slice(0, 4000) }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    log("telegram_error", JSON.stringify(body).slice(0, 500));
    return { ok: false, error: body };
  }
  return body;
}

async function deleteWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (body.ok) log("telegram", "Webhook cleared (long-polling mode)");
    else if (body.description) log("telegram_warn", `deleteWebhook: ${body.description}`);
  } catch (error) {
    log("telegram_warn", `deleteWebhook failed: ${error.message}`);
  }
}

export async function testTelegram() {
  const status = getTelegramStatus();
  if (!status.enabled) {
    return {
      ok: false,
      status,
      message: "Set TELEGRAM_BOT_TOKEN in .env (and TELEGRAM_CHAT_ID or telegramChatId in user-config.json)",
    };
  }

  await deleteWebhook();
  const result = await sendMessage("🥋 Shaolin Telegram test OK");
  return { ok: result?.ok !== false && !result?.skipped, status, result };
}

export async function startPolling(onMessage) {
  const status = getTelegramStatus();
  if (!status.enabled) {
    log("telegram_warn", "Telegram disabled — set TELEGRAM_BOT_TOKEN in .env and TELEGRAM_CHAT_ID (or telegramChatId in user-config.json)");
    return;
  }

  await deleteWebhook();
  log("telegram", `Polling started → chat ${status.chatId}`);

  let offset = 0;
  const poll = async () => {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`;
      const res = await fetch(url);
      const data = await res.json();

      if (data.ok === false) {
        log("telegram_error", data.description || JSON.stringify(data));
        setTimeout(poll, 5000);
        return;
      }

      for (const upd of data.result || []) {
        offset = upd.update_id + 1;
        const msg = upd.message;
        if (!msg?.text) continue;
        if (!isSenderAllowed(msg)) {
          log("telegram_warn", `Ignored message from unauthorized user ${msg.from?.id}`);
          continue;
        }
        await onMessage(msg);
      }
    } catch (error) {
      log("telegram_error", error.message);
    }
    setTimeout(poll, 500);
  };
  poll();
}

export function ensureConfigFiles() {
  if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(EXAMPLE_CONFIG)) {
    fs.copyFileSync(EXAMPLE_CONFIG, CONFIG_PATH);
    log("setup", "Created user-config.json from example");
  }
  if (!fs.existsSync(ENV_PATH) && fs.existsSync(repoPath(".env.example"))) {
    fs.copyFileSync(repoPath(".env.example"), ENV_PATH);
    log("setup", "Created .env from example — add your API keys");
  }
}

ensureConfigFiles();
