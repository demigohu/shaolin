import { log } from "./logger.js";
import "./config.js"; // loads .env + telegram keys from user-config.json into process.env

function getAllowedUserIds() {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Allowlist from TELEGRAM_ALLOWED_USER_IDS; without one, only the configured chat may command the bot. */
function isSenderAllowed(msg) {
  const allowed = getAllowedUserIds();
  if (!allowed.length) {
    const ownChat = process.env.TELEGRAM_CHAT_ID?.trim();
    return ownChat != null && String(msg?.chat?.id) === ownChat;
  }
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

/** POST to the Bot API; network/API failures are logged and returned, never thrown. */
async function telegramApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      log("telegram_error", `${method}: ${JSON.stringify(body).slice(0, 300)}`);
      return { ok: false, error: body };
    }
    return { ok: true, result: body.result };
  } catch (error) {
    log("telegram_error", `${method}: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

export async function sendMessage(text, chatId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const targetChatId = chatId ?? process.env.TELEGRAM_CHAT_ID?.trim();

  if (!token || !targetChatId) {
    log("telegram", `[not configured] ${text.slice(0, 200)}`);
    return { ok: false, skipped: true, reason: "telegram_not_configured" };
  }

  return telegramApi("sendMessage", { chat_id: targetChatId, text: text.slice(0, 4000) });
}

/** Send a PNG (Buffer) with an optional caption; failures are logged, never thrown. */
export async function sendPhoto(png, caption = "", chatId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const targetChatId = chatId ?? process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !targetChatId || !png) return { ok: false, skipped: true };
  try {
    const form = new FormData();
    form.append("chat_id", targetChatId);
    if (caption) form.append("caption", caption.slice(0, 1000));
    form.append("photo", new Blob([png], { type: "image/png" }), "setup.png");
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      log("telegram_error", `sendPhoto: ${JSON.stringify(body).slice(0, 300)}`);
      return { ok: false, error: body };
    }
    return { ok: true, result: body.result };
  } catch (error) {
    log("telegram_error", `sendPhoto: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

export async function editMessage(text, messageId, chatId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const targetChatId = chatId ?? process.env.TELEGRAM_CHAT_ID?.trim();

  if (!token || !targetChatId || !messageId) {
    return { ok: false, skipped: true, reason: "telegram_not_configured" };
  }

  return telegramApi("editMessageText", { chat_id: targetChatId, message_id: messageId, text: text.slice(0, 4000) });
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
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
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
        // Not awaited: a slow command (/screen, free-text agent) must not stall polling.
        Promise.resolve(onMessage(msg)).catch((error) => log("telegram_error", `handler: ${error.message}`));
      }
    } catch (error) {
      log("telegram_error", error.message);
    }
    setTimeout(poll, 500);
  };
  poll();
}
