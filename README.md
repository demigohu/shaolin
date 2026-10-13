# Shaolin

XAUUSD forex screening & setup management agent.

- **Price feed:** TradingView `TVC:GOLD` via the bundled TradingView MCP (git submodule). The MCP maps `XAUUSD` to `TVC:GOLD` whatever exchange is passed.
- **Structure levels:** candle history (PDH/PDL, Asian range, swings, order blocks) from Yahoo `GC=F`, shifted onto spot by the measured futures→spot basis
- **Execution:** human-in-the-loop. Setups are logged and alerted, and you enter manually on MT5 (HFM)
- **Modes:** scalp (default) | day | swing

## Quick start

```bash
git clone --recurse-submodules <repo> shaolin
cd shaolin
npm install
npm run setup          # wizard: mode, broker, LLM + Telegram keys
npm run mcp:install    # Python 3.13 venv + tradingview-mcp from source
npm run mcp:smoke      # verify MCP + price feed
npm run dev            # daemon with file watch
npm start              # production daemon
npm run pm2:start      # PM2 background daemon
npm test               # syntax + unit tests
```

## CLI

```bash
node cli.js screen          # one screening cycle
node cli.js manage          # one management cycle
node cli.js status          # mode, setups, memory, track record
node cli.js setups          # open setups
node cli.js cancel all|<id> # cancel setups
node cli.js memory [fp]     # thesis history
node cli.js stats           # track record by setup type / session
node cli.js calendar        # high-impact USD events this week
node cli.js plan            # today's plan
node cli.js replan          # rebuild the plan now (planning model)
node cli.js telegram-test   # send a Telegram ping
```

## Telegram

```
/screen          Run screening now
/manage          Run management cycle
/status          Full agent status
/setups          Open setups
/cancel all|<id> Cancel setups
/stats           Track record by setup type / session / side
/calendar        High-impact USD events this week
/plan            Today's plan (bias, POIs, triggers)
/replan          Rebuild the plan now
/memory          Thesis history
/mode scalp      Switch mode (scalp|day|swing, saved to user-config.json)
/help
```

Any other text goes to the GENERAL agent. Without `TELEGRAM_ALLOWED_USER_IDS`, only `TELEGRAM_CHAT_ID` can command the bot.

## Config

Edit `user-config.json` (created from `user-config.example.json`):

- `activeMode`: scalp | day | swing. Per-mode keys override the built-in defaults.
- `broker.pipSize`: 0.1 for 2-digit gold (1 pip = 10 cents)
- `broker.priceOffset`: feed vs broker quote difference (display only)
- `screening.*`: entry distance, RSI and RR gates
- `llm.planningModel` / `llm.screeningModel`: one model per role (a strong model for planning, a reliable tool-caller for screening)
- `plan.*`: daily plan times (WIB), off-plan B-grade requirements
- `watcher.*`: 1-minute POI / liquidity-sweep trigger
- `strategyVersion`: bump when rules change — stats only count the current version
- `calendar.*`: news blackout around high-impact releases (Forex Factory feed), `blackoutBeforeMin` / `blackoutAfterMin`
- `performanceGate.*`: auto-block setup types with a losing record (≥ minTrades, win rate ≤ maxWinRate, net < 0)

## Architecture

See [SHAOLIN.md](./SHAOLIN.md).
