# AGENT.md — Polymarket Terminal

Developer and AI agent reference for understanding, extending, and maintaining this project.

---

## Project Overview

**Polymarket Terminal** is a Node.js (ESM) automated trading terminal for [Polymarket](https://polymarket.com). It provides three independent bots:

| Bot | Entry Point | Command | Purpose |
|---|---|---|---|
| Copy Trade | `src/index.js` | `npm start` | Mirror trades from a target trader wallet |
| Market Maker v1 | `src/mm.js` | `npm run mm` | Provide liquidity via splitPosition on 5m/15m markets |
| Market Maker v2 | `src/maker.js` | `npm run maker` | Buy low, sell high — pure orderbook maker (no splitPosition) |
| Orderbook Sniper | `src/sniper.js` | `npm run sniper` | Place low-price GTC orders to catch panic dumps |

---

## Setting Up the Project

### 1. Prerequisites

- **Node.js v18+** (project uses `"type": "module"` — native ESM, no Babel/transpilation)
- **npm** (comes with Node.js)
- A Polygon EOA wallet with:
  - A small MATIC balance (for gas)
  - USDC.e deposited via Polymarket's proxy wallet

### 2. Install Dependencies

```bash
npm install
```

Key packages:

| Package | Version | Role |
|---|---|---|
| `@polymarket/clob-client` | ^4.7.3 | Official Polymarket CLOB SDK (wraps ethers v5) |
| `ethers` | ^5.x | Wallet signing, contract calls (pinned to v5 — do not upgrade to v6) |
| `dotenv` | ^16.x | `.env` loading |
| `blessed` | ^0.1.81 | Terminal dashboard UI |
| `ws` | ^8.x | WebSocket client for real-time trade feed |
| `nodemon` | ^3.x (dev) | Auto-reload during development |

### 3. Environment Configuration

```bash
cp .env.example .env
```

Edit `.env` and fill in all required fields. Refer to `.env.example` for detailed comments on each variable. The minimum required fields for the copy trade bot are:

```
PRIVATE_KEY=0x...
PROXY_WALLET_ADDRESS=0x...
TRADER_ADDRESS=0x...
```

### 4. Run in Simulation Mode First

```bash
# Copy trade simulation
DRY_RUN=true npm start

# Market maker simulation
npm run mm-sim

# Sniper simulation
npm run sniper-sim
```

### 5. Run Live

```bash
# Set DRY_RUN=false in .env, then:
npm start        # copy trade
npm run mm       # market maker
npm run sniper   # sniper
```

---

## Architecture

### Module System

All files use **ES Modules** (`import`/`export`). Do not use `require()`.

### Configuration (`src/config/index.js`)

- Loads all settings from `.env` via `dotenv`
- Parses and validates required fields per bot type
- Exports three validator functions:
  - `validateCopyTradeConfig()` — for `src/index.js`
  - `validateMMConfig()` — for `src/mm.js` and `src/sniper.js`
  - `validateMakerConfig()` — for `src/maker.js`
- Key exported fields: `privateKey`, `proxyWallet`, `traderAddress`, `dryRun`, `mmTradeSize`, etc.

### Client (`src/services/client.js`)

- `initClient()` — Initializes `ClobClient` from `@polymarket/clob-client`
  - Uses **signature type 2** (`POLY_PROXY`) — EOA signs on behalf of the proxy wallet
  - Auto-derives API credentials if not provided in `.env`
- `getClient()` / `getSigner()` — Singleton getters (call `initClient()` first)
- `getPolygonProvider()` — Returns a `JsonRpcProvider` for Polygon mainnet
- `getUsdcBalance()` — Reads USDC.e balance from the ERC-20 contract

### Watcher (`src/services/watcher.js`)

- **Poll-based** fallback: queries `data-api.polymarket.com/activity?user={address}`
- Deduplicates processed trade IDs via `data/processed_trades.json` (max 500 entries)
- `fetchMarketInfo(conditionId)` — Fetches market metadata from Gamma API
- `fetchMarketByTokenId(tokenId)` — Reverse-lookup market by token

### WebSocket Watcher (`src/services/wsWatcher.js`)

- Connects to Polymarket RTDS: `wss://ws-live-data.polymarket.com`
- Subscribes to the `user` channel for the target trader address
- Filters for `trade` type events matching `MATCHED` status
- Auto-reconnects with exponential backoff on disconnect

### Executor (`src/services/executor.js`)

- `calculateTradeSize(traderFillSize)` — Computes our order size:
  - `percentage` mode: `SIZE_PERCENT% of MAX_POSITION_SIZE`
  - `balance` mode: `SIZE_PERCENT% of current USDC.e balance`
- `executeBuy(tokenId, size, price)` — FOK market buy with retry loop
- `executeSell(tokenId, shares, mode, price)` — Market or limit sell
- `getMarketOptions(tokenId)` — Fetches tick size and `negRisk` flag from CLOB

### Position Manager (`src/services/position.js`)

- CRUD operations on `data/positions.json`
- Key structure: `{ [conditionId]: { tokenId, shares, avgBuyPrice, autoSellOrderId, ... } }`
- Enforces **one position per conditionId** — prevents double entry

### Auto Sell (`src/services/autoSell.js`)

- Called after a buy fills successfully
- Places a GTC limit SELL at `avgBuyPrice × (1 + AUTO_SELL_PROFIT_PERCENT / 100)`
- Price is rounded to the market's valid tick size and clamped to $0.01–$0.99

### Redeemer (`src/services/redeemer.js`)

- `checkMarketResolution(conditionId)` — Queries Gamma API for resolved status
- `checkOnChainPayout(conditionId)` — Reads `payoutDenominator` and `payoutNumerators` from CTF contract
- `redeemPosition(conditionId, tokenId, shares)` — Calls `redeemPositions` on CTF via CLOB client
- `simulateRedeem(...)` — Tracks wins/losses in `data/sim_stats.json` during dry-run

### CTF Contract Helpers (`src/services/ctf.js`)

Used exclusively by the Market Maker bot. Interacts with the Gnosis Safe proxy wallet.

- `splitPosition(conditionId, amountUsdc)` — Deposits USDC → mints equal YES+NO tokens at $0.50 each
- `mergePositions(conditionId, sharesPerSide)` — Burns equal YES+NO → recovers USDC (no-slippage cut-loss)
- `cleanupOpenPositions(clobClient)` — On startup, cancels open orders and merges any leftover positions
- `redeemMMPositions()` — Periodic redeemer for resolved markets held by the proxy wallet
- `execSafeCall(to, data, description)` — Queued Safe transaction executor (serialized to avoid nonce collisions)

### Market Maker Detector (`src/services/mmDetector.js`)

- Deterministic slot-based lookup using slug format: `{asset}-updown-{duration}-{timestamp}`
- Polls Gamma API every `MM_POLL_INTERVAL` seconds
- Targets the **next upcoming** slot (skips the currently active one)
- Tracks seen market IDs to avoid re-entry

### Market Maker Executor (`src/services/mmExecutor.js`)

- `executeMMStrategy(market)` — Full flow: split → place limit sells → monitor → cut-loss/redeem
- `monitorAndManage(...)` — Watches for fill events; triggers cut-loss when `MM_CUT_LOSS_TIME` is reached
- `cutLoss(...)` — Cancels remaining orders; merges back or market-sells residual tokens
- `attemptRecoveryBuy(...)` — Optional directional bet post cut-loss (controlled by `MM_RECOVERY_BUY`)

### Maker Detector (`src/services/makerDetector.js`)

- Slot-based detection for the Maker v2 bot (buy low, sell high)
- Supports **multiple durations** simultaneously (e.g. `MAKER_DURATION=5m,15m`)
- Polls all `asset × duration` combinations in parallel
- Each detected market includes a `duration` field for concurrent queue management
- Same slug format as other bots: `{asset}-updown-{duration}-{timestamp}`

### Maker Executor (`src/services/makerExecutor.js`)

- `executeMakerStrategy(market)` — Full flow: place limit BUY on UP+DOWN → monitor fills → place limit SELL → monitor sells
- **CL at 10s before close:** Cancels unfilled buy orders, places sells for any filled positions (retry 3x for settlement delays)
- **Sell phase:** Sell orders stay live until market close (no early cancellation)
- **Multi-market concurrent:** Each position keyed by `conditionId`, queue keyed by `${asset}-${duration}`
- Simulation mode with full P&L tracking (win/loss/skip stats)
- `placeLimitSellWithRetry()` — Retries sell placement 3x with increasing delay for on-chain settlement

### Sniper Detector (`src/services/sniperDetector.js`)

- Scans for 5-minute markets for a configurable list of assets
- Checks both current and next upcoming slots
- Skips markets with fewer than 30 seconds remaining

### Sniper Executor (`src/services/sniperExecutor.js`)

- `executeSnipe(market)` — Places two GTC BUY orders (one YES, one NO) at `SNIPER_PRICE`
- Tracks placed orders in memory for display in the terminal UI
- Total cost per market = `SNIPER_PRICE × SNIPER_SHARES × 2`

### Dashboard UI (`src/ui/dashboard.js`)

- Built with `blessed` — two-panel terminal layout
- Left panel: event log (color-coded, auto-scrolling)
- Right panel: live positions, balance, and bot status
- Handles Ctrl+C and `q` for graceful shutdown

### Logger (`src/utils/logger.js`)

- `logger.info()`, `logger.success()`, `logger.warn()`, `logger.error()`
- `logger.trade()`, `logger.watch()`, `logger.money()`
- Outputs to console (with ANSI colors) or blessed dashboard markup

### State (`src/utils/state.js`)

- `readState(filename)` — Read a JSON file from `data/`; returns `{}` if missing
- `writeState(filename, data)` — Atomic write (temp file + rename) to prevent partial writes

---

## Key API Endpoints

| API | Base URL | Auth | Purpose |
|---|---|---|---|
| Gamma API | `https://gamma-api.polymarket.com` | None | Market metadata, resolution status |
| Data API | `https://data-api.polymarket.com` | None | Trader activity, wallet positions |
| CLOB API | `https://clob.polymarket.com` | L2 ECDSA | Place, cancel, and query orders |
| RTDS WebSocket | `wss://ws-live-data.polymarket.com` | None | Real-time trade event stream |
| Polygon RPC | Configurable via `POLYGON_RPC_URL` | None | On-chain reads and Safe tx submission |

---

## Contract Addresses (Polygon Mainnet)

| Contract | Address |
|---|---|
| CTF (ConditionalTokens) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| Neg Risk CTF | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |

---

## State Files (`data/`)

> This directory is **gitignored** and created at runtime.

| File | Structure | Purpose |
|---|---|---|
| `positions.json` | `{ [conditionId]: { tokenId, shares, avgBuyPrice, autoSellOrderId, ... } }` | Active copy-trade positions |
| `processed_trades.json` | `{ tradeIds: string[] }` | Deduplication (max 500 entries, FIFO eviction) |
| `sim_stats.json` | `{ buys, wins, losses, totalPnl, ... }` | Simulation performance statistics |

---

## Order Types

| Type | Code | Used for |
|---|---|---|
| Fill-or-Kill | `FOK` | Market buys and sells (copy trade) |
| Good-Til-Cancelled | `GTC` | Auto-sell limits, MM limit sells, sniper orders |

---

## Tick Sizes

Valid limit order prices must align to one of these tick sizes: `0.1`, `0.01`, `0.001`, `0.0001`. The tick size for each market is returned by the CLOB API and respected in `executor.js` and `autoSell.js`.

---

## Known Limitations

- **No partial fill tracking** — market buy retries treat each attempt as all-or-nothing (FOK)
- **Redeem requires MATIC** — on-chain CTF redemption costs gas; keep EOA funded
- **MM bot requires a Gnosis Safe proxy wallet** — EOA-only wallets are not supported for the MM bot
- **Data API response shape varies** — the code handles multiple known field name conventions but new API changes may require updates

---

## Development Tips

- Use `npm run dev`, `npm run mm-dev`, or `npm run sniper-dev` for auto-reload during development
- `nodemon` is configured to ignore `data/*.json` to avoid unnecessary restarts on state updates
- All `console.log` usage is replaced by `logger.*` — keep it consistent
- When adding a new service, export functions individually and import by name; avoid default-export classes
- The Safe transaction queue (`_txQueue` in `ctf.js`) is critical — never bypass it or nonce collisions will cause transaction failures
