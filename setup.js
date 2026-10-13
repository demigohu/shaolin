#!/usr/bin/env node
import fs from "fs";
import readline from "readline";
import { repoPath } from "./repo-root.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q, def = "") {
  return new Promise((resolve) => {
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => resolve(a.trim() || def));
  });
}

/** Set KEY=value in .env text: replaces an existing (even commented-out) line, else appends. */
function setEnv(env, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  return re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
}

async function main() {
  console.log("\n🥋 Shaolin Setup\n");

  if (!fs.existsSync(repoPath("user-config.json"))) {
    fs.copyFileSync(repoPath("user-config.example.json"), repoPath("user-config.json"));
  }
  if (!fs.existsSync(repoPath(".env"))) {
    fs.copyFileSync(repoPath(".env.example"), repoPath(".env"));
  }

  const config = JSON.parse(fs.readFileSync(repoPath("user-config.json"), "utf8"));
  let mode = await ask("Trading mode (scalp/day/swing)", config.activeMode || "scalp");
  while (!["scalp", "day", "swing"].includes(mode)) mode = await ask("Mode must be scalp, day or swing", "scalp");
  config.activeMode = mode;
  config.broker = config.broker || {};
  config.broker.name = await ask("Broker name", config.broker.name || "HFM");
  config.broker.pipSize = Number(await ask("Pip size (0.1 = 10 cents on 2-digit gold)", String(config.broker.pipSize ?? 0.1)));
  config.broker.priceOffset = Number(await ask("Price offset feed→broker", String(config.broker.priceOffset ?? 0)));
  fs.writeFileSync(repoPath("user-config.json"), JSON.stringify(config, null, 2));

  let env = fs.readFileSync(repoPath(".env"), "utf8");
  const baseUrl = await ask("LLM base URL (OpenAI-compatible)", "https://openrouter.ai/api/v1");
  const apiKey = await ask("LLM API key (or skip)", "");
  const model = await ask("LLM model id (or skip)", "");
  env = setEnv(env, "LLM_BASE_URL", baseUrl);
  if (apiKey) env = setEnv(env, "LLM_API_KEY", apiKey);
  if (model) env = setEnv(env, "LLM_MODEL", model);

  const tg = await ask("Telegram bot token (or skip)", "");
  if (tg) env = setEnv(env, "TELEGRAM_BOT_TOKEN", tg);
  const chat = await ask("Telegram chat ID (or skip)", "");
  if (chat) env = setEnv(env, "TELEGRAM_CHAT_ID", chat);
  fs.writeFileSync(repoPath(".env"), env);

  rl.close();
  console.log("\nConfig written. Next: npm run mcp:install && npm run dev");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
