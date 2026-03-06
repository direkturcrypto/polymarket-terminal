/**
 * maker.js
 * TUI version — Buy Low, Sell High Market Maker (blessed dashboard).
 *
 * Strategy: Place limit BUY on UP+DOWN at low price, sell at target when filled.
 * No splitPosition — pure orderbook-based market making.
 *
 * Run with: npm run maker       (live)
 *           npm run maker-sim   (simulation with real orderbook via WebSocket)
 */

import './utils/proxy-patch.cjs';

import { validateMakerConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getUsdcBalance } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive } from './ui/dashboard.js';
import { startMakerDetector, stopMakerDetector } from './services/makerDetector.js';
import { executeMakerStrategy, getActiveMakerPositions } from './services/makerExecutor.js';
import { OrderbookWs } from './services/makerWs.js';

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMakerConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
}

// ── Init TUI ──────────────────────────────────────────────────────────────────

initDashboard();
logger.setOutput(appendLog);

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── WebSocket orderbook (for sim visualization) ──────────────────────────────

const orderbookWs = new OrderbookWs();
let activeWsTokens = { up: null, down: null };

// ── Status panel refresh ──────────────────────────────────────────────────────

async function buildStatusContent() {
    const lines = [];

    // Balance
    let balance = '?';
    if (!config.dryRun) {
        try { balance = (await getUsdcBalance()).toFixed(2); } catch { /* ignore */ }
    } else {
        balance = '{yellow-fg}SIM{/yellow-fg}';
    }
    lines.push('{bold}BALANCE{/bold}');
    lines.push(`  USDC.e: {green-fg}$${balance}{/green-fg}`);
    lines.push('');

    // Mode
    lines.push('{bold}MODE{/bold}');
    lines.push(`  ${config.dryRun ? '{yellow-fg}SIMULATION{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    lines.push('');

    // Maker Config
    lines.push('{bold}MAKER CONFIG{/bold}');
    lines.push(`  Assets   : ${config.makerAssets.join(', ').toUpperCase()}`);
    lines.push(`  Duration : ${config.makerDuration}`);
    lines.push(`  Buy @    : $${config.makerBuyPrice} per share`);
    lines.push(`  Sell @   : $${config.makerSellPrice} per share`);
    lines.push(`  Size     : ${config.makerTradeSize} shares/side`);
    lines.push(`  Cost/side: $${(config.makerTradeSize * config.makerBuyPrice).toFixed(2)}`);
    lines.push(`  Profit   : $${((config.makerSellPrice - config.makerBuyPrice) * config.makerTradeSize).toFixed(2)}/cycle`);
    lines.push(`  No CL    : hold to resolution if sell unfilled`);
    lines.push('');

    // Active positions
    const positions = getActiveMakerPositions();
    lines.push(`{bold}ACTIVE POSITIONS (${positions.length}){/bold}`);

    if (positions.length === 0) {
        lines.push('  {gray-fg}Waiting for market...{/gray-fg}');
    } else {
        for (const pos of positions) {
            const assetTag = pos.asset ? `[${pos.asset.toUpperCase()}] ` : '';
            const label = pos.question.substring(0, 32);
            const msLeft = new Date(pos.endTime).getTime() - Date.now();
            const secsLeft = Math.max(0, Math.round(msLeft / 1000));
            const timeStr = secsLeft > 60
                ? `${Math.floor(secsLeft / 60)}m${secsLeft % 60}s`
                : `{red-fg}${secsLeft}s{/red-fg}`;

            lines.push(`  {cyan-fg}${assetTag}${label}{/cyan-fg}`);
            lines.push(`  Status : ${pos.status} | Time left: ${timeStr}`);

            // UP side
            const upFill = pos.up.buyFilled > 0
                ? `{green-fg}BOUGHT ${pos.up.buyFilled.toFixed(1)}sh{/green-fg}`
                : '{gray-fg}waiting...{/gray-fg}';
            const upSold = pos.up.totalSellFilled > 0
                ? ` → {green-fg}SOLD ${pos.up.totalSellFilled.toFixed(1)}sh{/green-fg}`
                : pos.up.sellOrders.length > 0 ? ' → {yellow-fg}selling...{/yellow-fg}' : '';
            lines.push(`  UP   ${upFill}${upSold}`);

            // DOWN side
            const downFill = pos.down.buyFilled > 0
                ? `{green-fg}BOUGHT ${pos.down.buyFilled.toFixed(1)}sh{/green-fg}`
                : '{gray-fg}waiting...{/gray-fg}';
            const downSold = pos.down.totalSellFilled > 0
                ? ` → {green-fg}SOLD ${pos.down.totalSellFilled.toFixed(1)}sh{/green-fg}`
                : pos.down.sellOrders.length > 0 ? ' → {yellow-fg}selling...{/yellow-fg}' : '';
            lines.push(`  DOWN ${downFill}${downSold}`);

            // P&L
            const pnl = pos.totalRevenue - pos.totalCost;
            const pnlColor = pnl >= 0 ? 'green' : 'red';
            lines.push(`  P&L: {${pnlColor}-fg}$${pnl.toFixed(4)}{/${pnlColor}-fg}`);
            lines.push('');
        }
    }

    // Orderbook display (always show when tokens are active)
    if (activeWsTokens.up) {
        lines.push('{bold}LIVE ORDERBOOK{/bold}');

        for (const [label, tokenId] of [['UP', activeWsTokens.up], ['DOWN', activeWsTokens.down]]) {
            if (!tokenId) continue;
            const book = orderbookWs.getBook(tokenId);
            const bestBid = orderbookWs.getBestBid(tokenId);
            const bestAsk = orderbookWs.getBestAsk(tokenId);
            const mid = bestBid && bestAsk ? ((bestBid + bestAsk) / 2) : 0;

            lines.push(`  {cyan-fg}${label}{/cyan-fg} mid: $${mid.toFixed(3)} | bid: $${bestBid.toFixed(2)} ask: $${bestAsk.toFixed(2)}`);

            // Top 5 asks (reversed so lowest is closest to spread)
            const topAsks = book.asks.slice(0, 5).reverse();
            for (const ask of topAsks) {
                const bar = '█'.repeat(Math.min(10, Math.round(ask.size / 100)));
                lines.push(`    {red-fg}$${ask.price.toFixed(2)} ${ask.size.toFixed(0).padStart(7)} ${bar}{/red-fg}`);
            }

            // Spread line
            if (bestBid && bestAsk) {
                const spread = bestAsk - bestBid;
                lines.push(`    {yellow-fg}── spread $${spread.toFixed(2)} ──{/yellow-fg}`);
            }

            // Top 5 bids
            const topBids = book.bids.slice(0, 5);
            for (const bid of topBids) {
                const bar = '█'.repeat(Math.min(10, Math.round(bid.size / 100)));
                lines.push(`    {green-fg}$${bid.price.toFixed(2)} ${bid.size.toFixed(0).padStart(7)} ${bar}{/green-fg}`);
            }
            lines.push('');
        }
    }

    return '\n' + lines.join('\n');
}

let refreshTimer = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        updateStatus(await buildStatusContent());
    }, 2000);
    buildStatusContent().then(updateStatus);
}

// ── Market handler with per-asset queue ──────────────────────────────────────

const pendingByAsset = new Map();

async function runStrategy(market) {
    // Connect WebSocket for orderbook visualization in sim mode
    if (config.dryRun) {
        activeWsTokens = { up: market.yesTokenId, down: market.noTokenId };
        orderbookWs.subscribe(market.conditionId, [market.yesTokenId, market.noTokenId]);
    }

    try {
        await executeMakerStrategy(market);
    } catch (err) {
        logger.error(`MAKER strategy error (${market.asset?.toUpperCase()}): ${err.message}`);
    }

    // Disconnect WS after strategy ends
    if (config.dryRun) {
        activeWsTokens = { up: null, down: null };
    }

    // Process queued market
    const queued = pendingByAsset.get(market.asset);
    if (queued) {
        pendingByAsset.delete(market.asset);
        const endMs = new Date(queued.endTime).getTime();
        const secsLeft = Math.round((endMs - Date.now()) / 1000);

        if (secsLeft > 30) {
            logger.success(`MAKER[${market.asset?.toUpperCase()}]: executing queued market (${secsLeft}s left)`);
            runStrategy(queued);
        } else {
            logger.warn(`MAKER[${market.asset?.toUpperCase()}]: queued market expired (${secsLeft}s left)`);
        }
    }
}

async function handleNewMarket(market) {
    const active = getActiveMakerPositions();
    const isAssetBusy = active.some((p) => p.asset === market.asset);

    if (isAssetBusy) {
        pendingByAsset.set(market.asset, market);
        logger.warn(`MAKER[${market.asset?.toUpperCase()}]: queued — will enter after current position clears`);
        return;
    }

    runStrategy(market);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
    logger.warn('MAKER: shutting down...');
    stopMakerDetector();
    orderbookWs.shutdown();
    if (refreshTimer) clearInterval(refreshTimer);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

const costPerSide = config.makerTradeSize * config.makerBuyPrice;
const profitPerCycle = (config.makerSellPrice - config.makerBuyPrice) * config.makerTradeSize;
logger.info(`MAKER starting — ${config.dryRun ? 'SIMULATION' : 'LIVE'}`);
logger.info(`Assets: ${config.makerAssets.join(', ').toUpperCase()} | BUY @ $${config.makerBuyPrice} → SELL @ $${config.makerSellPrice}`);
logger.info(`Size: ${config.makerTradeSize} sh/side | Cost: $${costPerSide.toFixed(2)}/side | Profit: $${profitPerCycle.toFixed(2)}/cycle`);

startRefresh();
startMakerDetector(handleNewMarket);
