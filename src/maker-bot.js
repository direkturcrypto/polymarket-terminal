/**
 * maker-bot.js — Buy Low, Sell High Market Maker, PM2 / VPS entry point (no TUI)
 *
 * Plain-text stdout output, compatible with:
 *   pm2 start ecosystem.config.cjs --only polymarket-maker
 *   pm2 logs polymarket-maker
 */

import './utils/proxy-patch.cjs';

import { validateMakerConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getUsdcBalance } from './services/client.js';
import { startMakerDetector, stopMakerDetector } from './services/makerDetector.js';
import { executeMakerStrategy, getActiveMakerPositions } from './services/makerExecutor.js';
import { OrderbookWs } from './services/makerWs.js';

logger.interceptConsole();

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMakerConfig();
} catch (err) {
    logger.error(`Config error: ${err.message}`);
    process.exit(1);
}

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

// ── WebSocket orderbook (for sim mode) ───────────────────────────────────────

const orderbookWs = new OrderbookWs();

// ── Periodic status log ──────────────────────────────────────────────────────

async function printStatus() {
    try {
        let balanceStr = 'SIM';
        if (!config.dryRun) {
            try { balanceStr = `$${(await getUsdcBalance()).toFixed(2)} USDC`; } catch { balanceStr = 'N/A'; }
        }

        const positions = getActiveMakerPositions();
        const mode = config.dryRun ? 'SIMULATION' : 'LIVE';

        logger.info(`--- MAKER Status [${mode}] | Balance: ${balanceStr} | Active: ${positions.length} ---`);

        for (const pos of positions) {
            const assetTag = pos.asset ? `[${pos.asset.toUpperCase()}] ` : '';
            const label = pos.question.substring(0, 50);
            const msLeft = new Date(pos.endTime).getTime() - Date.now();
            const secsLeft = Math.max(0, Math.round(msLeft / 1000));
            const timeStr = secsLeft > 60 ? `${Math.floor(secsLeft / 60)}m${secsLeft % 60}s` : `${secsLeft}s`;
            const pnl = pos.totalRevenue - pos.totalCost;
            const sign = pnl >= 0 ? '+' : '';

            logger.info(
                `  ${assetTag}${label} | ${pos.status} | ${timeStr} left` +
                ` | UP: ${pos.up.buyFilled.toFixed(1)}sh bought, ${pos.up.totalSellFilled.toFixed(1)}sh sold` +
                ` | DOWN: ${pos.down.buyFilled.toFixed(1)}sh bought, ${pos.down.totalSellFilled.toFixed(1)}sh sold` +
                ` | P&L: ${sign}$${pnl.toFixed(4)}`,
            );

            // Orderbook snapshot in sim mode
            if (config.dryRun) {
                for (const [label, tokenId] of [['UP', pos.up.tokenId], ['DOWN', pos.down.tokenId]]) {
                    const book = orderbookWs.getBook(tokenId);
                    const bestBid = book.bids[0];
                    const bestAsk = book.asks[0];
                    if (bestBid || bestAsk) {
                        logger.info(
                            `    ${label} book: bid $${bestBid?.price.toFixed(3) || '-'} × ${bestBid?.size.toFixed(0) || '-'}` +
                            ` | ask $${bestAsk?.price.toFixed(3) || '-'} × ${bestAsk?.size.toFixed(0) || '-'}`,
                        );
                    }
                }
            }
        }
    } catch (err) {
        logger.warn(`Status check error: ${err.message}`);
    }
}

// ── Market handler with per-asset queue ──────────────────────────────────────

const pendingByAsset = new Map();

async function runStrategy(market) {
    if (config.dryRun) {
        orderbookWs.subscribe(market.conditionId, [market.yesTokenId, market.noTokenId]);
    }

    try {
        await executeMakerStrategy(market);
    } catch (err) {
        logger.error(`MAKER strategy error (${market.asset?.toUpperCase()}): ${err.message}`);
    }

    const queued = pendingByAsset.get(market.asset);
    if (queued) {
        pendingByAsset.delete(market.asset);
        const secsLeft = Math.round((new Date(queued.endTime).getTime() - Date.now()) / 1000);

        if (secsLeft > config.makerCutLossTime) {
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

// ── Timers ───────────────────────────────────────────────────────────────────

const statusTimer = setInterval(printStatus, 60_000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
    logger.warn('MAKER: shutting down...');
    stopMakerDetector();
    orderbookWs.shutdown();
    clearInterval(statusTimer);
    setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

const mode = config.dryRun ? 'SIMULATION' : 'LIVE';
const costPerSide = config.makerTradeSize * config.makerBuyPrice;
const profitPerCycle = (config.makerSellPrice - config.makerBuyPrice) * config.makerTradeSize;

logger.info(`=== Market Maker v2 [${mode}] ===`);
logger.info(`Assets    : ${config.makerAssets.join(', ').toUpperCase()}`);
logger.info(`Duration  : ${config.makerDuration}`);
logger.info(`Buy @     : $${config.makerBuyPrice} per share`);
logger.info(`Sell @    : $${config.makerSellPrice} per share`);
logger.info(`Size      : ${config.makerTradeSize} shares/side`);
logger.info(`Cost/side : $${costPerSide.toFixed(2)}`);
logger.info(`Profit    : $${profitPerCycle.toFixed(2)} per cycle`);
logger.info(`Cut loss  : ${config.makerCutLossTime}s before close`);
logger.info('==========================================');

startMakerDetector(handleNewMarket);
logger.success(`MAKER bot started — watching for ${config.makerDuration} ${config.makerAssets.join('/')} markets...`);
