import config, { validateConfig } from './config/index.js';
import { initClient, getUsdcBalance, getClient } from './services/client.js';
import { executeBuy, executeSell } from './services/executor.js';
import { checkAndRedeemPositions } from './services/redeemer.js';
import { getOpenPositions } from './services/position.js';
import { startWsWatcher, stopWsWatcher } from './services/wsWatcher.js';
import { getSimStats } from './utils/simStats.js';
import { initDashboard, appendLog, updateStatus } from './ui/dashboard.js';
import logger from './utils/logger.js';

// ── Dashboard init (before any log output) ────────────────────────────────────
// On some Windows setups the blessed TUI can render as a blank screen.
// Allow disabling the dashboard with NO_TUI=true or HEADLESS=true in .env.
const useDashboard = process.env.NO_TUI !== 'true' && process.env.HEADLESS !== 'true';

if (useDashboard) {
    try {
        initDashboard();
        logger.setOutput(appendLog);
    } catch (err) {
        // Fall back to plain stdout logging if TUI fails
        // eslint-disable-next-line no-console
        console.error('Failed to initialize dashboard, running in headless mode:', err.message);
    }
}

// ── Handle a trade event from WebSocket ───────────────────────────────────────
async function handleTrade(trade) {
    try {
        if (trade.type === 'BUY') {
            await executeBuy(trade);
        } else if (trade.type === 'SELL') {
            await executeSell(trade);
        }
    } catch (err) {
        logger.error(`Error processing trade ${trade.id}: ${err.message}`);
    }
}

// ── Build the right-panel status content ──────────────────────────────────────
async function buildStatusContent() {
    const lines = [];

    // Header
    const mode = config.dryRun ? '{yellow-fg}[SIMULATION]{/yellow-fg}' : '{red-fg}[LIVE TRADING]{/red-fg}';
    lines.push(` ${mode}  Trader: {cyan-fg}${config.traderAddress.substring(0, 12)}…{/cyan-fg}`);
    lines.push(` {gray-fg}${'─'.repeat(36)}{/gray-fg}`);

    // Balance
    try {
        const balance = await getUsdcBalance();
        const balColor = balance > 0 ? 'green-fg' : 'gray-fg';
        lines.push(` {yellow-fg}💵 Balance:{/yellow-fg} {bold}{${balColor}}$${balance.toFixed(2)} USDC.e{/${balColor}}{/bold}`);
    } catch {
        lines.push(` {yellow-fg}💵 Balance:{/yellow-fg} {gray-fg}N/A{/gray-fg}`);
    }
    lines.push('');

    // Open positions
    const positions = getOpenPositions();
    if (positions.length === 0) {
        lines.push(` {gray-fg}No open positions{/gray-fg}`);
    } else {
        lines.push(` {cyan-fg}📈 POSITIONS (${positions.length}){/cyan-fg}`);
        lines.push(` {gray-fg}${'─'.repeat(36)}{/gray-fg}`);

        for (let i = 0; i < positions.length; i++) {
            const pos = positions[i];

            // Fetch current midpoint price (best-effort)
            let currentPrice = null;
            try {
                const client = getClient();
                const mp = await client.getMidpoint(pos.tokenId);
                currentPrice = parseFloat(mp?.mid ?? mp ?? '0');
                if (!currentPrice || isNaN(currentPrice)) currentPrice = null;
            } catch { /* price unavailable */ }

            const marketName = (pos.market || pos.tokenId || '').substring(0, 30);
            const spent = pos.totalCost || 0;
            const maxStr = config.maxPositionSize;
            const bar = buildBar(spent, maxStr, 18);

            lines.push('');
            lines.push(` {bold}{white-fg}${i + 1}. ${marketName}{/white-fg}{/bold}`);
            lines.push(`    {cyan-fg}${pos.outcome || '?'}{/cyan-fg} | ${pos.shares.toFixed(3)} sh @ $${pos.avgBuyPrice.toFixed(3)}`);
            lines.push(`    ${bar}  {yellow-fg}$${spent.toFixed(2)}/$${maxStr}{/yellow-fg}`);

            if (currentPrice !== null) {
                const pnl = (currentPrice - pos.avgBuyPrice) * pos.shares;
                const pct = spent > 0 ? ((pnl / spent) * 100).toFixed(1) : '0.0';
                const sign = pnl >= 0 ? '+' : '';
                const pnlColor = pnl >= 0 ? 'green-fg' : 'red-fg';
                lines.push(`    $${currentPrice.toFixed(3)} now | {${pnlColor}}${sign}$${pnl.toFixed(2)} (${sign}${pct}%){/${pnlColor}}`);
            } else {
                lines.push(`    {gray-fg}Price unavailable{/gray-fg}`);
            }
        }
    }

    // Simulation stats (only when dryRun)
    if (config.dryRun) {
        const s = getSimStats();
        lines.push('');
        lines.push(` {gray-fg}${'─'.repeat(36)}{/gray-fg}`);
        lines.push(` {magenta-fg}📊 SIMULATION STATS{/magenta-fg}`);
        lines.push(`  Buys tracked : ${s.totalBuys}`);
        lines.push(`  Resolved     : ${s.totalResolved}`);

        if (s.totalResolved > 0) {
            const rate = ((s.wins / s.totalResolved) * 100).toFixed(0);
            lines.push(
                `  {green-fg}Wins: ${s.wins}{/green-fg}  {red-fg}Losses: ${s.losses}{/red-fg}  Rate: ${rate}%`,
            );
        }

        const pnl = s.closedPnl || 0;
        if (pnl !== 0) {
            const sign = pnl >= 0 ? '+' : '';
            const c = pnl >= 0 ? 'green-fg' : 'red-fg';
            lines.push(`  Realized P&L : {${c}}{bold}${sign}$${pnl.toFixed(2)}{/bold}{/${c}}`);
        }

        if (s.closedPositions && s.closedPositions.length > 0) {
            lines.push('');
            lines.push(`  {gray-fg}── Recent Closed ──{/gray-fg}`);
            const recent = s.closedPositions.slice(-5).reverse();
            for (const cp of recent) {
                const icon = cp.result === 'WIN' ? '{green-fg}✅{/green-fg}' : '{red-fg}❌{/red-fg}';
                const sign = cp.pnl >= 0 ? '+' : '';
                lines.push(`  ${icon} ${(cp.market || '').substring(0, 22)}`);
                lines.push(`     {gray-fg}${sign}$${cp.pnl.toFixed(2)}{/gray-fg}`);
            }
        }
    }

    lines.push('');
    lines.push(` {gray-fg}Updated ${new Date().toISOString().substring(11, 19)}{/gray-fg}`);

    return lines.join('\n');
}

