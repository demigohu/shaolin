import fs from "fs";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { editMessage, sendMessage } from "./telegram.js";
import { formatPriceStream } from "./notifications.js";

const STATE_FILE = repoPath("price-stream-state.json");
let lastStreamEditAt = 0;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function updatePriceStream(open, price) {
  if (config.management?.priceStreamTelegram === false) return;
  if (!open?.length || price == null) {
    await clearPriceStream();
    return;
  }

  const minSec = config.management?.priceStreamEditMinSec ?? 15;
  if (Date.now() - lastStreamEditAt < minSec * 1000) return;

  const text = formatPriceStream(open, price);
  const state = loadState();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  if (state.message_id && chatId) {
    const edited = await editMessage(text, state.message_id, chatId);
    if (edited.ok) {
      lastStreamEditAt = Date.now();
      return;
    }
    log("price_stream", "Edit failed — sending new stream message");
  }

  const sent = await sendMessage(text, chatId);
  const messageId = sent?.result?.message_id;
  if (messageId) {
    saveState({ message_id: messageId, chat_id: chatId, updated_at: new Date().toISOString() });
    lastStreamEditAt = Date.now();
  }
}

export async function clearPriceStream() {
  const state = loadState();
  if (!state.message_id) return;
  const chatId = state.chat_id || process.env.TELEGRAM_CHAT_ID?.trim();
  if (chatId) {
    await editMessage("📊 Shaolin — monitoring ended (no open setups).", state.message_id, chatId);
  }
  saveState({});
  lastStreamEditAt = 0;
}

export function resetStreamCooldown() {
  lastStreamEditAt = 0;
}
