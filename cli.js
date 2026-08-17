#!/usr/bin/env node
import "dotenv/config";
import { runScreeningCycle, runManagementCycle } from "./index.js";
import { closeMcp } from "./tools/mcp-client.js";
import { compareStrategies } from "./tools/backtest.js";

const cmd = process.argv[2];

async function main() {
  switch (cmd) {
    case "screen":
      console.log(await runScreeningCycle({ silent: true }));
      break;
    case "manage":
      console.log(await runManagementCycle({ silent: true }));
      break;
    case "backtest":
      console.log(JSON.stringify(await compareStrategies({ period: "1y", interval: "1h" }), null, 2));
      break;
    case "smoke":
      console.log("Use: npm run mcp:smoke");
      break;
    default:
      console.log(`Shaolin CLI

  node cli.js screen     Run one screening cycle
  node cli.js manage     Run one management cycle
  node cli.js backtest   Compare strategies on XAUUSD
  node cli.js smoke      MCP smoke test
`);
  }
  await closeMcp();
}

main().catch(async (e) => {
  console.error(e.message);
  await closeMcp();
  process.exit(1);
});
