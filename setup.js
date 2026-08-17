#!/usr/bin/env node
import fs from "fs";
import readline from "readline";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q, def = "") {
  return new Promise((resolve) => {
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => resolve(a.trim() || def));
  });
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
  config.activeMode = await ask("Trading mode (scalp/day/swing)", "scalp");
  config.broker = config.broker || {};
  config.broker.name = await ask("Broker name", "HFM");
  config.broker.pipSize = Number(await ask("Pip size", "0.01"));
  config.broker.priceOffset = Number(await ask("Price offset OANDA→broker", "0"));

  fs.writeFileSync(repoPath("user-config.json"), JSON.stringify(config, null, 2));

  let env = fs.readFileSync(repoPath(".env"), "utf8");
  const apiKey = await ask("OpenRouter API key (or skip)", "");
  if (apiKey) {
    env = env.replace(/OPENROUTER_API_KEY=.*/, `OPENROUTER_API_KEY=${apiKey}`);
  }
  const tg = await ask("Telegram bot token (or skip)", "");
  if (tg) env = env.replace(/TELEGRAM_BOT_TOKEN=.*/, `TELEGRAM_BOT_TOKEN=${tg}`);
  fs.writeFileSync(repoPath(".env"), env);

  rl.close();
  log("setup", "Config written. Run: npm run mcp:install && npm run dev");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
