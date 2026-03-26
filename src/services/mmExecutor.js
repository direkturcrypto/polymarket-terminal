/**
 * mmExecutor.js
 * Executes the market-maker strategy for a single Bitcoin 5-minute market:
 *   1. Call CTF splitPosition — deposit USDC, receive equal YES+NO tokens at $0.50 flat
 *   2. Place GTC limit sells at mmSellPrice for both YES and NO
 *   3. Monitor until both fills or cut-loss time triggers
 *   4. On cut-loss:
 *        - If NEITHER side filled  → mergePositions (burn YES+NO, recover USDC, zero loss)
 *        - If ONE side already sold → cancel the other, market-sell remaining tokens
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getClient, getUsdcBalance, getPolygonProvider } from './client.js';
import { splitPosition, mergePositions } from './ctf.js';
import logger from '../utils/logger.js';

// CTF contract for on-chain balance queries
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_BALANCE_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)'];

// Polymarket CLOB minimum order size (shares)
const CLOB_MIN_ORDER_SHARES = 5;

/**
 * Get actual on-chain ERC1155 token balance for the proxy wallet.
 * Used before market-sell to avoid 'not enough balance' errors from partial fills.
 */
async function getTokenBalance(tokenId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_BALANCE_ABI, provider);
        const raw = await ctf.balanceOf(config.proxyWallet, tokenId);
        return parseFloat(ethers.utils.formatUnits(raw, 6));
    } catch {
        return null; // fallback: caller will use pos.shares
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory store of all active MM positions (conditionId → position)
const activePositions = new Map();

export function getActiveMMPositions() {
    return Array.from(activePositions.values());
}

// ── Order helpers ─────────────────────────────────────────────────────────────

async function placeLimitSell(tokenId, shares, price, tickSize, negRisk) {
    if (config.dryRun) {
        return { success: true, orderId: `sim-${Date.now()}-${tokenId.slice(-6)}` };
    }

    const client = getClient();
    try {
        const res = await client.createAndPostOrder(
            { tokenID: tokenId, side: Side.SELL, price, size: shares },
            { tickSize, negRisk },
            OrderType.GTC,
        );
        if (!res?.success) return { success: false };
        return { success: true, orderId: res.orderID };
    } catch (err) {
        logger.error('MM limit sell error:', err.message);
        return { success: false };
    }
}

async function cancelOrder(orderId) {
    if (config.dryRun || !orderId || orderId.startsWith('sim-')) return true;
    try {
        const client = getClient();
        await client.cancelOrder({ orderID: orderId }); // SDK expects { orderID } object
        return true;
    } catch (err) {
        logger.warn('MM cancel order error:', err.message);
        return false;
    }
}

async function marketSell(tokenId, shares, tickSize, negRisk) {
    if (config.dryRun) {
        try {
            const client = getClient();
            const mp = await client.getMidpoint(tokenId);
            const price = parseFloat(mp?.mid ?? mp ?? '0') || 0;
            return { success: true, fillPrice: price };
        } catch {
            return { success: true, fillPrice: 0 };
        }
    }

    const client = getClient();
    try {
        const res = await client.createAndPostMarketOrder(
            { tokenID: tokenId, side: Side.SELL, amount: shares, price: 0.01 },
            { tickSize, negRisk },
            OrderType.FOK,
        );
        if (!res?.success) return { success: false, fillPrice: 0 };
        return { success: true, fillPrice: parseFloat(res.price || '0') };
    } catch (err) {
        logger.error('MM market sell error:', err.message);
        return { success: false, fillPrice: 0 };
    }
}

// ── Order status check ────────────────────────────────────────────────────────

async function isOrderFilled(orderId, shares) {
    if (!orderId || orderId.startsWith('sim-')) return false;
    const MAX_FILL_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_FILL_RETRIES; attempt++) {
        try {
            const client = getClient();
            const order = await client.getOrder(orderId);
            if (!order) return false;
            if (order.status === 'MATCHED') return true;
            const matched = parseFloat(order.size_matched || '0');
            return matched >= shares * 0.99;
        } catch (err) {
            logger.warn(`MM: isOrderFilled error (attempt ${attempt}/${MAX_FILL_RETRIES}): ${err.message}`);
            if (attempt < MAX_FILL_RETRIES) await sleep(2000);
        }
    }
    return false;
}

/**
 * Get partial fill amount for an order (how many shares already matched).
 * Returns 0 on error.
 */
async function getOrderMatched(orderId) {
    if (!orderId || orderId.startsWith('sim-')) return 0;
    try {
        const client = getClient();
        const order = await client.getOrder(orderId);
        if (!order) return 0;
        if (order.status === 'MATCHED') return parseFloat(order.original_size || order.size || '0');
        return parseFloat(order.size_matched || '0');
    } catch {
        return 0;
    }
}

// For simulation: check if market price has reached the sell target
async function simPriceHitTarget(tokenId) {
    try {
        const client = getClient();
        const mp = await client.getMidpoint(tokenId);
        const price = parseFloat(mp?.mid ?? mp ?? '0');
        return price >= config.mmSellPrice ? price : null;
    } catch {
        return null;
    }
}

