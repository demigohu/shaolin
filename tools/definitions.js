export const tools = [
  {
    type: "function",
    function: {
      name: "get_xauusd_mtf",
      description: "Multi-timeframe analysis for XAUUSD (OANDA): Weekly→Daily→4H→1H→15m alignment.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_xauusd_combined",
      description: "Combined TA + news sentiment for XAUUSD on the active mode timeframe.",
      parameters: {
        type: "object",
        properties: {
          timeframe: { type: "string", description: "e.g. 15m, 1h, 4h, 1D" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_xauusd_price",
      description: "Current XAUUSD price quote (Yahoo GC=F proxy for management).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_gold_news",
      description: "Recent financial news relevant to gold.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_context",
      description: "Global market snapshot (indices, VIX, FX, GLD).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_setup",
      description: "Log a trade setup (entry, SL, TP levels). ONLY call when action is SETUP. Never claim execution.",
      parameters: {
        type: "object",
        properties: {
          side: { type: "string", enum: ["long", "short"] },
          entry: { type: "number" },
          sl: { type: "number" },
          confidence: { type: "number", description: "0-100" },
          bias: { type: "string" },
          reason: { type: "string" },
          thesis_id: { type: "string", description: "Short thesis identifier for dedup" },
          risks: { type: "array", items: { type: "string" } },
        },
        required: ["side", "entry", "sl", "confidence", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_setups",
      description: "List open proposed/active setups being monitored.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "backtest_strategy",
      description: "Backtest a strategy on XAUUSD historical data via Yahoo.",
      parameters: {
        type: "object",
        properties: {
          strategy: { type: "string", enum: ["rsi", "bollinger", "macd", "ema_cross", "supertrend", "donchian", "rsi_pullback", "keltner_breakout", "triple_ema"] },
          period: { type: "string", enum: ["1mo", "3mo", "6mo", "1y", "2y"] },
          interval: { type: "string", enum: ["1d", "1h"] },
          strategy_id: { type: "string" },
        },
        required: ["strategy"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_strategies",
      description: "Compare all 9 backtest strategies on XAUUSD.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string" },
          interval: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_screening",
      description: "Recent screening decision log.",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" } },
        additionalProperties: false,
      },
    },
  },
];
