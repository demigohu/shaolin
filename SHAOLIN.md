# SHAOLIN.md — Engineering Manual

XAUUSD agent: screening → auto-log setup → monitor → lessons.

## TL;DR

- Node daemon + Python MCP subprocess (`mcp/.venv/bin/tradingview-mcp`)
- Submodule: `mcp/tradingview-mcp` (install from source via `npm run mcp:install`)
- No broker API. Setups live in `setups.json` and the user trades MT5 manually.
- SCREENER (LLM) proposes setups through `propose_setup`, which applies hard gates. A rejected proposal returns the reason and the model may fix it and retry.
- Management is deterministic (`management.js`): limit fill, SL, partial TPs, stale and time stop.

## Entry points

| File | Role |
|---|---|
| `index.js` | Daemon, cron, Telegram commands |
| `cli.js` | One-shot screen / manage / status / backtest |
| `setup.js` | First-run wizard |

## Data sources

| Data | Source |
|---|---|
| Live price, indicators, RSI, EMA trend | MCP `coin_analysis` → TradingView `TVC:GOLD` (cached 30s) |
| Candle history (5m/15m/1h/1d; 4h aggregated) | Yahoo chart API `GC=F`, shifted by `basis = futures − spot` (`tools/candles.js`) |
| Monthly pivots | MCP `support_resistance`. These are `Pivot.M.Classic` and identical on every timeframe, so they are used once. |
| Economic calendar | Forex Factory weekly feed (`tools/calendar.js`), cached 1h, filtered by `calendar.currencies` / `impacts` |
| Gold headlines (off by default, `news.enabled`) | Marketaux directly (`tools/news.js`): `news.query`, last `lookbackHours`, newest first, cached `cacheMin`, capped at `dailyBudget`/day. The MCP's `combined_analysis` / `financial_news` are not used: their Marketaux lookup has no date filter and returned articles from years ago. |

Yahoo's COMEX quote lags about 10 minutes, so the basis is measured at a shared instant: the TradingView 1h/15m bar open vs the Yahoo 5m candle with the same timestamp. During the first ~10 minutes of an hour the last measurement is reused. The management price never falls back to Yahoo: it is delayed futures data, and SL/TP tracking pauses instead.

## Daily plan → watcher → screener (PDF: "HTF Analysis, LTF Entries")

1. **Plan** (`planner.js`) at `plan.times` WIB (default 06:30 / 13:30 / 18:30, Mon–Fri), on startup if none, and after invalidation (`replanCooldownMin`). The `llm.planningModel` reads a higher-timeframe structure view (scalp plans on the day profile) + the calendar and returns bias, invalidation levels and ≤5 POIs (zone, side, setups, trigger, targets). Saved in `plan-state.json` and pushed to Telegram; expires at the end of the trading day (18:00 New York).
2. **Watcher** (`watcher.js`, every `watcher.intervalSec`, no LLM): voids the plan when price trades through its invalidation (and re-plans), and fires a screening when price reaches a POI or sweeps a liquidity pool (Asian / PD / PW / equal highs-lows), with a per-trigger cooldown.
3. **Screener** runs on those triggers plus every `screeningIntervalMin`. The prompt carries the plan and the trigger; setups follow the PDF triggers only.
4. **Grading** in `propose_setup`: **A** = entry inside a POI on its side (`plan_poi` added), **B** = off-plan (needs `plan.offPlanMinConfidence` and `offPlanMinConfluence`), **unplanned** = no active plan.

Setups carry `strategy_version`, `grade`, `poi_id`, `plan_id`; `/stats` only counts the current `strategyVersion` and splits by grade.

## Setup types (PDF)

`turtle_soup_long/short` (sweep → back inside), `sh_bms_rto` (stop hunt → BMS → return to OB), `sms_bms_rto` (failure swing → BMS → RTO), `bms_rto_ote` (with the BMS on the 50%/OTE/OB retrace), `amd_distribution` (Asian range → London/NY false move → reverse). Liquidity pools: PDH/PDL, PWH/PWL, PMH/PML, Asian H/L, equal highs/lows, HOD/LOD.

## Structure per mode (`STRUCTURE_PROFILES` in `smc.js`)

| Mode | Trend TFs | Swing / fib | BOS / OB | Zone TFs | Liquidity pools | Killzone gate |
|---|---|---|---|---|---|---|
| scalp | 4h → 1h → 15m | 1h, 48 bars | 15m | 4h/1h/15m/5m | Asian, PD | yes |
| day | 1D → 4h → 1h | 4h, 30 bars | 1h | 1d/4h/1h/15m | Asian, PD, PW | yes |
| swing | 1W → 1D → 4h | 1D, 40 bars | 4h | 1w/1d/4h/1h | PD, PW | no |

