# Shaolin

XAUUSD forex screening & setup management agent.

- **Data:** TradingView MCP (`OANDA:XAUUSD`) bundled as git submodule
- **Execution:** Human-in-the-loop — setups auto-logged, you enter on MT5 (HFM)
- **Modes:** scalp (default) | day | swing

## Quick start

```bash
git clone --recurse-submodules <repo> shaolin
cd shaolin
npm install
npm run setup          # wizard + optional keys
npm run mcp:install    # Python 3.13 venv + tradingview-mcp from source
npm run mcp:smoke      # verify OANDA XAUUSD + price feed
npm run dev            # start daemon (DRY_RUN=true)
npm start              # production daemon
npm run pm2:start      # PM2 background daemon
```

## CLI

```bash
node cli.js screen     # one screening cycle
node cli.js manage     # one management cycle
node cli.js status     # mode, setups, memory, weights
node cli.js memory     # thesis history
node cli.js weights    # signal weights
node cli.js gate       # run/check backtest gate
node cli.js backtest   # compare MCP strategies
```

## Telegram

```
/screen          Run screening now
/manage          Run management cycle
/status          Full agent status
/setups          Open setups
/weights         Signal weights
/memory          Thesis history
/mode scalp      Switch mode (scalp|day|swing)
/strategies      List strategies
/backtest supertrend     Backtest strategy
/backtest supertrend activate   Backtest + activate
/use supertrend  Activate strategy for screening
/help
```

## Config

Edit `user-config.json`:

- `activeMode` — scalp | day | swing
- `broker.pipSize` — 0.01 for HFM 2-digit gold
- `broker.priceOffset` — OANDA vs HFM quote difference
- `darwin.enabled` — signal weight evolution (Phase 2)
- `strategy.requireBacktestApproval` — block screening until backtest passes

## Architecture

See [SHAOLIN.md](./SHAOLIN.md).

Meridian (`../meridian`) is the reference harness — not modified.
