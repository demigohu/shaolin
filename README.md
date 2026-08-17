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
```

## Telegram

```
/screen          Run screening now
/status          Mode + open setups
/mode scalp      Switch mode (scalp|day|swing)
/help
```

## Config

Edit `user-config.json`:

- `activeMode` — scalp | day | swing
- `broker.pipSize` — 0.01 for HFM 2-digit gold
- `broker.priceOffset` — OANDA vs HFM quote difference

## Architecture

See [SHAOLIN.md](./SHAOLIN.md).

Meridian (`../meridian`) is the reference harness — not modified.
