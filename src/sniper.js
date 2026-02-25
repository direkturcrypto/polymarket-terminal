/**
 * sniper.js
 * Entry point for the Orderbook Sniper bot.
 * Places tiny GTC BUY orders at $0.01 on both sides of ETH/SOL/XRP 5-min markets.
 *
 * Run with: npm run sniper       (live)
 *           npm run sniper-sim   (simulation)
 */

import { validateMMConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient } from './services/client.js';
import { getUsdcBalance } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive } from './ui/dashboard.js';
import { startSniperDetector, stopSniperDetector } from './services/sniperDetector.js';
import { executeSnipe, getActiveSnipes } from './services/sniperExecutor.js';
import { redeemMMPositions } from './services/ctf.js';

// ── Validate config ────────────────────────────────────────────────────────────

try {
  validateMMConfig();
} catch (err) {
  console.error(`Config error: ${err.message}`);
  process.exit(1);
}

if (config.sniperAssets.length === 0) {
  console.error('SNIPER_ASSETS is empty. Set e.g. SNIPER_ASSETS=eth,sol,xrp in .env');
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

// ── Status panel ──────────────────────────────────────────────────────────────

async function buildStatusContent() {
  const lines = [];

  // Balance
  let balance = '?';
  if (!config.dryRun) {
    try {
      balance = (await getUsdcBalance()).toFixed(2);
    } catch {
      /* ignore */
    }
  } else {
    balance = '{yellow-fg}SIM{/yellow-fg}';
  }
  lines.push('{bold}BALANCE{/bold}');
  lines.push(`  USDC.e: {green-fg}$${balance}{/green-fg}`);
  lines.push('');

  lines.push('{bold}MODE{/bold}');
  lines.push(
    `  ${config.dryRun ? '{yellow-fg}SIMULATION{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`,
  );
  lines.push('');

  lines.push('{bold}SNIPER CONFIG{/bold}');
  lines.push(`  Assets : ${config.sniperAssets.join(', ').toUpperCase()}`);
  lines.push(`  Price  : $${config.sniperPrice} per share`);
  lines.push(`  Shares : ${config.sniperShares} per side`);
  lines.push(
    `  Late   : ${config.sniperLateEnabled ? `ON (${config.sniperLateDurations.join(', ')}, <${config.sniperLateCloseWindow}s, ${Math.round(config.sniperLateMinPrice * 100)}-${Math.round(config.sniperLateMaxPrice * 100)}c)` : 'OFF'}`,
  );
  lines.push(
    `  Cost   : $${(config.sniperPrice * config.sniperShares * 2 * config.sniperAssets.length).toFixed(3)} per slot`,
  );
  lines.push('');

  // Recent snipe orders
  const snipes = getActiveSnipes();
  lines.push(`{bold}SNIPE ORDERS (${snipes.length} total){/bold}`);

  if (snipes.length === 0) {
    lines.push('  {gray-fg}Waiting for next slot...{/gray-fg}');
  } else {
    // Show last 10 orders (most recent first)
    const recent = snipes.slice(-10).reverse();
    for (const s of recent) {
      const payout = s.potentialPayout.toFixed(2);
      lines.push(
        `  {cyan-fg}${s.asset}{/cyan-fg} ${s.side} @ $${s.price} × ${s.shares}sh | pay $${payout} if win`,
      );
    }
  }

  return '\n' + lines.join('\n');
}

let refreshTimer = null;
let redeemTimer = null;

function startRefresh() {
  refreshTimer = setInterval(async () => {
    if (!isDashboardActive()) return;
    updateStatus(await buildStatusContent());
  }, 3000);
  buildStatusContent().then(updateStatus);
}

function startRedeemer() {
  redeemMMPositions('SNIPER').catch((err) => logger.error('Sniper redeemer error:', err.message));
  redeemTimer = setInterval(
    () =>
      redeemMMPositions('SNIPER').catch((err) =>
        logger.error('Sniper redeemer error:', err.message),
      ),
    config.redeemInterval,
  );
  logger.info(`Sniper redeemer started — checking every ${config.redeemInterval / 1000}s`);
}

// ── Market handler ────────────────────────────────────────────────────────────

async function handleNewMarket(market) {
  executeSnipe(market).catch((err) =>
    logger.error(`SNIPER execute error (${market.asset}): ${err.message}`),
  );
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown() {
  logger.warn('SNIPER: shutting down...');
  stopSniperDetector();
  if (refreshTimer) clearInterval(refreshTimer);
  if (redeemTimer) clearInterval(redeemTimer);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

const costPerSlot = (
  config.sniperPrice *
  config.sniperShares *
  2 *
  config.sniperAssets.length
).toFixed(3);
logger.info(`SNIPER starting — ${config.dryRun ? 'SIMULATION' : 'LIVE'}`);
logger.info(
  `Assets: ${config.sniperAssets.join(', ').toUpperCase()} | $${config.sniperPrice} × ${config.sniperShares}sh = $${costPerSlot}/slot`,
);

startRefresh();
startRedeemer();
startSniperDetector(handleNewMarket);
