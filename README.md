# Polymarket Terminal

> An automated trading terminal for [Polymarket](https://polymarket.com) — copy trades, provide liquidity, and snipe low-priced orderbook fills, all from your command line.

**Created by [@direkturcrypto](https://twitter.com/direkturcrypto)**

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Running on VPS with PM2](#running-on-vps-with-pm2)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Important Warnings](#important-warnings)
- [License](#license)

---

## Features

### Copy Trade Bot
- **Watch Trader** — Monitor any Polymarket wallet address in real time via WebSocket
- **Copy Buy** — Automatically mirror buy orders with configurable position sizing
- **Copy Sell** — Automatically mirror sell orders (market or limit)
- **Auto Sell** — Place a GTC limit sell at a target profit % immediately after a buy fills
- **Auto Redeem** — Periodically check and redeem winning positions on-chain
- **Market Expiry Guard** — Skip buys if market closes within `MIN_MARKET_TIME_LEFT` seconds
- **GTC Fallback** — Falls back to a GTC limit order when copying "next market" trades with no liquidity
- **Per-Market Queue** — Concurrent events for the same market are serialized to prevent duplicate buys
- **Dry Run Mode** — Simulate the full flow without placing real orders

### Market Maker v1 Bot (Split Position)
- **Automated Liquidity** — Splits USDC into YES+NO tokens and places limit sells on both sides at $0.50 entry
- **Cut-Loss Protection** — Merges unsold tokens back to USDC before market close
- **Recovery Buy** — Optional directional bet after a cut-loss triggers
- **Multi-Asset** — Supports BTC, ETH, SOL, and any 5m/15m Polymarket market
- **Simulation Mode** — Full dry-run with P&L tracking

### Market Maker v2 Bot (Buy Low, Sell High)
- **Pure Orderbook** — Places limit BUY on both UP+DOWN at low price (e.g. 2c), sells at higher price (e.g. 3c) when filled. No splitPosition needed
- **Cut-Loss at 10s** — Cancels unfilled buy orders 10 seconds before market close; sells positions as much as possible
- **Sell Retry 3x** — Retries sell placement with delay for on-chain token settlement
- **Multi-Asset** — Supports BTC, ETH, SOL, XRP simultaneously
- **Multi-Duration** — Run 5m and 15m markets concurrently (`MAKER_DURATION=5m,15m`)
- **Concurrent Markets** — Each asset+duration combination runs independently (e.g. BTC/5m and BTC/15m don't block each other)
- **Simulation Mode** — Full dry-run with win/loss/skip tracking and P&L stats
- **Proxy Support** — All API calls go through `PROXY_URL` if configured

### Orderbook Sniper Bot
- **3-Tier Strategy** — Places GTC BUY orders at 3c, 2c, and 1c with weighted sizing (20%/30%/50%)
- **Multi-Asset** — Targets ETH, SOL, XRP, and more simultaneously
- **Simulation Mode** — Preview orders without spending funds
- **Session Scheduling** — Per-asset time windows (UTC+8) for selective trading

---

## Prerequisites

| Requirement | Details |
|---|---|
| Node.js | v18 or higher (ESM support required) |
| Polygon Wallet | An EOA wallet with a private key |
| Polymarket Proxy Wallet | Your proxy wallet address (visible on your Polymarket profile → Deposit) |
| USDC.e on Polygon | Deposited via Polymarket's deposit flow |
| MATIC on Polygon | A small amount for gas fees (redeem & on-chain operations) |
| PM2 *(optional)* | For running on a VPS: `npm install -g pm2` |

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/direkturcrypto/polymarket-terminal.git
cd polymarket-terminal

# 2. Install dependencies
npm install

# 3. Copy the environment template
cp .env.example .env

# 4. Fill in your credentials
nano .env
```

---

## Configuration

All settings are controlled via the `.env` file. **Never commit your `.env` file** — it is already listed in `.gitignore`.

### Wallet Setup

| Variable | Description | Required |
|---|---|---|
| `PRIVATE_KEY` | Your EOA private key (signing only, does not hold USDC) | Yes |
| `PROXY_WALLET_ADDRESS` | Your Polymarket proxy wallet address | Yes |
| `POLYGON_RPC_URL` | Polygon JSON-RPC endpoint | Yes |

> **How to find your Proxy Wallet:** Log in to polymarket.com → click your profile → Deposit → copy the wallet address shown.

### Polymarket API Credentials (Optional)

Leave these blank to have the client auto-derive credentials from your private key.

| Variable | Description |
|---|---|
| `CLOB_API_KEY` | CLOB API key |
| `CLOB_API_SECRET` | CLOB API secret |
| `CLOB_API_PASSPHRASE` | CLOB API passphrase |

### Copy Trade Bot Settings

| Variable | Description | Default |
|---|---|---|
| `TRADER_ADDRESS` | Proxy wallet address of the trader to copy | (required) |
| `SIZE_MODE` | `percentage` (of `MAX_POSITION_SIZE`) or `balance` (of your USDC balance) | `balance` |
| `SIZE_PERCENT` | Percentage to use per trade | `10` |
| `MIN_TRADE_SIZE` | Minimum trade size in USDC (skip if below) | `1` |
| `MAX_POSITION_SIZE` | Maximum USDC per market position | `10` |
| `AUTO_SELL_ENABLED` | Place a limit sell after each buy fills | `true` |
| `AUTO_SELL_PROFIT_PERCENT` | Target profit % for the auto-sell limit order | `10` |
| `SELL_MODE` | `market` or `limit` when copying a sell | `market` |
| `REDEEM_INTERVAL` | Seconds between redemption checks | `60` |
| `MIN_MARKET_TIME_LEFT` | Skip buy if market closes within this many seconds | `300` |
| `GTC_FALLBACK_TIMEOUT` | Seconds to wait for GTC fill when FAK finds no liquidity | `60` |
| `DRY_RUN` | Simulate without placing real orders | `true` |

### Market Maker Bot Settings

| Variable | Description | Default |
|---|---|---|
| `MM_ASSETS` | Comma-separated assets to market-make (e.g. `btc,eth`) | `btc` |
| `MM_DURATION` | Market duration: `5m` or `15m` | `5m` |
| `MM_TRADE_SIZE` | USDC per side (total exposure = 2×) | `5` |
| `MM_SELL_PRICE` | Limit sell price target (e.g. `0.60`) | `0.60` |
| `MM_CUT_LOSS_TIME` | Seconds before close to trigger cut-loss | `60` |
| `MM_MARKET_KEYWORD` | Keyword to filter market questions | `Bitcoin Up or Down` |
| `MM_ENTRY_WINDOW` | Max seconds after open to enter (0 = open only) | `45` |
| `MM_POLL_INTERVAL` | Seconds between new market polls | `10` |
| `MM_RECOVERY_BUY` | Enable recovery buy after cut-loss | `false` |
| `MM_RECOVERY_THRESHOLD` | Minimum dominant-side price to qualify for recovery | `0.70` |
| `MM_RECOVERY_SIZE` | USDC for recovery buy (0 = use `MM_TRADE_SIZE`) | `0` |

### Market Maker v2 (Maker) Settings

| Variable | Description | Default |
|---|---|---|
| `MAKER_ASSETS` | Comma-separated assets (e.g. `btc,eth,sol,xrp`) | `btc` |
| `MAKER_DURATION` | Comma-separated durations (e.g. `5m` or `5m,15m`) | `5m` |
| `MAKER_BUY_PRICE` | Limit BUY price per share (e.g. `0.02` = 2c) | `0.02` |
| `MAKER_SELL_PRICE` | Limit SELL price per share (e.g. `0.03` = 3c) | `0.03` |
| `MAKER_TRADE_SIZE` | Shares per side (e.g. `50` × $0.02 = $1.00/side) | `50` |
| `MAKER_POLL_INTERVAL` | Seconds between new market polls | `10` |
| `MAKER_MONITOR_MS` | Milliseconds between order fill checks | `2000` |

**Cut-Loss:** At 10 seconds before market close, unfilled buy orders are cancelled. Any filled positions get sell orders placed (retry 3x). Sell orders stay live until market close.

### Orderbook Sniper Settings

**3-Tier Strategy:** Places orders at 3 price levels with weighted sizing

| Variable | Description | Default |
|---|---|---|
| `SNIPER_ASSETS` | Comma-separated assets to snipe (e.g. `eth,sol,xrp`) | `eth,sol,xrp` |
| `SNIPER_TIER1_PRICE` | Highest price tier (e.g. `0.03` = 3c) | `0.03` |
| `SNIPER_TIER2_PRICE` | Mid price tier (e.g. `0.02` = 2c) | `0.02` |
| `SNIPER_TIER3_PRICE` | Lowest price tier (e.g. `0.01` = 1c) | `0.01` |
| `SNIPER_MAX_SHARES` | Max total shares per side (min 5 per tier) | `15` |

**Allocation:**
- Tier 1 (3c): 20% of max shares (min 5)
- Tier 2 (2c): 30% of max shares (min 5)
- Tier 3 (1c): 50% of max shares (min 5)

**Example with `SNIPER_MAX_SHARES=15`:**
- 3 shares @ 3c = $0.09
- 5 shares @ 2c = $0.10
- 7 shares @ 1c = $0.07
- **Total per side:** 15 shares = $0.26

---

## Usage

### Terminal UI (local)

Runs with an interactive split-panel dashboard (blessed TUI).

```bash
# Copy Trade Bot
npm start           # live trading
npm run dev         # live + auto-reload on file changes

# Market Maker Bot
npm run mm          # live trading
npm run mm-sim      # simulation (DRY_RUN=true)
npm run mm-dev      # simulation + auto-reload

# Market Maker v2 (Maker) Bot
npm run maker       # live trading
npm run maker-sim   # simulation
npm run maker-dev   # simulation + auto-reload

# Orderbook Sniper Bot
npm run sniper      # live trading
npm run sniper-sim  # simulation
npm run sniper-dev  # simulation + auto-reload
```

### Plain Log Mode (no TUI)

Writes plain timestamped text to stdout — suitable for piping, `tail -f`, or PM2.

```bash
# Copy Trade Bot
npm run bot         # live trading
npm run bot-sim     # simulation
npm run bot-dev     # simulation + auto-reload

# Market Maker v1 Bot
npm run mm-bot      # live trading
npm run mm-bot-sim  # simulation
npm run mm-bot-dev  # simulation + auto-reload

# Market Maker v2 (Maker) Bot
npm run maker-bot      # live trading
npm run maker-bot-sim  # simulation
npm run maker-bot-dev  # simulation + auto-reload
```

> **Always test with `DRY_RUN=true` (or `*-sim` scripts) first** before committing real funds.

---

## Running on VPS with PM2

Each bot has its own PM2 config file inside the `pm2/` folder.

### Install PM2

```bash
npm install -g pm2
```

### Copy Trade Bot

```bash
# Live trading
pm2 start pm2/copy.config.cjs

# Simulation
pm2 start pm2/copy.config.cjs --env sim

# View logs
pm2 logs polymarket-copy
tail -f logs/copy-out.log

# Management
pm2 restart polymarket-copy
pm2 stop polymarket-copy
pm2 delete polymarket-copy
```

### Market Maker Bot

```bash
# Live trading
pm2 start pm2/mm.config.cjs

# Simulation
pm2 start pm2/mm.config.cjs --env sim

# View logs
pm2 logs polymarket-mm
tail -f logs/mm-out.log

# Management
pm2 restart polymarket-mm
pm2 stop polymarket-mm
pm2 delete polymarket-mm
```

### Auto-start on reboot

```bash
pm2 startup        # generates a startup command — run the command it prints
pm2 save           # saves current process list
```

---

## How It Works

### Copy Trade Bot Flow

```
WebSocket (RTDS) — real-time trade events from trader
        │
        ▼
Per-market queue (prevents concurrent duplicate buys)
        │
   ┌────┴──────┐
   │           │
  BUY         SELL
   │           │
   ├─ Expiry guard (MIN_MARKET_TIME_LEFT)
   ├─ Max position cap          ├─ Cancel open orders
   ├─ FAK market buy            ├─ Reconcile on-chain balance
   │  └─ 0 fill? → GTC fallback ├─ FAK market sell / limit sell
   ├─ Place auto-sell GTC       └─ Remove position
   └─ Save position
        │
        ▼
Redeemer loop (every REDEEM_INTERVAL seconds)
  → Check on-chain payout → redeemPositions via Gnosis Safe
```

### Market Maker v1 Flow (Split Position)

```
New Market Detected
        │
        ▼
Split USDC → YES + NO tokens ($0.50 each, zero slippage)
        │
        ▼
Place limit SELL on both sides at MM_SELL_PRICE
        │
        ▼
Monitor fills every few seconds
        │
   ┌────┴────┐
   │         │
 Fill    Time < MM_CUT_LOSS_TIME
   │         │
   ▼         ▼
Collect  Cancel orders → Merge YES+NO back to USDC
 profit    (recovery buy optional)
```

### Market Maker v2 Flow (Buy Low, Sell High)

```
Detector polls all asset × duration combos (e.g. BTC/5m, ETH/15m)
        │
        ▼
Place limit BUY on UP + DOWN @ MAKER_BUY_PRICE (e.g. $0.02)
        │
        ▼
Monitor both sides concurrently
        │
   ┌────┴─────────────────┐
   │                      │
 One side fills     CL at 10s before close
   │                      │
   ▼                      ▼
Cancel other buy    Cancel unfilled buys
Place SELL @ 3c     Place SELL for any fills (retry 3x)
   │                      │
   └──────┬───────────────┘
          ▼
Monitor sells until market close
          │
     ┌────┴────┐
     │         │
  Sell fills  Market closes
     │         │
     ▼         ▼
   WIN $     Tokens resolve on-chain
```

---

## Project Structure

```
polymarket-terminal/
├── src/
│   ├── index.js               — Copy trade bot (TUI)
│   ├── bot.js                 — Copy trade bot (plain log / PM2)
│   ├── mm.js                  — Market maker v1 bot (TUI)
│   ├── mm-bot.js              — Market maker v1 bot (plain log / PM2)
│   ├── maker.js               — Market maker v2 bot (TUI)
│   ├── maker-bot.js           — Market maker v2 bot (plain log / PM2)
│   ├── sniper.js              — Orderbook sniper bot
│   │
│   ├── config/
│   │   └── index.js           — Environment variable loading & validation
│   │
│   ├── services/
│   │   ├── client.js          — CLOB client initialization & USDC balance
│   │   ├── watcher.js         — Poll-based trader activity detection
│   │   ├── wsWatcher.js       — WebSocket real-time trade listener
│   │   ├── executor.js        — Buy & sell order execution logic
│   │   ├── position.js        — Position state management (CRUD)
│   │   ├── autoSell.js        — Auto limit-sell placement
│   │   ├── redeemer.js        — Market resolution check & CTF redemption
│   │   ├── ctf.js             — On-chain CTF contract interactions
│   │   ├── mmDetector.js      — Market detection for MM v1
│   │   ├── mmExecutor.js      — MM v1 strategy execution
│   │   ├── makerDetector.js   — Market detection for Maker v2 (multi-duration)
│   │   ├── makerExecutor.js   — Maker v2 strategy execution
│   │   ├── makerWs.js         — Orderbook WebSocket for Maker v2
│   │   ├── sniperDetector.js  — Market detection for sniper
│   │   └── sniperExecutor.js  — Orderbook sniper order placement
│   │
│   ├── ui/
│   │   └── dashboard.js       — Terminal UI (blessed)
│   │
│   └── utils/
│       ├── logger.js          — Timestamped logging (TUI + plain modes)
│       ├── state.js           — Atomic JSON state file management
│       └── simStats.js        — Simulation P&L statistics
│
├── pm2/
│   ├── copy.config.cjs        — PM2 config for copy trade bot
│   └── mm.config.cjs          — PM2 config for market maker bot
│
├── data/                      — Runtime state files (gitignored)
├── logs/                      — PM2 log files (gitignored)
├── .env.example               — Configuration template
├── .gitignore
└── package.json
```

---

## Important Warnings

- **Never commit your `.env` file.** Your private key must remain secret. The `.gitignore` already excludes it.
- **Always start with `DRY_RUN=true`** (or a `*-sim` script) to verify the bot behaves as expected before using real funds.
- **Use a small `SIZE_PERCENT`** for initial live runs to limit exposure.
- **Keep MATIC in your EOA wallet** for gas fees (redeem operations and on-chain CTF calls).
- **This software is provided as-is, with no guarantees.** Prediction market trading carries significant financial risk. You are solely responsible for any losses.

---

## Credits

Built and maintained by **[@direkturcrypto](https://twitter.com/direkturcrypto)**.

---

## License

ISC License — see [LICENSE](LICENSE) for details.
