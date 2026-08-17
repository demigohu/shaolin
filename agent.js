import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { log } from "./logger.js";
import { config } from "./config.js";

const SCREENER_TOOLS = new Set([
  "get_xauusd_mtf", "get_xauusd_combined", "get_xauusd_price", "get_gold_news",
  "get_market_context", "propose_setup",
]);
const MANAGER_TOOLS = new Set(["get_xauusd_price", "get_active_setups", "get_xauusd_combined"]);
const GENERAL_TOOLS = new Set(tools.map((t) => t.function.name));

function getToolsForRole(agentType) {
  const allowed = agentType === "SCREENER" ? SCREENER_TOOLS
    : agentType === "MANAGER" ? MANAGER_TOOLS
    : GENERAL_TOOLS;
  return tools.filter((t) => allowed.has(t.function.name));
}

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const ONCE_PER_SESSION = new Set(["propose_setup"]);

export async function agentLoop(goal, maxSteps = config.llm.maxSteps, agentType = "GENERAL", model = null, options = {}) {
  const { context = {}, onToolStart, onToolFinish } = options;
  const systemPrompt = buildSystemPrompt(agentType, context);
  let messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: goal },
  ];

  const firedOnce = new Set();
  const usedModel = model || (agentType === "SCREENER" ? config.llm.screeningModel : agentType === "MANAGER" ? config.llm.managementModel : config.llm.generalModel);

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps} [${agentType}]`);

    const toolChoice = step === 0 && agentType === "SCREENER" ? "required" : "auto";
    const response = await client.chat.completions.create({
      model: usedModel,
      messages,
      tools: getToolsForRole(agentType),
      tool_choice: toolChoice,
      temperature: config.llm.temperature,
      max_tokens: config.llm.maxTokens,
    });

    const msg = response.choices[0].message;
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

      if (ONCE_PER_SESSION.has(name) && firedOnce.has(name)) {
        return {
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ blocked: true, reason: `${name} already called this session` }),
        };
      }

      await onToolStart?.({ name, args, step });
      const result = await executeTool(name, args);
      await onToolFinish?.({ name, args, result, step });
      if (ONCE_PER_SESSION.has(name)) firedOnce.add(name);

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