/** Simple ASCII fill bar */
function buildBar(value, max, width) {
    const pct = Math.min(value / max, 1);
    const filled = Math.round(pct * width);
    const empty = width - filled;
    const color = pct >= 1 ? 'red-fg' : pct >= 0.7 ? 'yellow-fg' : 'green-fg';
    return `{${color}}${'█'.repeat(filled)}{/${color}}{gray-fg}${'░'.repeat(empty)}{/gray-fg}`;
}

// ── Status panel refresh loop ─────────────────────────────────────────────────
async function refreshStatus() {
    try {
        const content = await buildStatusContent();
        updateStatus(content);
    } catch (err) {
        updateStatus(` {red-fg}Error refreshing status: ${err.message}{/red-fg}`);
    }
}

// ── Redeemer loop ─────────────────────────────────────────────────────────────
async function redeemerLoop() {
    try {
        await checkAndRedeemPositions();
    } catch (err) {
        logger.error('Redeemer loop error:', err.message);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    // Validate config
    try {
        validateConfig();
    } catch (err) {
        logger.error(err.message);
        process.exit(1);
    }

    logger.info('=== Settings ===');
    logger.info(`Trader          : ${config.traderAddress}`);
    logger.info(`Proxy wallet    : ${config.proxyWallet}`);
    logger.info(`Size mode       : ${config.sizeMode} (${config.sizePercent}%)`);
    logger.info(`Min trade       : $${config.minTradeSize}`);
    logger.info(`Max position    : $${config.maxPositionSize} per market`);
    logger.info(`Auto sell       : ${config.autoSellEnabled ? `ON (${config.autoSellProfitPercent}%)` : 'OFF'}`);
    logger.info(`Sell mode       : ${config.sellMode}`);
    logger.info(`Mode            : ${config.dryRun ? 'SIMULATION (DRY RUN)' : 'LIVE TRADING'}`);
    logger.info('================');

    // Initialize CLOB client
    try {
        await initClient();
    } catch (err) {
        logger.error('Failed to initialize client:', err.message);
        process.exit(1);
    }

    // Initial balance display
    try {
        const balance = await getUsdcBalance();
        logger.money(`USDC.e Balance: $${balance.toFixed(2)}`);
    } catch (err) {
        logger.warn('Could not fetch balance:', err.message);
    }

    logger.success(
        config.dryRun
            ? 'Simulation started! Watching trader in real-time...'
            : 'Bot started! Watching trader in real-time...',
    );

    // Initial status render
    await refreshStatus();

    // Start real-time WebSocket watcher
    startWsWatcher(handleTrade);

    // Run redeemer immediately then on interval
    await redeemerLoop();
    const redeemerInterval = setInterval(redeemerLoop, config.redeemInterval);

    // Refresh right panel every 5 seconds
    const statusInterval = setInterval(refreshStatus, 5000);

    // Graceful shutdown
    const shutdown = () => {
        logger.info('Shutting down...');
        stopWsWatcher();
        clearInterval(redeemerInterval);
        clearInterval(statusInterval);
        setTimeout(() => process.exit(0), 300);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    logger.error('Fatal error:', err.message);
    process.exit(1);
});
