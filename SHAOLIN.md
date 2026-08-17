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

## Not in v0.1

- HiveMind, signal weights evolution, setup-memory snapshots
- Full Telegram live messages
- PM2 ecosystem file
