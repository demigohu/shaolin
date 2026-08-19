export const tools = [
  {
    type: "function",
    function: {
      name: "get_xauusd_mtf",
      description: "Multi-timeframe analysis for XAUUSD (OANDA): intraday 5m→15m→1h→4h alignment (scalp) or Weekly→Daily stack (swing).",
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
      name: "get_smc_context",
      description: "SMC framework: AMD session phase, Asian range, PDH/PDL, liquidity sweeps (BSL/SSL), HTF bias, suggested setup types.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_setup",
      description: "Log SMC setup. Requires setup_type + confluence_factors (min 2). Entry on RTO/fib retrace — not chase.",
      parameters: {
        type: "object",
        properties: {
          side: { type: "string", enum: ["long", "short"] },
          entry: { type: "number" },
          sl: { type: "number" },
          confidence: { type: "number", description: "0-100" },
          setup_type: {
            type: "string",
            enum: ["turtle_soup_long", "turtle_soup_short", "sh_bms_rto", "sms_bms_rto", "amd_distribution", "fib_retrace"],
          },
          confluence_factors: {
            type: "array",
            items: {
              type: "string",
              enum: ["htf_bias", "ltf_structure", "liquidity_sweep", "order_block_rto", "fib_ote", "london_open", "ny_open", "asian_range", "session_amd", "news_catalyst"],
            },
          },
          bias: { type: "string" },
          reason: { type: "string" },
          thesis_id: { type: "string", description: "Short thesis identifier for dedup" },
          entry_style: {
            type: "string",
            enum: ["market", "limit"],
            description: "market = enter now near live price; limit = wait for retrace to entry level",
          },
          risks: { type: "array", items: { type: "string" } },
          screening_snapshot: {
            type: "object",
            description: "Optional screening signals (mtf_net_score, rsi, news_sentiment_score, etc.)",
          },
        },
        required: ["side", "entry", "sl", "confidence", "reason", "setup_type", "confluence_factors"],
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
      name: "list_strategies",
      description: "List registered strategies with backtest status and which is active.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "backtest_mcp_strategy",
      description: "Backtest an MCP strategy on XAUUSD. Optionally activate if approved.",
      parameters: {
        type: "object",
        properties: {
          strategy: { type: "string", enum: ["rsi", "bollinger", "macd", "ema_cross", "supertrend", "donchian", "rsi_pullback", "keltner_breakout", "triple_ema"] },
          period: { type: "string", enum: ["1mo", "3mo", "6mo", "1y", "2y"] },
          interval: { type: "string", enum: ["1d", "1h"] },
          activate: { type: "boolean", description: "Set true to activate for screening if backtest passes" },
        },
        required: ["strategy"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_strategy",
      description: "Switch active screening strategy. Must be backtest-approved if gate enabled.",
      parameters: {
        type: "object",
        properties: {
          strategy_id: { type: "string", description: "e.g. scalp_supertrend" },
          mcp_strategy: { type: "string", description: "Shorthand: supertrend, rsi, etc." },
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
