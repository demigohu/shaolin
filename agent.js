import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { log } from "./logger.js";
import { config } from "./config.js";

const SCREENER_TOOLS = new Set([
  "get_smc_context", "get_mtf_zones", "get_xauusd_mtf", "get_xauusd_combined", "get_xauusd_price", "get_gold_news",
  "get_market_context", "get_economic_calendar", "propose_setup",
]);

function getToolsForRole(agentType) {
  const enabled = tools.filter((t) => t.function.name !== "get_gold_news" || config.news?.enabled);
  return agentType === "SCREENER" ? enabled.filter((t) => SCREENER_TOOLS.has(t.function.name)) : enabled;
}

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("No LLM API key — set LLM_API_KEY (or OPENROUTER_API_KEY) in .env");
  client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey,
    timeout: 5 * 60 * 1000,
  });
  return client;
}

const ONCE_PER_SESSION = new Set(["propose_setup"]);

export async function agentLoop(goal, maxSteps = config.llm.maxSteps, agentType = "GENERAL", model = null, options = {}) {
  const { context = {}, history = null, onToolStart, onToolFinish } = options;
  // `history` continues an earlier conversation (system prompt + tool results included).
  const messages = history
    ? [...history, { role: "user", content: goal }]
    : [{ role: "system", content: buildSystemPrompt(agentType, context) }, { role: "user", content: goal }];

  const firedOnce = new Set();
  const usedModel = model || (agentType === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel);

  for (let step = 0; step < maxSteps; step++) {
    if (step === 0) {
      log("agent", `LLM ${process.env.LLM_BASE_URL || "openrouter"} | model ${usedModel}`);
    }
    log("agent", `Step ${step + 1}/${maxSteps} [${agentType}]`);

    const toolChoice = step === 0 && agentType === "SCREENER" ? "required" : "auto";
    const response = await getClient().chat.completions.create({
      model: usedModel,
      messages,
      tools: getToolsForRole(agentType),
      tool_choice: toolChoice,
      temperature: config.llm.temperature,
      max_tokens: config.llm.maxTokens,
    });

    const msg = response.choices?.[0]?.message;
    if (!msg) throw new Error(`LLM returned no choices: ${JSON.stringify(response).slice(0, 300)}`);
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.arguments) {
          try {
            JSON.parse(tc.function.arguments);
          } catch {
            try {
              tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
            } catch {
              tc.function.arguments = "{}";
            }
          }
        }
      }
    }
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      return { content: msg.content || "", messages };
    }

    const results = await Promise.all(msg.tool_calls.map(async (tc) => {
      const name = tc.function.name.replace(/<.*$/, "").trim();
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
      }

      if (ONCE_PER_SESSION.has(name)) {
        // Marked before awaiting — parallel tool calls in one message must not both run.
        if (firedOnce.has(name)) {
          return {
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ blocked: true, reason: `${name} already succeeded or is running this session` }),
          };
        }
        firedOnce.add(name);
      }

      await onToolStart?.({ name, args, step });
      const result = await executeTool(name, args);
      await onToolFinish?.({ name, args, result, step });
      // A gate rejection tells the model how to fix the setup — let it retry.
      if (ONCE_PER_SESSION.has(name) && !result?.success) firedOnce.delete(name);

      return {
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      };
    }));

    messages.push(...results);
  }

  return { content: "Max steps reached.", messages };
}
