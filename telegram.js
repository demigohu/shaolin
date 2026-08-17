import fs from "fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const ENV_PATH = repoPath(".env");
const CONFIG_PATH = repoPath("user-config.json");
const EXAMPLE_CONFIG = repoPath("user-config.example.json");

function loadEnv() {
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

loadEnv();

export function isEnabled() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendMessage(text) {
  if (!isEnabled()) {
    log("telegram", text.slice(0, 200));
    return null;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
  if (!res.ok) {
    const body = await res.text();
    log("telegram_error", body);
  }
  return res.json().catch(() => null);
}

export async function startPolling(onMessage) {
  if (!isEnabled()) {
    log("telegram_warn", "Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
    return;
  }
  log("telegram", "Polling started");
  let offset = 0;
  const poll = async () => {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`;
      const res = await fetch(url);
      const data = await res.json();
      for (const upd of data.result || []) {
        offset = upd.update_id + 1;
        const msg = upd.message;
        if (msg?.text) await onMessage(msg);
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
