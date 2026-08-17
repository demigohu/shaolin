#!/usr/bin/env node
import "dotenv/config";
import { runScreeningCycle, runManagementCycle } from "./index.js";
import { closeMcp } from "./tools/mcp-client.js";
import { compareStrategies } from "./tools/backtest.js";
import { ensureStrategyApproved, getActiveStrategy } from "./strategies.js";
import { formatAgentStatus } from "./status.js";
import { getSetupMemorySummary, getThesisMemory } from "./setup-memory.js";
import { getWeightsSummary } from "./signal-weights.js";
import { config } from "./config.js";
import { testTelegram, getTelegramStatus } from "./telegram.js";

const cmd = process.argv[2];
const arg = process.argv[3];

async function main() {
  switch (cmd) {
    case "screen":
      console.log(await runScreeningCycle({ silent: false }));
      break;
    case "manage":
      console.log(await runManagementCycle({ silent: true }));
      break;
    case "status":
      console.log(formatAgentStatus());
      break;
    case "memory":
      if (arg) {
        console.log(JSON.stringify(getThesisMemory(arg), null, 2));
      } else {
        console.log(getSetupMemorySummary(10));
      }
      break;
    case "weights":
      console.log(config.darwin?.enabled === false
        ? "Darwin signal weights disabled."
        : getWeightsSummary());
      break;
    case "gate": {
      const strategy = getActiveStrategy();
      const gate = await ensureStrategyApproved(strategy.id);
      console.log(JSON.stringify(gate, null, 2));
      break;
    }
    case "backtest":
      console.log(JSON.stringify(await compareStrategies({ period: "1y", interval: "1h" }), null, 2));
      break;
    case "telegram-test":
      console.log(JSON.stringify(await testTelegram(), null, 2));
      break;
    case "smoke":
      console.log("Use: npm run mcp:smoke");
      break;
    default:
      console.log(`Shaolin CLI

  node cli.js screen      Run one screening cycle
  node cli.js manage      Run one management cycle
  node cli.js status      Agent status summary
  node cli.js memory      Thesis memory (or pass fingerprint)
  node cli.js weights     Signal weight summary
  node cli.js gate        Run/check backtest gate
  node cli.js telegram-test  Test Telegram bot + send ping
  node cli.js backtest    Compare strategies on XAUUSD
  node cli.js smoke       MCP smoke test
`);
  }
  await closeMcp();
}

main().catch(async (e) => {
  console.error(e.message);
  await closeMcp();
  process.exit(1);
});
