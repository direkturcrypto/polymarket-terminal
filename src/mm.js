/**
 * mm.js
 * Entry point for the Market Maker bot.
 * Detects new Bitcoin 5-minute markets and executes the MM strategy.
 * Run with: npm run mm       (live)
 *           npm run mm-sim   (simulation / dry-run)
 */

// Set proxy before any network calls
import './utils/proxy-patch.cjs';

import { validateMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getClient } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive } from './ui/dashboard.js';
import { startMMDetector, stopMMDetector } from './services/mmDetector.js';
import { executeMMStrategy, getActiveMMPositions } from './services/mmExecutor.js';
import { getUsdcBalance } from './services/client.js';
import { cleanupOpenPositions, redeemMMPositions, MIN_SHARES_PER_SIDE } from './services/ctf.js';

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateMMConfig();
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

// ── Validate MM_TRADE_SIZE minimum ────────────────────────────────────────────

if (config.mmTradeSize < MIN_SHARES_PER_SIDE) {
    logger.error(
        `MM_TRADE_SIZE=${config.mmTradeSize} is below Polymarket minimum of ${MIN_SHARES_PER_SIDE} shares. ` +
        `Set MM_TRADE_SIZE ≥ ${MIN_SHARES_PER_SIDE} in your .env and restart.`
    );
    process.exit(1);
}

// ── Cleanup leftover positions on startup ─────────────────────────────────────

try {
    await cleanupOpenPositions(getClient());
} catch (err) {
    logger.warn(`MM: startup cleanup failed (non-fatal): ${err.message}`);
}

// ── Status panel refresh ──────────────────────────────────────────────────────

async function buildStatusContent() {
    let lines = [];

    // Balance
    let balance = '?';
    if (!config.dryRun) {
        try { balance = (await getUsdcBalance()).toFixed(2); } catch { /* ignore */ }
    } else {
        balance = '{yellow-fg}SIM{/yellow-fg}';
    }
    lines.push(`{bold}BALANCE{/bold}`);
    lines.push(`  USDC.e: {green-fg}$${balance}{/green-fg}`);
    lines.push('');

    // Mode
    lines.push(`{bold}MODE{/bold}`);
    lines.push(`  ${config.dryRun ? '{yellow-fg}SIMULATION{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    lines.push('');

    // MM Config
    lines.push(`{bold}MM CONFIG{/bold}`);
    lines.push(`  Assets   : ${config.mmAssets.join(', ').toUpperCase()}`);
    lines.push(`  Duration : ${config.mmDuration}`);
    lines.push(`  Trade sz : $${config.mmTradeSize} per side`);
    lines.push(`  Sell @   : $${config.mmSellPrice}`);
    lines.push(`  Cut loss : ${config.mmCutLossTime}s before close`);
    lines.push('');

    // Active positions
    const positions = getActiveMMPositions();
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

            // YES side
            const yFill = pos.yes.filled
                ? `{green-fg}FILLED @ $${pos.yes.fillPrice?.toFixed(3)}{/green-fg}`
                : `{yellow-fg}waiting $${config.mmSellPrice}{/yellow-fg}`;
            lines.push(`  YES  ${pos.yes.shares?.toFixed(3)} sh @ $${pos.yes.entryPrice?.toFixed(3)} → ${yFill}`);

            // NO side
            const nFill = pos.no.filled
                ? `{green-fg}FILLED @ $${pos.no.fillPrice?.toFixed(3)}{/green-fg}`
                : `{yellow-fg}waiting $${config.mmSellPrice}{/yellow-fg}`;
            lines.push(`  NO   ${pos.no.shares?.toFixed(3)} sh @ $${pos.no.entryPrice?.toFixed(3)} → ${nFill}`);

            lines.push('');
        }
    }

    return '\n' + lines.join('\n');
}

let refreshTimer = null;
let redeemTimer  = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        const content = await buildStatusContent();
        updateStatus(content);
    }, 3000);

    // Also do one immediate refresh
    buildStatusContent().then(updateStatus);
}

function startRedeemer() {
    // Run once immediately, then every redeemInterval (default 60s)
    redeemMMPositions().catch((err) => logger.error('MM redeemer error:', err.message));
    redeemTimer = setInterval(
        () => redeemMMPositions().catch((err) => logger.error('MM redeemer error:', err.message)),
        config.redeemInterval,
    );
    logger.info(`MM redeemer started — checking every ${config.redeemInterval / 1000}s`);
}

// ── Market handler with per-asset queue ──────────────────────────────────────

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
                `executing queued "${queued.question.substring(0, 40)}" (${secsLeft}s left)`
            );
            runStrategy(queued); // non-blocking
        } else {
            logger.warn(
                `MM[${market.asset?.toUpperCase()}]: queued market "${queued.question.substring(0, 40)}" ` +
                `expired (${secsLeft}s left) — discarding`
            );
        }
    }
}

async function handleNewMarket(market) {
    const active = getActiveMMPositions();
    const isAssetBusy = active.some((p) => p.asset === market.asset);

    if (isAssetBusy) {
        // Queue this market for this asset — runs once the current position exits
        pendingByAsset.set(market.asset, market);
        logger.warn(
            `MM[${market.asset?.toUpperCase()}]: queued "${market.question.substring(0, 40)}" — ` +
            `will enter after current ${market.asset?.toUpperCase()} position clears`
        );
        return;
    }

    runStrategy(market); // non-blocking
}


// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
    logger.warn('MM: shutting down...');
    stopMMDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    if (redeemTimer)  clearInterval(redeemTimer);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

logger.info(`MM bot starting — ${config.dryRun ? 'SIMULATION MODE' : 'LIVE MODE'} | assets: ${config.mmAssets.join(', ').toUpperCase()} | ${config.mmDuration}`);
startRefresh();
startRedeemer();
startMMDetector(handleNewMarket);