The SR map in the SCREENER prompt only lists zones within the mode's reach (`maxTpPips` from price); farther levels (PDH/PWH/...) are shown with their distance and marked "context only", so the model doesn't anchor entries/SL/TP on them. All zones stay available to the SL structure checks.

Zone merge/proximity distance defaults to 8/5, 15/10 and 40/25 pips respectively. Override it per mode with `zoneMergePips` / `zoneProximityPips`. The Asian range only becomes a liquidity pool once it is complete (06:00 UTC).

## Session clock (DST-aware)

- Asian range: 00–06 UTC (07–13 WIB), fixed
- Killzones: London 08–13 London time, NY 08–11 New York time. That is 14–19 / 19–22 WIB in northern summer and 15–20 / 20–23 WIB in winter.
- Sessions for `mode.sessions`: london 08–17 London time, new_york 08–17 NY time, asian 00–07 UTC
- Market closed: Friday 17:00 → Sunday 18:00 New York time

## Roles

| Role | Tools |
|---|---|
| SCREENER | smc context, mtf zones, mtf, combined, price, news, market, propose_setup |
| GENERAL (Telegram free text) | all tools |

## propose_setup gates (in order)

news blackout → confidence ≥ `mode.minConfidence` → RSI extreme (`bms_rto_ote` only) → SMC (setup type, confluence, trading window, no shorting into a fresh SSL raid / no longing into a BSL raid) → entry vs live price (market within slippage; limit on the retrace side and within `maxLimitEntryPips`) → SL (side; structure checks when `llmOwnsTpSl=false`) → TP side → reason / `sl_anchor` / TP labels → min RR → plan grade (A / B / unplanned) → book-keeping (one open setup per side, thesis cooldown, daily cap).

## Persistent files

| File | Purpose |
|---|---|
| `setups.json` | Proposed/active/resolved setups (atomic writes) |
| `screening-log.json` | Audit of every screening cycle and blocked proposal |
| `lessons.json` | Performance records + derived lessons |
| `setup-memory.json` | Thesis history (side + setup type + mode + price area) + cooldowns |
| `user-config.json` | Modes, broker pipSize, LLM models |

All of these are local runtime state and gitignored.

## Setup lifecycle

`proposed` (limit) → fills when price trades to entry or through it → `active` → `resolved`.

Outcomes:
- Filled trades: `tp_hit`, `tp_full`, `tp_partial_then_sl`, `sl_hit`, `time_exit`, `invalidated`
- Never filled: `stale_no_fill`, `expired`, `invalidated_pre_fill`, `cancelled`

- SL/TP fills are booked at the level price. P&L is position-weighted across partial TPs.
- A limit is stale once price runs `maxStaleDistancePips` further away than it was when the setup was proposed.
- `setupMaxAgeMin` expires unfilled setups from proposal time. Filled setups get a time exit at that age, counted from the fill.
- Win rate, thesis cooldown and the performance gate count only filled trades.
- Fast management polls every `management.fastPollSec` while setups are open. TP/SL/fill events are always pushed to Telegram, and the live monitor message is edited in place.

## News blackout

Screening is skipped (no LLM call) and `propose_setup` rejects new setups from `calendar.blackoutBeforeMin` before until `blackoutAfterMin` after each high-impact event. The next 24h of events are shown in the SCREENER prompt. When setups are open, management sends a one-time Telegram warning `warnOpenSetupMin` before a release.

## Learning

- **setup-memory**: per-thesis history. A cooldown starts after `cooldownMinSetups` trades with win rate ≤ `cooldownMaxWinRate`.
- **performance-stats**: filled-trade record of the active mode over `performanceGate.windowDays`, grouped by setup type, session, side and confluence tag. It is shown to the SCREENER, and `propose_setup` rejects a setup type (per session, then overall) with ≥ `minTrades` trades, win rate ≤ `maxWinRate` and negative net pips.

## Cron

Intervals come from the active mode (scalp: 10m screen / 3m manage). Intervals of 60 minutes or more are scheduled hourly.

## Ops

- **PM2:** `npm run pm2:start` / `npm run pm2:stop` / `npm run pm2:logs`
- **Tests:** `npm test` (syntax + `node --test`)
