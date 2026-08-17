#!/usr/bin/env node
import "dotenv/config";
import { mcpBinaryExists, callMcpTool, closeMcp } from "../tools/mcp-client.js";

async function main() {
  if (!mcpBinaryExists()) {
    console.error("MCP not installed. Run: npm run mcp:install");
    process.exit(1);
  }

  console.log("Smoke test: multi_timeframe_analysis OANDA:XAUUSD...");
  const mtf = await callMcpTool("multi_timeframe_analysis", {
    symbol: "XAUUSD",
    exchange: "OANDA",
  }, 180000);
  console.log("MTF keys:", Object.keys(mtf));
  console.log(JSON.stringify(mtf, null, 2).slice(0, 1500));

  console.log("\nSmoke test: yahoo_price GC=F...");
  const price = await callMcpTool("yahoo_price", { symbol: "GC=F" }, 60000);
  console.log(JSON.stringify(price, null, 2).slice(0, 800));

  await closeMcp();
  console.log("\n✓ Smoke tests passed");
}

main().catch((error) => {
  console.error("Smoke test failed:", error.message);
  process.exit(1);
});
