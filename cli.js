#!/usr/bin/env node
import "dotenv/config";
import { runScreeningCycle, runManagementCycle } from "./index.js";
import { cancelSetup, cancelAllOpenSetups, getSetupsSummary } from "./setups.js";
import { closeMcp } from "./tools/mcp-client.js";
import { formatAgentStatus } from "./status.js";
import { getSetupMemorySummary, getThesisMemory } from "./setup-memory.js";
import { formatPerformanceStats } from "./performance-stats.js";
import { getActiveMode } from "./modes.js";
import { testTelegram } from "./telegram.js";

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
    case "plan": {
      const { getActivePlan, formatPlanMessage } = await import("./planner.js");
      console.log(formatPlanMessage(getActivePlan()));
      break;
    }
    case "replan": {
      const { createPlan, formatPlanMessage } = await import("./planner.js");
      console.log(formatPlanMessage(await createPlan({ reason: "manual (cli)" })));
      break;
    }
    case "calendar": {
      const { getCalendarEvents, upcomingEvents, formatEvent } = await import("./tools/calendar.js");
      const evs = upcomingEvents(await getCalendarEvents(), Date.now(), 24 * 7);
      console.log(evs.length ? evs.map((e) => formatEvent(e)).join("\n") : "No high-impact events left this week.");
      break;
    }
    case "stats":
      console.log(formatPerformanceStats(getActiveMode().id));
      break;
    case "cancel":
      if (!arg || arg === "all") {
        const ids = cancelAllOpenSetups();
        console.log(ids.length ? `Cancelled: ${ids.join(", ")}` : "No open setups.");
      } else {
        const setup = cancelSetup(arg);
        console.log(setup ? `Cancelled: ${arg}` : `Setup not found: ${arg}`);
      }
      break;
    case "setups":
      console.log(getSetupsSummary());
      break;
    case "telegram-test":
      console.log(JSON.stringify(await testTelegram(), null, 2));
      break;
    default:
      console.log(`Shaolin CLI

  node cli.js screen      Run one screening cycle
  node cli.js manage      Run one management cycle
  node cli.js status      Agent status summary
  node cli.js setups      List open setups
  node cli.js cancel all  Cancel all open setups
  node cli.js cancel <id> Cancel one setup by ID
  node cli.js memory [fp] Thesis memory (or one fingerprint)
  node cli.js stats       Track record by setup type / session
  node cli.js calendar    High-impact USD events this week
  node cli.js plan        Today's plan
  node cli.js replan      Build a new plan now (uses the planning model)
  node cli.js telegram-test  Test Telegram bot + send ping
  npm run mcp:smoke       MCP smoke test
`);
  }
  await closeMcp();
}

main().catch(async (e) => {
  console.error(e.message);
  await closeMcp();
  process.exit(1);
});
