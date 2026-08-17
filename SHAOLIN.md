# SHAOLIN.md — Engineering Manual

XAUUSD agent: screening → auto-log setup → monitor → lessons.

## TL;DR

- Node daemon + Python MCP subprocess (`mcp/.venv/bin/tradingview-mcp`)
- Submodule: `mcp/tradingview-mcp` (install from source via `npm run mcp:install`)
- No broker API — setups in `setups.json`, user trades MT5 manually
- SCREENER calls `propose_setup` once per cycle when SETUP
- MANAGER deterministic: entry zone, SL, partial TP, expire

## Entry points

| File | Role |
|---|---|
| `index.js` | Daemon, cron, Telegram |
| `cli.js` | One-shot screen / manage / backtest |
| `setup.js` | First-run wizard |

## Roles

| Role | Tools |
|---|---|
| SCREENER | mtf, combined, news, market, propose_setup |
| MANAGER | price, active setups, combined |
| GENERAL | all tools |

## Persistent files

| File | Purpose |
|---|---|
| `setups.json` | Proposed/active/resolved setups |
| `screening-log.json` | Audit every screening cycle |
| `lessons.json` | Performance + derived rules |
| `strategies.json` | Strategy library + backtest results |
| `setup-memory.json` | Thesis fingerprint history + cooldowns |
| `signal-weights.json` | Darwinian signal weights (learned) |
| `user-config.json` | Modes, broker pipSize, LLM models |

## Setup lifecycle

`proposed` → (price in entry zone) → `active` → `resolved` (tp_*, sl_hit, expired, invalidated)

Thesis dedup: same side + entry/SL fingerprint + entry zone → skip duplicate.

## MCP tools used

- `multi_timeframe_analysis` — symbol XAUUSD, exchange OANDA
- `combined_analysis` — TA + news
- `yahoo_price` — GC=F for management price
- `backtest_strategy` / `compare_strategies` — strategy validation

## Cron

Intervals from active mode in `user-config.json` (scalp: 10m screen / 3m manage).

## Patterns from Meridian

ReAct loop, JSON state, decision log, hybrid deterministic management, Telegram ops.

## Phase 2 (learning + gates) ✓

- **setup-memory** — thesis fingerprint history, cooldown on repeated failures
- **signal-weights** — Darwinian recalc every N closed setups; injected into SCREENER prompt
- **backtest gate** — `strategy.requireBacktestApproval` blocks screening/propose_setup until MCP backtest passes

## Ops

- **PM2:** `npm run pm2:start` / `npm run pm2:stop` / `npm run pm2:logs`
- **CLI:** `node cli.js status|memory|weights|gate`

## Not in v0.1

- HiveMind
- PM2 is supported; live-updating Telegram messages not implemented