// Get current mid price for a token (0 on error)
async function getMidprice(tokenId) {
    try {
        const mp = await getClient().getMidpoint(tokenId);
        return parseFloat(mp?.mid ?? mp ?? '0') || 0;
    } catch { return 0; }
}

// ── Core monitoring loop ──────────────────────────────────────────────────────

async function monitorAndManage(pos) {
    const label = pos.question.substring(0, 40);

    while (true) {
        const msRemaining = new Date(pos.endTime).getTime() - Date.now();

        if (msRemaining <= 0) {
            logger.warn(`MM: market expired — ${label}`);
            pos.status = 'expired';
            break;
        }

        // ── Check YES side ──────────────────────────────────────
        if (!pos.yes.filled) {
            let filled = false;
            if (config.dryRun) {
                const hitPrice = await simPriceHitTarget(pos.yes.tokenId);
                if (hitPrice) { filled = true; pos.yes.fillPrice = hitPrice; }
            } else {
                filled = await isOrderFilled(pos.yes.orderId, pos.yes.shares);
                if (filled) pos.yes.fillPrice = config.mmSellPrice;
            }
            if (filled) {
                pos.yes.filled = true;
                const pnl = (pos.yes.fillPrice - pos.yes.entryPrice) * pos.yes.shares;
                logger.money(`MM${config.dryRun ? '[SIM]' : ''}: YES filled @ $${pos.yes.fillPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
            }
        }

        // ── Check NO side ───────────────────────────────────────
        if (!pos.no.filled) {
            let filled = false;
            if (config.dryRun) {
                const hitPrice = await simPriceHitTarget(pos.no.tokenId);
                if (hitPrice) { filled = true; pos.no.fillPrice = hitPrice; }
            } else {
                filled = await isOrderFilled(pos.no.orderId, pos.no.shares);
                if (filled) pos.no.fillPrice = config.mmSellPrice;
            }
            if (filled) {
                pos.no.filled = true;
                const pnl = (pos.no.fillPrice - pos.no.entryPrice) * pos.no.shares;
                logger.money(`MM${config.dryRun ? '[SIM]' : ''}: NO  filled @ $${pos.no.fillPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
            }
        }

        // ── Both filled → done ──────────────────────────────────
        if (pos.yes.filled && pos.no.filled) {
            pos.status = 'done';
            const totalPnl = calcPnl(pos);
            logger.money(`MM: BOTH sides filled! Total P&L: $${totalPnl.toFixed(2)} | ${label}`);
            break;
        }

        // ── Exactly one leg filled → adaptive cut-loss (if enabled) ────────
        if (config.mmAdaptiveCL && pos.yes.filled !== pos.no.filled) {
            const unfilledKey = pos.yes.filled ? 'no' : 'yes';
            await adaptiveLegCL(pos, unfilledKey);
            break;
        }

        // ── Defensive pivot: neither filled after timeout (5m markets only) ──
        if (config.mmDefensiveEnabled && config.mmDuration === '5m'
            && !pos.yes.filled && !pos.no.filled && !pos._defensiveActive) {
            // Measure from market open time (endTime - duration), not bot entry time
            const marketDurationMs = 5 * 60 * 1000;
            const marketStartMs = new Date(pos.endTime).getTime() - marketDurationMs;
            const elapsed = (Date.now() - marketStartMs) / 1000;
            if (elapsed >= config.mmDefensiveTimeout) {
                pos._defensiveActive = true;
                logger.warn(`MM: neither side filled after ${Math.round(elapsed)}s since market open — entering defensive mode | ${label}`);
                await defensivePivot(pos);
                break;
            }
        }

        // ── Cut-loss time ────────────────────────────────────────────────────
        if (msRemaining <= config.mmCutLossTime * 1000) {
            logger.warn(`MM: cut-loss triggered (${Math.round(msRemaining / 1000)}s left) — ${label}`);
            pos.status = 'cutting';
            const oneLegFilled = pos.yes.filled !== pos.no.filled;
            if (!config.mmAdaptiveCL && oneLegFilled) {
                // Legacy: one side sold → immediate market sell on the other
                const unfilledKey = pos.yes.filled ? 'no' : 'yes';
                await cutLossOneLegFilled(pos, unfilledKey);
                pos.status = 'done';
            } else {
                // Neither filled → cancel both + merge back to USDC
                await cutLossNeitherFilled(pos);
            }
            break;
        }

        await sleep(10_000);
    }

    // Final P&L log
    const totalPnl = calcPnl(pos);
    const sign = totalPnl >= 0 ? '+' : '';
    if (pos.status !== 'done') {
        logger.info(`MM: strategy ended (${pos.status}) | P&L: ${sign}$${totalPnl.toFixed(2)} | ${label}`);
    }
}

// Legacy one-leg CL: cancel unfilled order, immediate market sell (no patience)
async function cutLossOneLegFilled(pos, unfilledKey) {
    const s = pos[unfilledKey];
    const { tickSize, negRisk } = pos;

    logger.warn(`MM: cancelling ${unfilledKey.toUpperCase()} limit order and market-selling...`);
    await cancelOrder(s.orderId);

    const actualShares = await getTokenBalance(s.tokenId);
    const sellShares   = actualShares !== null ? actualShares : s.shares;

    if (sellShares < 0.001) {
        logger.warn(`MM: ${unfilledKey.toUpperCase()} balance is 0 — already fully sold via partial fills`);
        s.fillPrice = config.mmSellPrice;
        s.filled    = true;
        return;
    }

    logger.warn(`MM: ${unfilledKey.toUpperCase()} actual balance: ${sellShares.toFixed(3)} shares (original: ${s.shares})`);
    const result = await marketSell(s.tokenId, sellShares, tickSize, negRisk);
    s.fillPrice  = result.fillPrice;
    s.filled     = true;
    const pnl    = (s.fillPrice - s.entryPrice) * sellShares;
    logger.warn(`MM: ${unfilledKey.toUpperCase()} cut @ $${s.fillPrice.toFixed(3)} | sold ${sellShares.toFixed(3)} sh | P&L $${pnl.toFixed(2)}`);
}

async function cutLossNeitherFilled(pos) {
    const { conditionId } = pos;

    // ── Best case: neither side sold → cancel both, merge back to USDC ──
    logger.warn('MM: neither side filled — cancelling orders and merging back to USDC...');
    await cancelOrder(pos.yes.orderId);
    await cancelOrder(pos.no.orderId);

    // Read actual on-chain balances (may differ from original if partially consumed)
    const [yesActual, noActual] = await Promise.all([
        getTokenBalance(pos.yes.tokenId),
        getTokenBalance(pos.no.tokenId),
    ]);

    // mergePositions needs equal amounts — use the minimum actual balance
    const yesShares = yesActual ?? pos.yes.shares;
    const noShares = noActual ?? pos.no.shares;
    const mergeAmt = Math.min(yesShares, noShares);

    if (mergeAmt < 0.001) {
        logger.warn('MM: balances too low to merge — nothing to recover');
    } else {
        const recovered = await mergePositions(conditionId, mergeAmt);
        logger.money(`MM: merge complete — recovered ~$${recovered.toFixed ? recovered.toFixed(2) : recovered} USDC (P&L ≈ $0)`);
    }

    // Mark both sides closed at entry price
    pos.yes.fillPrice = pos.yes.entryPrice;
    pos.yes.filled = true;
    pos.no.fillPrice = pos.no.entryPrice;
    pos.no.filled = true;

    pos.status = 'done';

    // Optional recovery buy (enabled via MM_RECOVERY_BUY=true)
    await attemptRecoveryBuy(pos);
}

// ── Defensive Pivot (5m markets, neither side filled) ────────────────────────

/**
 * Defensive pivot: neither side has filled after MM_DEFENSIVE_TIMEOUT.
 *
 * Strategy:
 *   1. Cancel both limit sells, keep monitoring
 *   2. Wait until 45s before close
 *   3. Check prices: identify worst (lower price) and best (higher price) side
 *   4. If worst < MM_DEFENSIVE_WORST_THRESHOLD (default 10c):
 *        → market sell worst side, keep best side (let it resolve at close)
 *        → since YES+NO ≈ $1, best side is ~90c+ → profit potential
 *   5. If worst ≥ threshold: market is still uncertain → merge back ($0 P&L)
 */
async function defensivePivot(pos) {
    const { conditionId, tickSize, negRisk } = pos;
    const label = pos.question.substring(0, 40);
    const threshold = config.mmDefensiveWorstThreshold;

    // Cancel both limit sells immediately — we'll decide at 30s mark
    await cancelOrder(pos.yes.orderId);
    await cancelOrder(pos.no.orderId);
    logger.info(`MM defensive: cancelled both limit sells — waiting for 45s before close | ${label}`);

    // Wait until 30s before close, checking every 5s if one side fills via partial
    while (true) {
        const msLeft = new Date(pos.endTime).getTime() - Date.now();

        if (msLeft <= 45_000) break; // 45s mark reached
        if (msLeft <= 0) {
            pos.status = 'expired';
            return;
        }

        await sleep(5000);
    }

    // Read current prices for both sides
    const [yesPrice, noPrice] = await Promise.all([
        getMidprice(pos.yes.tokenId),
        getMidprice(pos.no.tokenId),
    ]);

    logger.info(`MM defensive: 45s mark — YES=$${yesPrice.toFixed(3)}, NO=$${noPrice.toFixed(3)} | threshold=$${threshold} | ${label}`);

    // Determine worst and best sides
    const worstKey = yesPrice <= noPrice ? 'yes' : 'no';
    const bestKey  = worstKey === 'yes' ? 'no' : 'yes';
    const worstPrice = Math.min(yesPrice, noPrice);
    const bestPrice  = Math.max(yesPrice, noPrice);

    // ── Decision: pivot or merge? ─────────────────────────────────────────
    if (worstPrice < threshold) {
        // Worst side < 10c → market is decisive, pivot!
        logger.trade(`MM defensive: worst side ${worstKey.toUpperCase()} @ $${worstPrice.toFixed(3)} < $${threshold} — selling worst, keeping ${bestKey.toUpperCase()} @ $${bestPrice.toFixed(3)}`);

        const worstSide = pos[worstKey];
        const bestSide  = pos[bestKey];

        // Get actual on-chain balances
        const [worstBalance, bestBalance] = await Promise.all([
            getTokenBalance(worstSide.tokenId),
            getTokenBalance(bestSide.tokenId),
        ]);
        const worstShares = worstBalance !== null ? worstBalance : worstSide.shares;
        const bestShares  = bestBalance !== null ? bestBalance : bestSide.shares;

        // Market sell worst side
        if (worstShares >= 0.001) {
            const result = await marketSell(worstSide.tokenId, worstShares, tickSize, negRisk);
            worstSide.fillPrice = result.fillPrice;
            worstSide.filled = true;
            logger.warn(`MM defensive: sold ${worstKey.toUpperCase()} ${worstShares.toFixed(3)} sh @ $${result.fillPrice.toFixed(3)}`);
        } else {
            worstSide.fillPrice = 0;
            worstSide.filled = true;
        }

        // Best side: let it resolve at market close (hold the tokens)
        // The market will resolve and we can redeem via the redeemer
        // Best side price is ~90c+ so payout ≈ $1 per share if it wins
        logger.money(`MM defensive: holding ${bestKey.toUpperCase()} ${bestShares.toFixed(3)} sh @ ~$${bestPrice.toFixed(3)} — waiting for resolution`);
        logger.info(`MM defensive: expected payout if ${bestKey.toUpperCase()} wins: ~$${bestShares.toFixed(2)} | cost was $${(bestSide.entryPrice * bestShares).toFixed(2)}`);

        // Mark best side as filled at entry price for now — actual payout handled by redeemer
        bestSide.fillPrice = bestSide.entryPrice;
        bestSide.filled = true;
        pos.status = 'done';

        const worstPnl = worstSide.fillPrice
            ? (worstSide.fillPrice - worstSide.entryPrice) * worstShares
            : 0;
        logger.info(`MM defensive: worst side P&L: $${worstPnl.toFixed(2)} | best side will be redeemed after resolution`);
    } else {
        // Worst side ≥ 10c → market uncertain, safer to merge
        logger.info(`MM defensive: worst side ${worstKey.toUpperCase()} @ $${worstPrice.toFixed(3)} ≥ $${threshold} — market uncertain, merging back to USDC`);
        await cutLossNeitherFilled(pos);
    }
}

async function adaptiveLegCL(pos, unfilledKey) {
    const s = pos[unfilledKey];
    const { tickSize, negRisk } = pos;
    const label  = pos.question.substring(0, 40);
    const pollMs = config.mmAdaptiveMonitorSec * 1000;

    // ── Minimum floor: unfilled leg must sell at least this price ──────────────
    // Ensures: filledLegPrice + unfilledLegPrice >= mmAdaptiveMinCombined
    // Example: filledLeg=0.60, minCombined=1.20 → floor=0.60
    //          filledLeg=0.55, minCombined=1.20 → floor=0.65
    const filledKey        = unfilledKey === 'yes' ? 'no' : 'yes';
    const filledLegPrice   = pos[filledKey].fillPrice ?? config.mmSellPrice;
    const minAdaptivePrice = Math.max(0, config.mmAdaptiveMinCombined - filledLegPrice);

    // ── Tiered floors (5m markets): progressively lower floor over time ────
    // breakevenFloor: filledLeg + unfilledLeg = $1.00 → zero net P&L
    const breakevenFloor = Math.max(0, 1.00 - filledLegPrice);
    const floorDrop      = config.mmDefensiveEnabled ? 0.10 : 0;
    const emergencyPrice = config.mmDefensiveWorstThreshold; // default 0.10

    const is5m = config.mmDuration === '5m';

    /**
     * Get the current floor based on time remaining (5m markets only).
     * Other durations use the fixed mmAdaptiveMinCombined floor.
     *
     * Phase 1 (> 180s left): breakevenFloor         (e.g. 0.40 for 60c fill)
     * Phase 2 (90–180s):     breakevenFloor - 0.10   (e.g. 0.30)
     * Phase 3 (30–90s):      breakevenFloor - 0.20   (e.g. 0.20)
     * Phase 4 (< 30s):       market sell
     */
    function getTieredFloor(msLeft) {
        if (!is5m) return minAdaptivePrice; // non-5m: use fixed floor
        if (msLeft > 180_000) return breakevenFloor;
        if (msLeft > 90_000)  return Math.max(0.01, breakevenFloor - floorDrop);
        if (msLeft > 30_000)  return Math.max(0.01, breakevenFloor - floorDrop * 2);
        return 0; // phase 4: market sell
    }

    logger.warn(`MM: one leg filled — starting adaptive CL for ${unfilledKey.toUpperCase()} | ${label}`);
    if (is5m) {
        logger.info(`MM adaptive CL: filled @ $${filledLegPrice.toFixed(3)} | breakeven floor: $${breakevenFloor.toFixed(3)} | tiered: $${breakevenFloor.toFixed(2)} → $${Math.max(0.01, breakevenFloor - floorDrop).toFixed(2)} → $${Math.max(0.01, breakevenFloor - floorDrop * 2).toFixed(2)}`);
    } else {
        logger.info(`MM adaptive CL: filled leg @ $${filledLegPrice.toFixed(3)} | min floor for combined ≥ $${config.mmAdaptiveMinCombined.toFixed(2)}: $${minAdaptivePrice.toFixed(3)}`);
    }

    // Cancel the unfilled leg's old GTC order immediately
    await cancelOrder(s.orderId);
    s.orderId = null;

    // Read actual on-chain balance once — reused for all subsequent sell orders
    const actualShares = await getTokenBalance(s.tokenId);
    const sellShares   = actualShares !== null ? actualShares : s.shares;

    if (sellShares < 0.001) {
        logger.warn(`MM adaptive CL: ${unfilledKey.toUpperCase()} balance is 0 — already fully sold`);
        s.fillPrice = config.mmSellPrice;
        s.filled    = true;
        pos.status  = 'done';
        return;
    }

    // If remaining shares below CLOB minimum, market sell immediately instead of trying limit
    if (sellShares < CLOB_MIN_ORDER_SHARES) {
        logger.warn(`MM adaptive CL: ${unfilledKey.toUpperCase()} remaining ${sellShares.toFixed(3)} shares < ${CLOB_MIN_ORDER_SHARES} minimum — market selling immediately`);
        const result   = await marketSell(s.tokenId, sellShares, tickSize, negRisk);
        s.fillPrice    = result.fillPrice;
        s.filled       = true;
        pos.status     = 'done';
        const pnl      = (s.fillPrice - s.entryPrice) * sellShares;
        const combined = filledLegPrice + s.fillPrice;
        logger.warn(`MM adaptive CL: ${unfilledKey.toUpperCase()} market-sold ${sellShares.toFixed(3)} sh @ $${s.fillPrice.toFixed(3)} | combined $${combined.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
        return;
    }

    // Place standing order at breakeven floor immediately (5m) so brief bounces get caught
    let activeOrderId    = null;
    let activeLimitPrice = 0;
    let currentFloor     = is5m ? breakevenFloor : minAdaptivePrice;

    if (is5m && sellShares >= CLOB_MIN_ORDER_SHARES) {
        // Check mid price first — place at market price (not just breakeven floor)
        const initMid = await getMidprice(s.tokenId);
        // Use mid price if above floor, otherwise use floor as safety net
        const initSellPrice = initMid >= currentFloor
            ? Math.min(initMid, config.mmSellPrice)
            : currentFloor;
        logger.info(`MM adaptive CL: mid=$${initMid.toFixed(3)}, placing initial limit sell @ $${initSellPrice.toFixed(3)} (floor=$${currentFloor.toFixed(3)})`);
        const standing = await placeLimitSell(s.tokenId, sellShares, initSellPrice, tickSize, negRisk);
        if (standing.success) {
            activeOrderId    = standing.orderId;
            activeLimitPrice = initSellPrice;
        }
    } else {
        logger.info(`MM adaptive CL: monitoring ${unfilledKey.toUpperCase()} — floor $${currentFloor.toFixed(3)}, market-sell at CL time`);
    }

    // ── Continuous monitoring loop ─────────────────────────────────────────────
    let lastPhaseLog = '';

    while (true) {
        const msLeft = new Date(pos.endTime).getTime() - Date.now();

        // ── Phase 4 / CL time: force market sell ────────────────────────────
        if (msLeft <= (is5m ? 30_000 : config.mmCutLossTime * 1000)) {
            if (activeOrderId) {
                await cancelOrder(activeOrderId);
                activeOrderId = null;
            }
            break;
        }

        // ── Update tiered floor ─────────────────────────────────────────────
        const newFloor = getTieredFloor(msLeft);
        if (newFloor !== currentFloor) {
            const phase = msLeft > 180_000 ? '1-breakeven' : msLeft > 90_000 ? '2-controlled' : '3-emergency';
            if (phase !== lastPhaseLog) {
                logger.info(`MM adaptive CL: phase ${phase} — floor $${currentFloor.toFixed(3)} → $${newFloor.toFixed(3)} (${Math.round(msLeft / 1000)}s left)`);
                lastPhaseLog = phase;
            }
            // If floor lowered and we have an active order above new floor, keep it
            // Only cancel+re-place if the floor dropped below our current limit
            if (activeOrderId && activeLimitPrice > newFloor) {
                // Current limit is above new floor — that's fine, keep it
            } else if (activeOrderId && activeLimitPrice < newFloor) {
                // Floor raised (shouldn't happen in tiered, but safety)
                await cancelOrder(activeOrderId);
                activeOrderId    = null;
                activeLimitPrice = 0;
            }
            currentFloor = newFloor;
        }

        // ── Check fill ──────────────────────────────────────────────────────
        if (activeOrderId) {
            let filled = false;
            if (config.dryRun) {
                const hitPrice = await simPriceHitTarget(s.tokenId);
                if (hitPrice) { filled = true; s.fillPrice = hitPrice; }
            } else {
                filled = await isOrderFilled(activeOrderId, sellShares);
                if (filled) s.fillPrice = activeLimitPrice;
            }

            if (filled) {
                const pnl      = (s.fillPrice - s.entryPrice) * sellShares;
                const combined = filledLegPrice + s.fillPrice;
                logger.money(`MM adaptive CL: ${unfilledKey.toUpperCase()} limit filled @ $${s.fillPrice.toFixed(3)} | combined $${combined.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
                s.filled   = true;
                pos.status = 'done';
                return;
            }
        }

        // ── Read current price ──────────────────────────────────────────────
        const currentPrice = await getMidprice(s.tokenId);
        if (currentPrice <= 0) {
            await sleep(pollMs);
            continue;
        }

        // ── Emergency cut: price < 10c in phase 3 → market sell immediately ─
        if (is5m && msLeft <= 90_000 && currentPrice < emergencyPrice) {
            logger.warn(`MM adaptive CL: EMERGENCY — price $${currentPrice.toFixed(3)} < $${emergencyPrice} with ${Math.round(msLeft / 1000)}s left — market selling now`);
            if (activeOrderId) {
                await cancelOrder(activeOrderId);
                activeOrderId = null;
            }
            break; // fall through to market sell below
        }

        const targetPrice = Math.min(currentPrice, config.mmSellPrice);

        // ── Adjust or cancel active limit ───────────────────────────────────
        if (activeOrderId) {
            const belowFloor    = currentPrice < currentFloor;
            const droppedHard   = currentPrice < activeLimitPrice * 0.95;
            const priceImproved = targetPrice > activeLimitPrice * 1.02;

            if (belowFloor || droppedHard) {
                const reason = belowFloor
                    ? `below floor $${currentFloor.toFixed(3)}`
                    : `dropped >5% from limit $${activeLimitPrice.toFixed(3)}`;
                logger.info(`MM adaptive CL: price $${currentPrice.toFixed(3)} ${reason} — cancelling limit, watching for recovery`);
                await cancelOrder(activeOrderId);
                activeOrderId    = null;
                activeLimitPrice = 0;

            } else if (priceImproved) {
                logger.info(`MM adaptive CL: price improved $${activeLimitPrice.toFixed(3)} → $${currentPrice.toFixed(3)} — raising limit to $${targetPrice.toFixed(3)}`);
                await cancelOrder(activeOrderId);
                activeOrderId    = null;
                activeLimitPrice = 0;
            }
        }

        // ── Place limit at floor or above ───────────────────────────────────
        if (!activeOrderId) {
            // Re-check actual balance — partial fills may have reduced it
            const currentBalance = await getTokenBalance(s.tokenId);
            const remainingShares = currentBalance !== null ? currentBalance : sellShares;

            if (remainingShares < 0.001) {
                logger.warn(`MM adaptive CL: ${unfilledKey.toUpperCase()} balance is 0 — fully sold via partial fills`);
                s.fillPrice = config.mmSellPrice;
                s.filled    = true;
                pos.status  = 'done';
                return;
            }

            if (remainingShares < CLOB_MIN_ORDER_SHARES) {
                logger.warn(`MM adaptive CL: ${unfilledKey.toUpperCase()} remaining ${remainingShares.toFixed(3)} shares < ${CLOB_MIN_ORDER_SHARES} minimum — market selling`);
                const result   = await marketSell(s.tokenId, remainingShares, tickSize, negRisk);
                s.fillPrice    = result.fillPrice;
                s.filled       = true;
                pos.status     = 'done';
                const pnl      = (s.fillPrice - s.entryPrice) * remainingShares;
                const combined = filledLegPrice + s.fillPrice;
                logger.warn(`MM adaptive CL: ${unfilledKey.toUpperCase()} market-sold ${remainingShares.toFixed(3)} sh @ $${s.fillPrice.toFixed(3)} | combined $${combined.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
                return;
            }

            // Place at max(currentPrice, floor) — standing order strategy
            const sellPrice = Math.max(currentPrice, currentFloor);
            const limitPrice = Math.min(sellPrice, config.mmSellPrice);

            if (currentPrice >= currentFloor || is5m) {
                // 5m: always place at floor or above (standing order catches bounces)
                // non-5m: only place when price >= floor
                logger.info(`MM adaptive CL: placing limit sell @ $${limitPrice.toFixed(3)} (mid: $${currentPrice.toFixed(3)}, floor: $${currentFloor.toFixed(3)}, ${Math.round(msLeft / 1000)}s left)`);
                const result = await placeLimitSell(s.tokenId, remainingShares, limitPrice, tickSize, negRisk);
                if (result.success) {
                    activeOrderId    = result.orderId;
                    activeLimitPrice = limitPrice;
                }
            } else {
                logger.info(`MM adaptive CL: price $${currentPrice.toFixed(3)} below floor $${currentFloor.toFixed(3)} — waiting for recovery (${Math.round(msLeft / 1000)}s left)`);
            }
        }

        await sleep(pollMs);
    }

    // ── Fallback: market sell at CL time ───────────────────────────────────────
    // Re-check actual balance before market sell (partial fills may have occurred)
    const finalBalance = await getTokenBalance(s.tokenId);
    const finalShares  = finalBalance !== null ? finalBalance : sellShares;

    if (finalShares < 0.001) {
        logger.warn(`MM adaptive CL: ${unfilledKey.toUpperCase()} balance is 0 at CL time — already fully sold`);
        s.fillPrice = config.mmSellPrice;
        s.filled    = true;
        pos.status  = 'done';
        return;
    }

    const exitReason = is5m ? 'phase 4 force exit (<30s)' : 'CL time reached';
    logger.warn(`MM adaptive CL: ${exitReason} — market-selling ${finalShares.toFixed(3)} ${unfilledKey.toUpperCase()} shares`);
    const result   = await marketSell(s.tokenId, finalShares, tickSize, negRisk);
    s.fillPrice    = result.fillPrice;
    const pnl      = (s.fillPrice - s.entryPrice) * finalShares;
    const combined = filledLegPrice + s.fillPrice;
    logger.warn(`MM adaptive CL: ${unfilledKey.toUpperCase()} market-sold @ $${s.fillPrice.toFixed(3)} | combined $${combined.toFixed(3)} | sold ${finalShares.toFixed(3)} sh | P&L $${pnl.toFixed(2)}`);

    s.filled   = true;
    pos.status = 'done';
}

// ── Recovery buy ──────────────────────────────────────────────────────────────

/**
 * After a cut-loss, optionally take a directional bet on the dominant side.
 *
 * Criteria (all must pass):
 *   1. MM_RECOVERY_BUY=true in .env
 *   2. One side's price is above MM_RECOVERY_THRESHOLD (default 70%)
 *   3. That price is stable or rising over a 10-second sample (1 fetch/second)
 *   4. Wallet balance is sufficient for the recovery size
 */
async function attemptRecoveryBuy(pos) {
    if (!config.mmRecoveryBuy) return;

    const { tickSize, negRisk } = pos;
    const label = pos.question.substring(0, 40);
    const recoverySize = config.mmRecoverySize > 0 ? config.mmRecoverySize : config.mmTradeSize;
    const client = getClient();

    logger.info(`MM recovery: monitoring prices for 10s | ${label}`);

    // ── Sample both sides once per second for 10 seconds ─────────
    const samples = { yes: [], no: [] };

    for (let i = 0; i < 10; i++) {
        for (const [key, tokenId] of [['yes', pos.yes.tokenId], ['no', pos.no.tokenId]]) {
            try {
                const mp    = await client.getMidpoint(tokenId);
                const price = parseFloat(mp?.mid ?? mp ?? '0') || 0;
                samples[key].push(price);
            } catch { /* skip */ }
        }
        if (i < 9) await sleep(1000);
    }

    // ── Determine eligible side ───────────────────────────────────
    // Need: last price ≥ threshold AND last price ≥ first price (not declining)
    let candidate = null;
    for (const [key, tokenId] of [['yes', pos.yes.tokenId], ['no', pos.no.tokenId]]) {
        const arr = samples[key];
        if (arr.length < 2) continue;

        const firstPrice = arr[0];
        const lastPrice  = arr[arr.length - 1];

        if (lastPrice >= config.mmRecoveryThreshold && lastPrice >= firstPrice) {
            candidate = { side: key.toUpperCase(), tokenId, price: lastPrice };
            break;
        }
    }

    if (!candidate) {
        logger.info(`MM recovery: no eligible side — need price ≥ ${config.mmRecoveryThreshold} and rising/stable`);
        return;
    }

    // ── Balance check ─────────────────────────────────────────────
    if (!config.dryRun) {
        const balance = await getUsdcBalance();
        if (balance < recoverySize) {
            logger.warn(`MM recovery: insufficient balance $${balance.toFixed(2)} < $${recoverySize} needed`);
            return;
        }
    }

    logger.trade(`MM recovery${config.dryRun ? '[SIM]' : ''}: buying ${candidate.side} @ $${candidate.price.toFixed(3)} | size $${recoverySize}`);

    // ── Market buy ────────────────────────────────────────────────
    let entryPrice = candidate.price;
    let filledShares = recoverySize / entryPrice; // default estimate

    if (config.dryRun) {
        logger.money(`MM recovery[SIM]: bought ${filledShares.toFixed(3)} ${candidate.side} @ $${entryPrice.toFixed(3)}`);
    } else {
        try {
            const res = await client.createAndPostMarketOrder(
                { tokenID: candidate.tokenId, side: Side.BUY, amount: recoverySize, price: 0.99 },
                { tickSize, negRisk },
                OrderType.FOK,
            );
            if (!res?.success) {
                logger.warn(`MM recovery: order not filled — ${res?.errorMsg || 'no fill'}`);
                return;
            }
            entryPrice   = parseFloat(res.price || String(candidate.price));
            filledShares = parseFloat(res.takingAmount || String(recoverySize / entryPrice));
            logger.money(`MM recovery: FILLED ${candidate.side} ${filledShares.toFixed(3)} sh @ $${entryPrice.toFixed(3)} | potential payout $${filledShares.toFixed(2)}`);
        } catch (err) {
            logger.error(`MM recovery: buy error — ${err.message}`);
            return;
        }
    }

    // ── Monitor for 30s — cut loss if price worsens ───────────────
    logger.info(`MM recovery: holding ${candidate.side} — will cut if price < $${entryPrice.toFixed(3)} after 30s`);
    await sleep(30_000);

    // Skip second CL if market is already closed or about to close (< 5s left)
    const msLeft = new Date(pos.endTime).getTime() - Date.now();
    if (msLeft < 5_000) {
        logger.info(`MM recovery: market closing — skipping 2nd CL, letting position resolve`);
        return;
    }

    // Check current price
    let currentPrice = entryPrice;
    try {
        const mp   = await client.getMidpoint(candidate.tokenId);
        currentPrice = parseFloat(mp?.mid ?? mp ?? String(entryPrice)) || entryPrice;
    } catch { /* use entryPrice as fallback */ }

    if (currentPrice >= entryPrice) {
        logger.success(`MM recovery: price holding $${currentPrice.toFixed(3)} ≥ entry $${entryPrice.toFixed(3)} — keeping position`);
        return;
    }

    // Price has worsened — cut loss
    const priceDrop = ((entryPrice - currentPrice) / entryPrice * 100).toFixed(1);
    logger.warn(`MM recovery: price dropped $${entryPrice.toFixed(3)} → $${currentPrice.toFixed(3)} (-${priceDrop}%) — cutting loss`);

    if (config.dryRun) {
        const simPnl = (currentPrice - entryPrice) * filledShares;
        logger.warn(`MM recovery[SIM]: 2nd CL @ $${currentPrice.toFixed(3)} | P&L $${simPnl.toFixed(2)}`);
        return;
    }

    try {
        const sellRes = await client.createAndPostMarketOrder(
            { tokenID: candidate.tokenId, side: Side.SELL, amount: filledShares, price: 0.01 },
            { tickSize, negRisk },
            OrderType.FOK,
        );
        if (sellRes?.success) {
            const sellPrice = parseFloat(sellRes.price || String(currentPrice));
            const pnl = (sellPrice - entryPrice) * filledShares;
            logger.warn(`MM recovery: 2nd CL sold @ $${sellPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
        } else {
            logger.warn(`MM recovery: 2nd CL sell failed — ${sellRes?.errorMsg || 'no fill'} — position will resolve at close`);
        }
    } catch (err) {
        logger.error(`MM recovery: 2nd CL sell error — ${err.message}`);
    }
}

function calcPnl(pos) {
    const yesPnl = pos.yes.filled
        ? (pos.yes.fillPrice - pos.yes.entryPrice) * pos.yes.shares
        : 0;
    const noPnl = pos.no.filled
        ? (pos.no.fillPrice - pos.no.entryPrice) * pos.no.shares
        : 0;
    return yesPnl + noPnl;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function executeMMStrategy(market) {
    const { asset, conditionId, question, endTime, yesTokenId, noTokenId, negRisk, tickSize } = market;
    const tag   = asset ? `[${asset.toUpperCase()}]` : '';
    const label = question.substring(0, 40);
    const sim = config.dryRun ? '[SIM] ' : '';

    logger.info(`MM${tag}: ${sim}entering — ${label}`);

    // ── Balance check ───────────────────────────────────────────
    const totalNeeded = config.mmTradeSize * 2; // $10 total → 10 YES + 10 NO
    if (!config.dryRun) {
        const balance = await getUsdcBalance();
        if (balance < totalNeeded) {
            logger.error(`MM${tag}: insufficient balance $${balance.toFixed(2)} (need $${totalNeeded})`);
            return;
        }
    }

    // ── Split USDC into YES+NO via CTF splitPosition ────────────
    // Deposit mmTradeSize*2 USDC → get mmTradeSize*2 YES + mmTradeSize*2 NO tokens
    // Entry price is exactly $0.50 per token on both sides (no spread, no slippage)
    logger.trade(`MM${tag}: ${sim}splitPosition $${totalNeeded} USDC → YES + NO @ $0.50`);
    let shares;
    try {
        shares = await splitPosition(conditionId, totalNeeded, negRisk);
    } catch (err) {
        logger.error(`MM${tag}: splitPosition failed — ${err.message}`);
        return;
    }

    const entryPrice = 0.50;
    logger.info(`MM${tag}: split done — ${shares} YES + ${shares} NO @ $${entryPrice}`);

    // ── Place limit sells (parallel) ────────────────────────────
    logger.info(`MM${tag}: ${sim}placing limit sells @ $${config.mmSellPrice}`);
    const [yesSell, noSell] = await Promise.all([
        placeLimitSell(yesTokenId, shares, config.mmSellPrice, tickSize, negRisk),
        placeLimitSell(noTokenId, shares, config.mmSellPrice, tickSize, negRisk),
    ]);

    if (!yesSell.success || !noSell.success) {
        logger.error(`MM${tag}: failed to place limit sells — cutting immediately`);
    }

    // ── Build position object ───────────────────────────────────
    const pos = {
        asset: asset || 'btc',
        conditionId,
        question,
        endTime,
        tickSize,
        negRisk,
        status: 'monitoring',
        enteredAt: new Date().toISOString(),
        yes: {
            tokenId: yesTokenId,
            shares,
            entryPrice,
            entryCost: config.mmTradeSize,  // $5 per side
            orderId: yesSell.orderId,
            filled: !yesSell.success,    // mark as needing cut if sell failed
            fillPrice: null,
        },
        no: {
            tokenId: noTokenId,
            shares,
            entryPrice,
            entryCost: config.mmTradeSize,
            orderId: noSell.orderId,
            filled: !noSell.success,
            fillPrice: null,
        },
    };

    activePositions.set(conditionId, pos);

    // ── Monitor (runs until done/cut/expired) ───────────────────
    await monitorAndManage(pos);

    activePositions.delete(conditionId);
}
