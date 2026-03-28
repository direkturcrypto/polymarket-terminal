/**
 * mm-bot.js — Market Maker, PM2 / VPS entry point (no TUI)
 *
 * Plain-text stdout output, compatible with:
 *   pm2 start ecosystem.config.cjs --only polymarket-mm
 *   pm2 logs polymarket-mm
 */

// Set proxy before any network calls
import './utils/proxy-patch.cjs';

import { validateMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getClient, getUsdcBalance } from './services/client.js';
import { startMMDetector, stopMMDetector } from './services/mmDetector.js';
import { executeMMStrategy, getActiveMMPositions } from './services/mmExecutor.js';
import { mmFillWatcher } from './services/mmWsFillWatcher.js';
import { cleanupOpenPositions, redeemMMPositions, MIN_SHARES_PER_SIDE } from './services/ctf.js';

logger.interceptConsole();

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMMConfig();
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

// ── Validate MM_TRADE_SIZE minimum ────────────────────────────────────────────

if (config.mmTradeSize < MIN_SHARES_PER_SIDE) {
    logger.error(
        `MM_TRADE_SIZE=${config.mmTradeSize} is below Polymarket minimum of ${MIN_SHARES_PER_SIDE} shares. ` +
        `Set MM_TRADE_SIZE ≥ ${MIN_SHARES_PER_SIDE} in your .env and restart.`,
    );
    process.exit(1);
}

// ── Start WebSocket fill watcher for real-time order detection ────────────────

mmFillWatcher.start();

// ── Cleanup leftover positions on startup ─────────────────────────────────────

try {
    await cleanupOpenPositions(getClient());
} catch (err) {
    logger.warn(`MM: startup cleanup failed (non-fatal): ${err.message}`);
}

// ── Periodic status log (replaces TUI right panel) ────────────────────────────

async function printStatus() {
    try {
        let balanceStr = 'SIM';
        if (!config.dryRun) {
            try { balanceStr = `$${(await getUsdcBalance()).toFixed(2)} USDC`; } catch { balanceStr = 'N/A'; }
        }

        const positions = getActiveMMPositions();
        const mode = config.dryRun ? 'SIMULATION' : 'LIVE';

        logger.info(
            `--- MM Status [${mode}] | Balance: ${balanceStr} | Active positions: ${positions.length} ---`,
        );

        for (const pos of positions) {
            const assetTag  = pos.asset ? `[${pos.asset.toUpperCase()}] ` : '';
            const label     = pos.question.substring(0, 50);
            const msLeft    = new Date(pos.endTime).getTime() - Date.now();
            const secsLeft  = Math.max(0, Math.round(msLeft / 1000));
            const timeStr   = secsLeft > 60
                ? `${Math.floor(secsLeft / 60)}m${secsLeft % 60}s left`
                : `${secsLeft}s left`;

            const yFill = pos.yes.filled
                ? `FILLED @ $${pos.yes.fillPrice?.toFixed(3)}`
                : `waiting $${config.mmSellPrice}`;
            const nFill = pos.no.filled
                ? `FILLED @ $${pos.no.fillPrice?.toFixed(3)}`
                : `waiting $${config.mmSellPrice}`;

            logger.info(
                `  ${assetTag}${label} | ${pos.status} | ${timeStr}` +
                ` | YES ${pos.yes.shares?.toFixed(3)}sh@$${pos.yes.entryPrice?.toFixed(3)} → ${yFill}` +
                ` | NO ${pos.no.shares?.toFixed(3)}sh@$${pos.no.entryPrice?.toFixed(3)} → ${nFill}`,
            );
        }
    } catch (err) {
        logger.warn(`Status check error: ${err.message}`);
    }
}

// ── Market handler with per-asset queue ───────────────────────────────────────

// Each asset can hold one pending market while its current position is active.
const pendingByAsset = new Map(); // asset → market

async function runStrategy(market) {
    try {
        await executeMMStrategy(market);
    } catch (err) {
        logger.error(`MM strategy error (${market.asset?.toUpperCase()}): ${err.message}`);
    }

    // After position clears, execute the queued market for this asset if still valid
    const queued = pendingByAsset.get(market.asset);
    if (queued) {
        pendingByAsset.delete(market.asset);

        const endMs    = new Date(queued.endTime).getTime();
        const secsLeft = Math.round((endMs - Date.now()) / 1000);

        if (secsLeft > config.mmCutLossTime) {
            logger.success(
                `MM[${market.asset?.toUpperCase()}]: position cleared — ` +
                `executing queued "${queued.question.substring(0, 40)}" (${secsLeft}s left)`,
            );
            runStrategy(queued); // non-blocking
        } else {
            logger.warn(
                `MM[${market.asset?.toUpperCase()}]: queued market "${queued.question.substring(0, 40)}" ` +
                `expired (${secsLeft}s left) — discarding`,
            );
        }
    }
}

async function handleNewMarket(market) {
    const active     = getActiveMMPositions();
    const isAssetBusy = active.some((p) => p.asset === market.asset);

    if (isAssetBusy) {
        pendingByAsset.set(market.asset, market);
        logger.warn(
            `MM[${market.asset?.toUpperCase()}]: queued "${market.question.substring(0, 40)}" — ` +
            `will enter after current ${market.asset?.toUpperCase()} position clears`,
        );
        return;
    }

    runStrategy(market); // non-blocking
}

// ── Timers ────────────────────────────────────────────────────────────────────

// Print status every 60 seconds
const statusTimer = setInterval(printStatus, 60_000);

// Redeemer: run immediately then every redeemInterval
redeemMMPositions().catch((err) => logger.error('MM redeemer error:', err.message));
const redeemTimer = setInterval(
    () => redeemMMPositions().catch((err) => logger.error('MM redeemer error:', err.message)),
    config.redeemInterval,
);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
    logger.warn('MM: shutting down...');
    stopMMDetector();
    mmFillWatcher.stop();
    clearInterval(statusTimer);
    clearInterval(redeemTimer);
    setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

const mode = config.dryRun ? 'SIMULATION' : 'LIVE';
logger.info(`=== Market Maker [${mode}] ===`);
logger.info(`Assets    : ${config.mmAssets.join(', ').toUpperCase()}`);
logger.info(`Duration  : ${config.mmDuration}`);
logger.info(`Trade size: $${config.mmTradeSize} per side`);
logger.info(`Sell @    : $${config.mmSellPrice}`);
logger.info(`Cut loss  : ${config.mmCutLossTime}s before close`);
logger.info(`Keyword   : ${config.mmMarketKeyword}`);
logger.info(`Entry win : ${config.mmEntryWindow}s after open`);
logger.info('==========================================');

startMMDetector(handleNewMarket);
logger.success(`MM bot started — watching for ${config.mmDuration} ${config.mmAssets.join('/')} markets...`);
