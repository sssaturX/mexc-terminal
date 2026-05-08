# MEXC Terminal Bot

Console TypeScript/Node.js bot for MEXC Futures. It uses the unofficial `mexc-futures-sdk`, so dry-run mode, risk limits and verbose logging are first-class parts of the project.

> Warning: the SDK uses a browser session WEB token and reverse-engineered endpoints. Live trading can break after MEXC changes the website, expires a token, rate-limits requests, or rejects an order. Default mode is always `dry-run=true`.

## Install

```bash
npm install
npm run dev
```

Build and run compiled output:

```bash
npm run build
npm start
```

Run tests:

```bash
npm test
```

## WEB Token

Create `.env` from `.env.example` if you want defaults:

```bash
MEXC_WEB_AUTH_TOKEN=your_browser_web_token
MEXC_SYMBOL=BTC_USDT
MEXC_DRY_RUN=true
```

Tokens are never hardcoded in source code. `.env`, `config/settings.json` and `logs/` are ignored by git.

## Dry-Run Example

```bash
npm run dev
```

Choose:

- `dry-run=true`
- symbol like `BTC_USDT`
- margin preset or custom margin, leverage, TP/SL, cooldown and limits
- one of the available strategies

Dry-run logs market orders but does not send them to MEXC.

TP/SL can be entered in the most comfortable unit:

- target profit/loss in USDT
- ROE on margin %
- raw price move %

The bot prints a startup settings card with the converted notional, TP and SL values before trading starts.

## Saved Settings

After manual setup the bot asks whether to save settings to:

```text
config/settings.json
```

On the next launch it can load this file and skip most questions. The WEB token is saved there if you confirm saving, but the strategy and strategy params are not saved. You choose the strategy on every launch.

You can also keep the token in `.env` instead:

```bash
MEXC_WEB_AUTH_TOKEN=your_browser_web_token
```

Example profile:

```bash
config/settings.example.json
```

`config/settings.json` is ignored by git.

The symbol selector keeps a short `symbolHistory` in `config/settings.json`, so frequently used pairs appear first. You can also choose from popular pairs or type a custom symbol like `TONCOIN_USDT`.

## Live Example

Live trading requires two confirmations:

1. Answer `dry-run=false`.
2. Type exactly `YES LIVE`.

The bot then sends market orders through `client.submitOrder()`:

- `side=1` open long
- `side=2` close short
- `side=3` open short
- `side=4` close long
- `type=5` market
- `openType=1` isolated margin

## Strategies

- Random Coinflip Scalper
- Micro Impulse Scalper
- Breakout Strategy
- Fake Breakout Fade
- Range Ping-Pong
- Moving Average Crossover
- RSI Reversal
- Bollinger Bands Reversal
- Volume Spike Strategy
- Liquidity Sweep Strategy
- Order Book Imbalance Scalper
- Trend Pullback
- Trailing Breakout
- Chasing Take Profit Scalper
- Manual Console Strategy

Manual mode hotkeys:

- `L` open long
- `S` open short
- `C` close active position
- `Q` stop bot

These hotkeys are global: they work while any strategy is running, not only in `Manual Console Strategy`. Manual opens still use dry-run/live order handling and the active-position guard, but they intentionally bypass max trades, max consecutive losses, daily loss and cooldown limits.

Manual `L/S` entries use a separate stop-loss setting: `Manual hotkey stop loss ROE %`. For example, `1%` manual SL at `100x` means about `0.01%` price movement against the position, so the manual stop is not confused with a raw `1%` price stop near liquidation.

Live entries send `stopLossPrice` and `takeProfitPrice` directly in the MEXC `submitOrder()` payload. Local polling is only a fallback/sync layer; this avoids waiting for the next REST tick before protection exists on the exchange.

## Risk Controls

Implemented:

- one active position at a time
- max trades per session
- max consecutive losses
- max daily loss
- cooldown after close
- emergency close on Ctrl+C
- dry-run without real orders
- rough stop-loss vs liquidation guard
- high leverage warning for `>= 50x`

High leverage is dangerous. With 50x-100x leverage, a tiny price move can liquidate or make SL execution worse than expected, especially during volatility, rate limits, reconnects or SDK failures.

## Logs

Logs go to console and `logs/trading.log`.
Console output uses colors and compact cards for entries and exits. The log file is saved without ANSI color codes.

Example:

```text
[INFO] Price BTC_USDT: 65000.5 UP
[INFO] Signal BUY from MicroImpulseScalper: Impulse up 0.090% in 10000ms
[INFO] Opening LONG BTC_USDT margin=10 leverage=100 volume=0.015
[INFO] +-----------------+
| POSITION OPENED |
+-----------------+
| Side        : LONG     |
| Entry       : 65000.5  |
| Volume      : 0.015    |
| Stop loss   : 64994    |
| Take profit : 65013    |
+-----------------+
[INFO] Trailing TP activated
[INFO] Closing LONG reason=TAKE_PROFIT price=65015 pnl=+2.3100 USDT
[ERROR] SDK error: rate limit
```
