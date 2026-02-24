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
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Important Warnings](#important-warnings)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### Copy Trade Bot (`npm start`)
- **Watch Trader** — Monitor any Polymarket wallet address in real time via WebSocket
- **Copy Buy** — Automatically mirror buy orders with configurable position sizing
- **Copy Sell** — Automatically mirror sell orders (market or limit)
- **Auto Sell** — Place a GTC limit sell at a target profit % immediately after a buy fills
- **Auto Redeem** — Periodically check and redeem winning positions on-chain
- **Deduplication** — Each market is entered at most once; no double buys
- **Balance Guard** — Checks USDC.e balance before every order
- **Dry Run Mode** — Simulate the full flow without placing real orders

### Market Maker Bot (`npm run mm`)
- **Automated Liquidity** — Splits USDC into YES+NO tokens and places limit sells on both sides at $0.50 entry
- **Cut-Loss Protection** — Merges unsold tokens back to USDC before market close
- **Recovery Buy** — Optional directional bet after a cut-loss triggers
- **Multi-Asset** — Supports BTC, ETH, SOL, and any 5m/15m Polymarket market
- **Simulation Mode** — Full dry-run with P&L tracking (`npm run mm-sim`)

### Orderbook Sniper Bot (`npm run sniper`)
- **Low-Price Orders** — Places tiny GTC BUY orders at a configurable price (e.g. $0.01) on both sides
- **Multi-Asset** — Targets ETH, SOL, XRP, and more simultaneously
- **Simulation Mode** — Preview orders without spending funds (`npm run sniper-sim`)

---

## Prerequisites

| Requirement | Details |
|---|---|
| Node.js | v18 or higher (ESM support required) |
| Windows | See [WINDOWS.md](WINDOWS.md) for setup and known issues. |
| Polygon Wallet | An EOA wallet with a private key |
| Polymarket Proxy Wallet | Your proxy wallet address (visible on your Polymarket profile → Deposit) |
| USDC.e on Polygon | Deposited via Polymarket's deposit flow |
| MATIC on Polygon | A small amount for gas fees (redeem & on-chain operations) |

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/direkturcrypto/polymarket-terminal.git
cd polymarket-terminal

# 2. Install dependencies
npm install

# 3. Copy the environment template
cp .env.example .env   # Windows: copy .env.example .env

# 4. Fill in your credentials (see Configuration section below)
nano .env   # or use your preferred editor
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

### Orderbook Sniper Settings

| Variable | Description | Default |
|---|---|---|
| `SNIPER_ASSETS` | Comma-separated assets to snipe (e.g. `eth,sol,xrp`) | `eth,sol,xrp` |
| `SNIPER_PRICE` | Buy price per share (e.g. `0.01` = $0.01) | `0.01` |
| `SNIPER_SHARES` | Shares per side (minimum 5 per Polymarket rules) | `5` |

---

## Usage

```bash
# ── Copy Trade Bot ─────────────────────────────────
npm start           # Production mode
npm run dev         # Development mode (auto-reload on file changes)

# ── Market Maker Bot ───────────────────────────────
npm run mm          # Live trading (DRY_RUN=false)
npm run mm-sim      # Simulation mode (DRY_RUN=true)
npm run mm-dev      # Simulation + auto-reload

# ── Orderbook Sniper Bot ───────────────────────────
npm run sniper      # Live trading (DRY_RUN=false)
npm run sniper-sim  # Simulation mode (DRY_RUN=true)
npm run sniper-dev  # Simulation + auto-reload
```

> **Always test with `DRY_RUN=true` first** before committing real funds.

---

## How It Works

### Copy Trade Bot Flow

```
┌──────────────────────────────────────────────────────────┐
│                    WATCHER LOOP                          │
│  WebSocket (RTDS) — real-time trade events from trader   │
│  Fallback: poll Data API every N seconds                 │
├───────────────────────┬──────────────────────────────────┤
│      NEW BUY          │          NEW SELL                │
│                       │                                  │
│  ✓ Check position     │  ✓ Check position exists         │
│  ✓ Check USDC balance │  ✓ Cancel existing auto-sell     │
│  ✓ Market buy (FOK)   │  ✓ Market / limit sell           │
│  ✓ Retry on failure   │  ✓ Retry on failure              │
│  ✓ Place auto-sell    │  ✓ Remove position from state    │
│  ✓ Save position      │                                  │
├───────────────────────┴──────────────────────────────────┤
│                   REDEEMER LOOP                          │
│  Periodically checks resolved markets                    │
│  → Redeems winning positions via CTF contract on-chain   │
└──────────────────────────────────────────────────────────┘
```

### Market Maker Flow

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

---

## Project Structure

```
polymarket-terminal/
├── src/
│   ├── index.js               — Copy trade bot entry point
│   ├── mm.js                  — Market maker bot entry point
│   ├── sniper.js              — Orderbook sniper bot entry point
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
│   │   ├── ctf.js             — On-chain CTF contract interactions (MM bot)
│   │   ├── mmDetector.js      — Market detection for market maker
│   │   ├── mmExecutor.js      — Market maker strategy execution
│   │   ├── sniperDetector.js  — Market detection for sniper
│   │   └── sniperExecutor.js  — Orderbook sniper order placement
│   │
│   ├── ui/
│   │   └── dashboard.js       — Terminal UI (blessed)
│   │
│   └── utils/
│       ├── logger.js          — Color-coded, timestamped logging
│       ├── state.js           — Atomic JSON state file management
│       └── simStats.js        — Simulation P&L statistics
│
├── data/                      — Runtime state files (gitignored)
├── .env.example               — Configuration template
├── .gitignore
└── package.json
```

---

## Important Warnings

- **Never commit your `.env` file.** Your private key must remain secret. The `.gitignore` already excludes it.
- **Always start with `DRY_RUN=true`** to verify the bot behaves as expected before using real funds.
- **Use a small `SIZE_PERCENT`** for initial live runs to limit exposure.
- **Keep MATIC in your EOA wallet** for gas fees (redeem operations and on-chain CTF calls).
- **This software is provided as-is, with no guarantees.** Prediction market trading carries significant financial risk. You are solely responsible for any losses.

---

## Contributing

Contributions are welcome! To get started:

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes and ensure the code is clean and well-documented
4. Open a pull request describing what you changed and why

Please keep pull requests focused and avoid mixing unrelated changes.

---

## Credits

Built and maintained by **[@direkturcrypto](https://twitter.com/direkturcrypto)**.

---

## License

ISC License — see [LICENSE](LICENSE) for details.
