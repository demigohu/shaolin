export const tools = [
  {
    type: "function",
    function: {
      name: "get_xauusd_mtf",
      description: "Multi-timeframe trend alignment for XAUUSD (TVC:GOLD): intraday 5m→15m→1h→4h (scalp) or Weekly→15m stack (day/swing).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_xauusd_combined",
      description: "TradingView TA for XAUUSD on one timeframe (plus last-24h gold headlines when news is enabled).",
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
      description: "Current XAUUSD spot price on the screening feed (TVC:GOLD).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_gold_news",
      description: "Gold headlines from the last 24h (Marketaux), newest first.",
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
      name: "get_economic_calendar",
      description: "High-impact USD economic releases (CPI, NFP, FOMC, Fed speakers...) with WIB time, countdown, forecast/previous, and whether a news blackout is active now.",
      parameters: {
        type: "object",
        properties: { hours: { type: "number", description: "Look-ahead window in hours (default 48)" } },
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
      name: "get_mtf_zones",
      description: "MTF S/R zone stack (fractal swings 4h/1h/15m/5m + PDH/PDL/PWH/PWL/Asian + monthly pivots): merged support/resistance and nearest zones to price.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_smc_context",
      description: "SMC framework: AMD session phase, Asian range, PDH/PDL, liquidity raids (BSL/SSL taken/swept), BOS, order blocks, fib OTE, suggested setup types.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_setup",
      description: "Log a setup once its trigger is complete (sweep / BMS / RTO at an HTF key level). YOU set entry, SL and tp_levels from structure.",
      parameters: {
        type: "object",
        properties: {
          side: { type: "string", enum: ["long", "short"] },
          entry: { type: "number", description: "market: within a few pips of live price; limit: on the retrace side (long ≤ price, short ≥ price)" },
          sl: { type: "number", description: "Stop beyond structure invalidation (may be wide if next SNR/fib is far)" },
          sl_anchor: {
            type: "string",
            description: "REQUIRED. Why SL is here — e.g. 'above 1H high 4396.89 + sweep buffer' or 'below PDL 4345 sweep wick'",
          },
          tp_levels: {
            type: "array",
            description: "Take-profit ladder at SNR/fib targets (required on SETUP)",
            items: {
              type: "object",
              properties: {
                price: { type: "number" },
                label: {
                  type: "string",
                  description: "REQUIRED. Structure target — e.g. 'MTF support / 4H demand 4389.9'",
                },
                close_pct: { type: "number", description: "Percent of position to close at this TP" },
                rr: { type: "number", description: "Optional RR label for logging" },
              },
              required: ["price", "label"],
            },
          },
          confidence: { type: "number", description: "0-100; below the mode's minConfidence is rejected" },
          setup_type: {
            type: "string",
            enum: ["turtle_soup_long", "turtle_soup_short", "sh_bms_rto", "sms_bms_rto", "bms_rto_ote", "amd_distribution"],
          },
          confluence_factors: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "htf_bias", "htf_key_level", "mtf_sr_zone", "liquidity_sweep", "bms", "order_block_rto", "fib_ote",
                "asian_range", "session_amd", "london_open", "ny_open", "high_impact_news", "plan_poi",
              ],
            },
          },
          bias: { type: "string" },
          reason: { type: "string", description: "Required: the HTF key level and the trigger sequence you saw (e.g. 'PDL swept, 5m BMS up, RTO into 15m bullish OB'). SL/TP structure goes in sl_anchor + tp_levels[].label." },
          thesis_id: { type: "string", description: "Short human-readable thesis label" },
          entry_style: {
            type: "string",
            enum: ["market", "limit"],
            description: "market = reclaim now; limit = fib/SNR retrace",
          },
          risks: { type: "array", items: { type: "string" } },
          screening_snapshot: {
            type: "object",
            description: "Optional screening signals (mtf_net_score, rsi, etc.)",
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
