/**
 * makerRebateExecutor.js
 * Simplified Maker Rebate MM strategy:
 *   1. Fetch YES orderbook
 *   2. Deduce NO price from YES (YES + NO ≈ $1.00)
 *   3. Place BUY limit once on both sides (NO repricing)
 *   4. Wait for 100% fill with SAME share count on both sides
 *   5. Merge YES+NO → $1.00 USDC → profit + maker rebates
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getClient, getUsdcBalance, getPolygonProvider } from './client.js';
import { mergePositions, redeemPositions } from './ctf.js';
import { mmFillWatcher } from './mmWsFillWatcher.js';
import logger from '../utils/logger.js';

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_BALANCE_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
const CLOB_MIN_ORDER_SHARES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Price range limits — configurable via MAKER_MM_MIN_PRICE / MAKER_MM_MAX_PRICE
// Both sides must be within this range to qualify for maker rebates
const getMinPrice = () => config.makerMmMinPrice;
const getMaxPrice = () => config.makerMmMaxPrice;

const activePositions = new Map();
export function getActiveMakerPositions() {
    return Array.from(activePositions.values());
}

// Export for use in maker-mm-bot.js
export { getMarketOdds };

// ── Price helpers ────────────────────────────────────────────────────────────

async function getRealPrice(tokenId) {
    const client = getClient();
    try {
        const result = await client.getPrice(tokenId, 'BUY');
        const price = parseFloat(result?.price ?? result ?? '0');
        if (price > 0 && price < 1) return price;
    } catch (err) {
        logger.warn(`MakerMM: getPrice error — ${err.message}`);
    }
    try {
        const mp = await client.getMidpoint(tokenId);
        const price = parseFloat(mp?.mid ?? mp ?? '0');
        if (price > 0 && price < 1) return price;
    } catch {}
    return null;
}

function roundToTick(price, tickSize) {
    const ts = parseFloat(tickSize);
    const rounded = Math.round(price / ts) * ts;
    const decimals = tickSize.toString().split('.')[1]?.length || 2;
    return Math.max(0.01, Math.min(0.99, parseFloat(rounded.toFixed(decimals))));
}

// ── Get best ask via getPrice(SELL) — the lowest price a seller will accept ────
// Used as a safety cap to ensure our bid never crosses the ask (taker prevention).
async function getBestAsk(tokenId) {
    const client = getClient();
    try {
        const result = await client.getPrice(tokenId, 'SELL');
        const price = parseFloat(result?.price ?? result ?? '0');
        return (price > 0 && price < 1) ? price : null;
    } catch (err) {
        logger.warn(`MakerMM: getBestAsk error — ${err.message}`);
        return null;
    }
}

// ── Bid-based repricing ───────────────────────────────────────────────────────
// ── Get current market odds ──────────────────────────────────────────────────
async function getMarketOdds(yesTokenId, noTokenId) {
    try {
        const [yesPrice, noPrice] = await Promise.all([
            getRealPrice(yesTokenId),
            getRealPrice(noTokenId),
        ]);

        if (yesPrice && noPrice) {
            return { yes: yesPrice, no: noPrice, max: Math.max(yesPrice, noPrice) };
        }
    } catch (err) {
        logger.warn(`MakerMM: getMarketOdds error — ${err.message}`);
    }
    return null;
}

// ── Order helpers ────────────────────────────────────────────────────────────

/**
 * Check order status via CLOB API
 * Returns true if order is filled (even if createAndPostOrder returned false)
 */
async function checkOrderStatus(orderId) {
    if (!orderId || orderId.startsWith('filled-') || orderId.startsWith('sim-')) return null;

    try {
        const client = getClient();
        const order = await client.getOrder(orderId);

        // Order might be: OPEN, FILLED, PARTIAL_FILLED, CANCELLED, etc.
        if (order?.status === 'FILLED' || order?.status === 'FILLED_FULLY') {
            return 'filled';
        }
        if (order?.status === 'PARTIAL_FILLED' || order?.status === 'FILLED_PARTIALLY') {
            return 'partial';
        }
        if (order?.status === 'CANCELLED' || order?.status === 'CANCELLED_BY_USER' || order?.status === 'EXPIRED') {
            return 'cancelled';
        }
        if (order?.status === 'OPEN') {
            return 'open';
        }
    } catch (err) {
        // Order not found or API error - consider as unknown
        logger.debug(`MakerMM: order status check failed for ${orderId?.slice(-8)} — ${err.message}`);
    }
    return 'unknown';
}

// ── Market sell ───────────────────────────────────────────────────────────────
// Verifies onchain balance after each attempt — CLOB fill confirmation alone is
// not enough because sells can also be ghost-filled (CLOB says done, txhash invalid,
// shares still in wallet). Retries up to 3 times with onchain verification.
async function marketSellToken(tokenId, shares, tickSize, negRisk, tag) {
    if (config.dryRun) {
        logger.info(`MakerMM${tag}: [SIM] would market-sell ${shares.toFixed(4)} shares of token ${tokenId.slice(-8)}`);
        return true;
    }

    const client = getClient();
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Snapshot balance before sell — source of truth for whether it went through
        const balanceBefore = (await getTokenBalance(tokenId)) ?? 0;
        if (balanceBefore < 0.01) {
            logger.info(`MakerMM${tag}: sell skipped — balance already 0`);
            return true;
        }

        const sharesToSell = Math.min(shares, balanceBefore);

        let refPrice = 0.01;
        try {
            const bidResult = await client.getPrice(tokenId, 'BUY');
            const bid = parseFloat(bidResult?.price ?? bidResult ?? '0');
            if (bid > 0) refPrice = Math.max(bid * 0.97, 0.01);
        } catch {}

        try {
            const response = await client.createAndPostMarketOrder(
                { tokenID: tokenId, side: Side.SELL, amount: sharesToSell, price: refPrice },
                { tickSize, negRisk },
                OrderType.FAK,
            );

            if (!response?.success || parseFloat(response?.takingAmount || '0') === 0) {
                logger.warn(`MakerMM${tag}: sell attempt ${attempt}/${maxAttempts} — CLOB rejected (${response?.errorMsg || 'no liquidity'})`);
                await sleep(3000);
                continue;
            }

            // CLOB says filled — wait then verify onchain balance actually decreased
            await sleep(8000);
            const balanceAfter = (await getTokenBalance(tokenId)) ?? balanceBefore;
            const sold = balanceBefore - balanceAfter;

            if (sold >= sharesToSell * 0.5) {
                logger.money(`MakerMM${tag}: sold ${sold.toFixed(4)} shares @ ~$${refPrice.toFixed(3)} (attempt ${attempt})`);
                return true;
            }

            // Balance unchanged → ghost sell, retry
            logger.warn(`MakerMM${tag}: sell attempt ${attempt}/${maxAttempts} ghost — CLOB filled but ${balanceAfter.toFixed(4)} shares still onchain, retrying...`);
            await sleep(5000 * attempt);

        } catch (err) {
            logger.error(`MakerMM${tag}: sell attempt ${attempt}/${maxAttempts} error — ${err.message}`);
            await sleep(3000);
        }
    }

    logger.warn(`MakerMM${tag}: sell failed after ${maxAttempts} attempts — shares remain in wallet (will resolve at market close)`);
    return false;
}

// ── Ghost fill recovery ───────────────────────────────────────────────────────
// Onchain balance doesn't match what CLOB says was filled (partial or full ghost).
// Strategy: merge whatever paired shares exist, then market-sell any unpaired remainder.
// Handles all partial amounts — caller passes actual onchain balances.
async function recoverFromGhostFill(pos, yesShares, noShares, tag) {
    logger.warn(
        `MakerMM${tag}: ghost fill recovery — onchain YES=${yesShares.toFixed(4)} NO=${noShares.toFixed(4)} ` +
        `(expected ${pos.targetShares} each)`
    );

    const mergeable = Math.floor(Math.min(yesShares, noShares) * 10000) / 10000;
    let mergeRecovered = 0;

    if (mergeable >= 1) {
        try {
            await mergePositions(pos.conditionId, mergeable, pos.negRisk);
            mergeRecovered = mergeable;
            logger.money(`MakerMM${tag}: ghost recovery merge ${mergeable.toFixed(4)} pairs → $${mergeRecovered.toFixed(2)}`);
        } catch (err) {
            logger.error(`MakerMM${tag}: ghost recovery merge failed — ${err.message}`);
        }
    }

    const yesRemainder = parseFloat(Math.max(0, yesShares - mergeable).toFixed(6));
    const noRemainder  = parseFloat(Math.max(0, noShares  - mergeable).toFixed(6));

    if (yesRemainder >= 1) {
        await marketSellToken(pos.yes.tokenId, yesRemainder, pos.tickSize, pos.negRisk, tag);
    }
    if (noRemainder >= 1) {
        await marketSellToken(pos.no.tokenId, noRemainder, pos.tickSize, pos.negRisk, tag);
    }

    pos.totalProfit = mergeRecovered - (pos.yes.cost + pos.no.cost);
    pos.status = 'done';
}

async function placeLimitBuy(tokenId, shares, price, tickSize, negRisk) {
    if (config.dryRun) {
        return { success: true, orderId: `sim-buy-${Date.now()}-${tokenId.slice(-6)}` };
    }
    const client = getClient();
    try {
        const res = await client.createAndPostOrder(
            { tokenID: tokenId, side: Side.BUY, price, size: shares },
            { tickSize, negRisk },
            OrderType.GTC,
        );
        if (!res?.success) {
            logger.error(`MakerMM: limit buy failed — response: ${JSON.stringify(res)}`);
            return { success: false };
        }
        return { success: true, orderId: res.orderID };
    } catch (err) {
        logger.error(`MakerMM: limit buy error — ${err.message}`);
        return { success: false };
    }
}

async function cancelOrder(orderId) {
    if (config.dryRun || !orderId || orderId.startsWith('sim-')) return true;
    try {
        const client = getClient();
        await client.cancelOrder({ orderID: orderId });
        return true;
    } catch (err) {
        logger.warn(`MakerMM: cancel error — ${err.message}`);
        return false;
    }
}

// ── Fill detection ───────────────────────────────────────────────────────────

async function getTokenBalance(tokenId) {
    try {
        const provider = getPolygonProvider(); // singleton — no await needed
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_BALANCE_ABI, provider);
        const raw = await ctf.balanceOf(config.proxyWallet, tokenId);
        return parseFloat(ethers.utils.formatUnits(raw, 6));
    } catch { return null; }
}

function waitForFillOrTimeout(tokenIds, timeoutMs) {
    return new Promise((resolve) => {
        let timer;
        const onFill = (event) => {
            if (tokenIds.includes(event.tokenId)) {
                clearTimeout(timer);
                mmFillWatcher.removeListener('fill', onFill);
                resolve(event);
            }
        };
        mmFillWatcher.on('fill', onFill);
        timer = setTimeout(() => {
            mmFillWatcher.removeListener('fill', onFill);
            resolve(null);
        }, timeoutMs);
    });
}

// ── Core monitoring ───────────────────────────────────────────────────────────

async function monitorUntilFilled(pos, tag, label) {
    mmFillWatcher.watch(pos.yes.tokenId);
    mmFillWatcher.watch(pos.no.tokenId);

    // WS fill events: early signal only — onchain balance is the source of truth.
    // Side filter removed: RTDS may report side from taker perspective (SELL),
    // not our maker perspective. We're already gated by proxyWallet + tokenId.
    const onWsFill = (event) => {
        // WS is used only as a wake-up signal — do NOT set pos.filled here.
        // Setting filled=true from WS on a partial fill (e.g. 2 of 5 shares) would
        // make the loop think the side is done and skip the onchain balance check,
        // leaving the position stuck. Onchain balance is the sole source of truth.
        if (event.tokenId === pos.yes.tokenId) {
            logger.money(`MakerMM${tag}: YES fill signal (WS) ${event.size?.toFixed(2) || '?'} @ $${event.price?.toFixed(3) || pos.yes.buyPrice.toFixed(3)}`);
        }
        if (event.tokenId === pos.no.tokenId) {
            logger.money(`MakerMM${tag}: NO fill signal (WS) ${event.size?.toFixed(2) || '?'} @ $${event.price?.toFixed(3) || pos.no.buyPrice.toFixed(3)}`);
        }
    };
    mmFillWatcher.on('fill', onWsFill);

    // Brief pause to let WebSocket register token subscriptions
    await sleep(50);

    try {
        let fastFillCheckCount = 0;
        const maxFastChecks = 10; // 1s polling for first 10s

        while (true) {
            // Safety guard: exit immediately if resolved by any path
            if (pos.status === 'done') return;

            // ── Onchain balance — source of truth, checked FIRST ──────────────
            const [yesBal, noBal] = await Promise.all([
                getTokenBalance(pos.yes.tokenId),
                getTokenBalance(pos.no.tokenId),
            ]);

            // NET new shares only — subtract baseline to exclude leftover tokens
            // from previous cycles on the same tokenId. Without this, re-entry
            // would see old balance >= 0.5x target and trigger a false early merge
            // while the new orders are still open in the orderbook.
            // Use toFixed(6) — full precision to avoid rounding UP past actual token balance.
            // toFixed(4) could round 4.910199 → 4.9102 (4910200 wei) when Safe has 4910199 → revert.
            const yesShares = parseFloat(Math.max(0, (yesBal || 0) - pos.yes.baseline).toFixed(6));
            const noShares = parseFloat(Math.max(0, (noBal || 0) - pos.no.baseline).toFixed(6));

            // Sync fill flags from onchain (source of truth)
            if (!pos.yes.filled && yesShares >= pos.targetShares * 0.99) {
                pos.yes.filled = true;
                logger.money(`MakerMM${tag}: YES filled (onchain) ${yesShares.toFixed(4)} shares`);
            }
            if (!pos.no.filled && noShares >= pos.targetShares * 0.99) {
                pos.no.filled = true;
                logger.money(`MakerMM${tag}: NO filled (onchain) ${noShares.toFixed(4)} shares`);
            }

            // ── Cancel cheap side when expensive fills first ──────────────────────
            // When enabled: if the expensive side fills and cheap side hasn't,
            // cancel the cheap order and hold the expensive token to redeem at resolution.
            if (config.makerMmCancelCheapOnExpFill) {
                const expSide  = pos.yes.buyPrice >= pos.no.buyPrice ? 'yes' : 'no';
                const cheapSide = expSide === 'yes' ? 'no' : 'yes';
                if (pos[expSide].filled && !pos[cheapSide].filled) {
                    logger.info(
                        `MakerMM${tag}: ${expSide.toUpperCase()} ($${pos[expSide].buyPrice}) filled first — ` +
                        `cancelling cheap ${cheapSide.toUpperCase()} ($${pos[cheapSide].buyPrice}) order`
                    );
                    await cancelOrder(pos[cheapSide].orderId);
                    pos.holdingSide = expSide;
                    pos.status = 'holding';
                    return;
                }
            }

            // ── Over-position safety net ────────────────────────────────────────
            // If one side's balance is > 1.5x target AND the current order is still open,
            // a double-fill occurred (old cancelled order + new order both filled).
            // Cancel the open order immediately so it doesn't also fill.
            if (yesShares > pos.targetShares * 1.5 && pos.yes.orderId && !pos.yes.filled) {
                logger.warn(`MakerMM${tag}: YES over-position (${yesShares.toFixed(4)} > 1.5x target=${pos.targetShares}) — cancelling open order to stop double-fill`);
                await cancelOrder(pos.yes.orderId);
                pos.yes.filled = true;
                if (!pos.firstFillTime) pos.firstFillTime = Date.now();
            }
            if (noShares > pos.targetShares * 1.5 && pos.no.orderId && !pos.no.filled) {
                logger.warn(`MakerMM${tag}: NO over-position (${noShares.toFixed(4)} > 1.5x target=${pos.targetShares}) — cancelling open order to stop double-fill`);
                await cancelOrder(pos.no.orderId);
                pos.no.filled = true;
                if (!pos.firstFillTime) pos.firstFillTime = Date.now();
            }

            // ── Ghost fill detection via open orders check ────────────────────────
            // More reliable than checkOrderStatus(orderId) which can return 'unknown'
            // for ghost fills (invalid txhash → CLOB state is inconsistent).
            // If our order is gone from open orders but onchain balance didn't increase
            // → order was matched in CLOB but settlement failed (ghost fill).
            {
                const nowMs = Date.now();
                const client = getClient();

                if (!pos.yes.filled && !pos.yes.clobFilled && pos.yes.orderId && nowMs - (pos.yes.lastClobCheck || 0) >= 15_000) {
                    pos.yes.lastClobCheck = nowMs;
                    try {
                        const openOrders = await client.getOpenOrders({ asset_id: pos.yes.tokenId });
                        const stillOpen = Array.isArray(openOrders) && openOrders.some(o => (o.id ?? o.order_id) === pos.yes.orderId);
                        if (!stillOpen) {
                            pos.yes.clobFilled = true;
                            logger.info(`MakerMM${tag}: YES order gone from CLOB open orders (onchain not yet reflected)`);
                        }
                    } catch {}
                }
                if (!pos.no.filled && !pos.no.clobFilled && pos.no.orderId && nowMs - (pos.no.lastClobCheck || 0) >= 15_000) {
                    pos.no.lastClobCheck = nowMs;
                    try {
                        const openOrders = await client.getOpenOrders({ asset_id: pos.no.tokenId });
                        const stillOpen = Array.isArray(openOrders) && openOrders.some(o => (o.id ?? o.order_id) === pos.no.orderId);
                        if (!stillOpen) {
                            pos.no.clobFilled = true;
                            logger.info(`MakerMM${tag}: NO order gone from CLOB open orders (onchain not yet reflected)`);
                        }
                    } catch {}
                }

                // Ghost fill detection:
                // CLOB says order is FILLED but onchain balance < expected after timeout.
                // Could be full ghost (0 tokens) or partial (some tokens, but not all).
                // Trigger: either side clobFilled AND onchain short of target after 60s.
                const yesGhost = pos.yes.clobFilled && yesShares < pos.targetShares * 0.99;
                const noGhost  = pos.no.clobFilled  && noShares  < pos.targetShares * 0.99;

                if (yesGhost || noGhost) {
                    if (!pos.ghostFillSince) pos.ghostFillSince = nowMs;
                    const waitedSec = Math.round((nowMs - pos.ghostFillSince) / 1000);
                    if (waitedSec >= 30) {
                        // 30s is enough to distinguish settlement delay from ghost fill.
                        // Act now while market prices are still fair — don't wait for cut-loss.
                        await recoverFromGhostFill(pos, yesShares, noShares, tag);
                        return;
                    } else {
                        logger.info(
                            `MakerMM${tag}: ghost fill suspected ` +
                            `(YES CLOB=${pos.yes.clobFilled} onchain=${yesShares.toFixed(4)}, ` +
                            `NO CLOB=${pos.no.clobFilled} onchain=${noShares.toFixed(4)}) ` +
                            `— waiting ${waitedSec}s / 30s`
                        );
                    }
                }
            }

            // ── WS fallback: both sides WS-confirmed filled but onchain RPC not reflecting ──
            // If onchain balance is unavailable (RPC slow/failed) but both filled flags are
            // set from WS signals, wait a grace period then merge with targetShares as fallback.
            if (pos.yes.filled && pos.no.filled && yesShares < pos.targetShares * 0.5 && noShares < pos.targetShares * 0.5) {
                if (!pos.bothFilledSince) pos.bothFilledSince = Date.now();
                const waitedSec = Math.round((Date.now() - pos.bothFilledSince) / 1000);
                if (waitedSec >= 15) {
                    logger.warn(
                        `MakerMM${tag}: both sides WS-filled but onchain shows YES=${yesShares} NO=${noShares} after ${waitedSec}s ` +
                        `— RPC may be stale, merging with target ${pos.targetShares} shares`
                    );
                    await executeMerge(pos, pos.targetShares, tag);
                    if (pos.status === 'done') return;
                } else {
                    logger.info(`MakerMM${tag}: both WS-filled, waiting for onchain confirmation (${waitedSec}s / 15s grace)...`);
                }
            }

            // Both sides have net balance ≥ 50% target → merge
            if (yesShares >= pos.targetShares * 0.5 && noShares >= pos.targetShares * 0.5) {
                pos.bothFilledSince = null; // onchain confirmed — clear WS fallback timer
                const minShares = Math.min(yesShares, noShares);
                const isFull = yesShares >= pos.targetShares * 0.99 && noShares >= pos.targetShares * 0.99;
                logger.success(
                    `MakerMM${tag}: ${isFull ? 'FULL' : 'PARTIAL'} fill — ` +
                    `YES=${yesShares.toFixed(4)} NO=${noShares.toFixed(4)}, merging ${minShares.toFixed(4)} shares`
                );
                pos.yes.filled = true;
                pos.no.filled = true;
                await executeMerge(pos, minShares, tag);
                if (pos.status === 'done') return;

                // Merge call errored — but tx may have confirmed onchain despite the RPC error
                // (common: tx.wait() timeout while tx was already included in a block).
                // Re-check balance to avoid looping forever on an empty position.
                const [yesRecheck, noRecheck] = await Promise.all([
                    getTokenBalance(pos.yes.tokenId),
                    getTokenBalance(pos.no.tokenId),
                ]);
                const yesNetRecheck = Math.max(0, (yesRecheck || 0) - pos.yes.baseline);
                const noNetRecheck = Math.max(0, (noRecheck || 0) - pos.no.baseline);
                if (yesNetRecheck < pos.targetShares * 0.1 && noNetRecheck < pos.targetShares * 0.1) {
                    logger.success(`MakerMM${tag}: merge confirmed onchain (RPC reported error but tx went through)`);
                    pos.status = 'done';
                    pos.totalProfit = minShares - (pos.yes.cost + pos.no.cost);
                    return;
                }
                pos.mergeFailCount = (pos.mergeFailCount || 0) + 1;
                const backoffSec = Math.min(5 * pos.mergeFailCount, 30); // 5s, 10s, 15s … max 30s
                logger.warn(`MakerMM${tag}: merge failed (attempt ${pos.mergeFailCount}) — tokens still present (YES=${yesNetRecheck.toFixed(6)} NO=${noNetRecheck.toFixed(6)}), retrying in ${backoffSec}s`);
                await sleep(backoffSec * 1000);
            }

            // ── Cut-loss check (AFTER balance check) ──────────────────────────
            const msRemaining = new Date(pos.endTime).getTime() - Date.now();
            if (msRemaining <= config.makerMmCutLossTime * 1000) {
                logger.warn(`MakerMM${tag}: cut-loss — net YES=${yesShares.toFixed(4)} NO=${noShares.toFixed(4)}`);

                if (yesShares >= 1 && noShares >= 1) {
                    // Both sides have net fills — emergency merge to recover USDC
                    const minShares = Math.min(yesShares, noShares);
                    logger.warn(`MakerMM${tag}: emergency merge ${minShares.toFixed(4)} shares`);
                    await executeMerge(pos, minShares, tag);
                } else {
                    // One or neither side net-filled — cancel open orders, log held tokens
                    await Promise.all([
                        cancelOrder(pos.yes.orderId),
                        cancelOrder(pos.no.orderId),
                    ]);
                    if (yesShares > 0 || noShares > 0) {
                        logger.warn(`MakerMM${tag}: tokens held — net YES=${yesShares.toFixed(4)} NO=${noShares.toFixed(4)} (cannot merge)`);
                        pos.totalProfit = -((yesShares > 0 ? pos.yes.cost : 0) + (noShares > 0 ? pos.no.cost : 0));
                        pos.oneSided = true; // flag: cycle ended with one-sided fill
                    } else {
                        logger.info(`MakerMM${tag}: no net fills — orders cancelled, zero loss`);
                        pos.totalProfit = 0;
                    }
                    pos.status = 'done';
                }
                return;
            }

            // ── One side filled — log status and keep waiting ─────────────────
            if (pos.yes.filled !== pos.no.filled) {
                const filledKey = pos.yes.filled ? 'yes' : 'no';
                const now = Date.now();

                if (now < pos.marketOpenTime) {
                    logger.info(`MakerMM${tag}: ${filledKey.toUpperCase()} filled — market not open yet (${Math.round((pos.marketOpenTime - now) / 1000)}s), waiting...`);
                } else {
                    if (!pos.firstFillTime) {
                        pos.firstFillTime = now;
                        logger.info(`MakerMM${tag}: ${filledKey.toUpperCase()} filled first — waiting for other side...`);
                    } else {
                        const elapsedMin = Math.floor((now - pos.firstFillTime) / 60000);
                        if (elapsedMin > 0 && elapsedMin % 5 === 0 && pos.lastLogMin !== elapsedMin) {
                            pos.lastLogMin = elapsedMin;
                            logger.info(`MakerMM${tag}: still waiting for ${filledKey === 'yes' ? 'NO' : 'YES'} — ${elapsedMin}m elapsed`);
                        }
                    }
                }
            }

            // Fast polling first 10s, then event-driven with 5s fallback
            fastFillCheckCount++;
            if (fastFillCheckCount < maxFastChecks) {
                await sleep(1000);
            } else {
                await waitForFillOrTimeout([pos.yes.tokenId, pos.no.tokenId], 5000);
            }
        }
    } finally {
        mmFillWatcher.removeListener('fill', onWsFill);
        mmFillWatcher.unwatch(pos.yes.tokenId);
        mmFillWatcher.unwatch(pos.no.tokenId);

        // Cancel any residual open orders — can happen when loss-compensating reprice
        // placed extra shares (e.g. 6 NO) but merge triggered after 5 filled,
        // leaving 1 remaining NO share still open in the orderbook.
        await Promise.all([
            cancelOrder(pos.yes.orderId),
            cancelOrder(pos.no.orderId),
        ]).catch(() => {});
    }
}

async function executeMerge(pos, shares, tag) {
    const totalCost = pos.yes.cost + pos.no.cost;
    const recovered = shares; // Merge returns $1 per share
    pos.totalProfit = recovered - totalCost;

    try {
        await mergePositions(pos.conditionId, shares, pos.negRisk);

        // Orders are already fully filled at this point — no cancel needed
        logger.money(`MakerMM${tag}: MERGED ${shares.toFixed(4)} shares → $${recovered.toFixed(2)} | cost $${totalCost.toFixed(2)} | P&L $${pos.totalProfit.toFixed(2)}`);
        pos.status = 'done';
    } catch (err) {
        logger.error(`MakerMM${tag}: merge failed — ${err.message}`);
        // Don't change status — let monitor loop continue
    }
}

// ── Auto-redeem after market resolution ──────────────────────────────────────
// Used when holding a single-sided position (expensive side filled, cheap cancelled).
// Polls until the market resolves on-chain, then calls redeemPositions.

async function waitAndRedeem(pos, tag) {
    const endMs = new Date(pos.endTime).getTime();
    const waitForEndMs = endMs - Date.now();

    if (waitForEndMs > 0) {
        logger.info(`MakerMM${tag}: holding ${pos.holdingSide.toUpperCase()} — waiting ${Math.round(waitForEndMs / 1000)}s for market to end...`);
        await sleep(waitForEndMs);
    }

    if (config.dryRun) {
        logger.info(`MakerMM${tag}: [SIM] would redeem ${pos.holdingSide.toUpperCase()} after resolution`);
        return;
    }

    logger.info(`MakerMM${tag}: market ended — polling for on-chain resolution...`);
    const provider = getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, ['function payoutDenominator(bytes32 conditionId) view returns (uint256)'], provider);
    const maxWaitMs = 10 * 60 * 1000; // 10 minutes max
    const pollMs = 15_000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            const denom = await ctf.payoutDenominator(pos.conditionId);
            if (!denom.isZero()) {
                logger.info(`MakerMM${tag}: market resolved — redeeming ${pos.holdingSide.toUpperCase()} tokens...`);
                await redeemPositions(pos.conditionId, pos.negRisk);
                logger.money(`MakerMM${tag}: redemption complete`);
                return;
            }
        } catch (err) {
            logger.warn(`MakerMM${tag}: resolution poll error — ${err.message}`);
        }
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        logger.info(`MakerMM${tag}: not resolved yet (${elapsedSec}s / ${maxWaitMs / 1000}s) — retrying in ${pollMs / 1000}s...`);
        await sleep(pollMs);
    }

    logger.warn(`MakerMM${tag}: market not resolved after ${maxWaitMs / 60000} minutes — skipping auto-redeem (tokens remain in wallet)`);
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function executeMakerRebateStrategy(market) {
    const { asset, conditionId, question, endTime, eventStartTime, yesTokenId, noTokenId, negRisk, tickSize } = market;
    const tag = asset ? `[${asset.toUpperCase()}]` : '';
    const label = question.substring(0, 40);
    const sim = config.dryRun ? '[SIM] ' : '';

    // Market officially opens at eventStartTime (not when we detect it)
    const marketOpenTime = eventStartTime ? new Date(eventStartTime).getTime() : Date.now();

    // Wait until 10 seconds after market open before placing any orders.
    // Orders placed too early (pre-open or first few seconds) tend to open at a loss
    // due to wide spreads and erratic pricing before liquidity stabilizes.
    const ENTRY_DELAY_MS = 10_000;
    const entryNotBefore = marketOpenTime + ENTRY_DELAY_MS;
    const waitMs = entryNotBefore - Date.now();
    if (waitMs > 0) {
        logger.info(`MakerMM${tag}: ${sim}waiting ${Math.round(waitMs / 1000)}s for market to stabilize (open +10s)...`);
        await sleep(waitMs);
    }

    logger.info(`MakerMM${tag}: ${sim}entering — ${label}`);

    // ── Wait for real YES price ─────────────────────────────────
    const POLL_SEC = 3;
    const ts = parseFloat(tickSize);

    let yesBid, noBid, combined;
    let yesEntryBid, noEntryBid; // best bid at time of entry — stored for drift tracking
    const waitStart = Date.now();
    const MIN_PRICE = getMinPrice();
    const MAX_PRICE = getMaxPrice();

    while (true) {
        const msRemaining = new Date(endTime).getTime() - Date.now();
        if (msRemaining <= config.makerMmCutLossTime * 1000) {
            logger.warn(`MakerMM${tag}: market closing — aborting`);
            return;
        }

        // ── Bid-based pricing: bid = bestBid + 1_tick (top of orderbook, guaranteed maker) ──
        // We become the new top bid, getting fill priority over existing bids.
        // Safety cap: newBid < bestAsk ensures we never accidentally cross and become a taker.
        const [yesBestBid, yesAsk, noBestBid, noAsk] = await Promise.all([
            getRealPrice(yesTokenId),
            getBestAsk(yesTokenId),
            getRealPrice(noTokenId),
            getBestAsk(noTokenId),
        ]);

        if (!yesBestBid || !noBestBid) {
            logger.info(`MakerMM${tag}: waiting — no bid data (YES: ${yesBestBid ?? 'null'}, NO: ${noBestBid ?? 'null'})`);
            await sleep(POLL_SEC * 1000);
            continue;
        }

        // Auto-detect cheap side: whichever of YES/NO has lower bestBid.
        // Range filter (MIN_PRICE/MAX_PRICE) applies to the cheap side only.
        // The expensive side is derived from: maxCombined - cheapBid.
        const cheapSide = yesBestBid <= noBestBid ? 'yes' : 'no';
        const cheapBestBid = cheapSide === 'yes' ? yesBestBid : noBestBid;
        const cheapAsk    = cheapSide === 'yes' ? yesAsk    : noAsk;

        let cheapBid = roundToTick(cheapBestBid + ts, tickSize);
        // Cap to ask - 2 ticks (not 1) to absorb timing race between fetch and place.
        // A 1-tick buffer still lets the ask move 1 tick before our order is submitted,
        // turning it into a marketable (taker) order and hitting the $1 minimum.
        if (cheapAsk && cheapBid >= cheapAsk - ts) cheapBid = roundToTick(cheapAsk - 2 * ts, tickSize);

        // Range check on cheap side
        if (cheapBid < MIN_PRICE || cheapBid > MAX_PRICE) {
            logger.info(`MakerMM${tag}: waiting — ${cheapSide.toUpperCase()} bid $${cheapBid.toFixed(3)} (need ${MIN_PRICE}-${MAX_PRICE})`);
            await sleep(POLL_SEC * 1000);
            continue;
        }

        // Expensive side: fill remaining combined budget
        const expensiveBid = roundToTick(config.makerMmMaxCombined - cheapBid, tickSize);
        const expensiveAsk = cheapSide === 'yes' ? noAsk : yesAsk;
        let expBid = expensiveBid;
        if (expensiveAsk && expBid >= expensiveAsk - ts) expBid = roundToTick(expensiveAsk - 2 * ts, tickSize);

        if (expBid <= 0 || expBid >= 1) {
            logger.info(`MakerMM${tag}: waiting — ${cheapSide === 'yes' ? 'NO' : 'YES'} bid $${expBid.toFixed(3)} out of bounds`);
            await sleep(POLL_SEC * 1000);
            continue;
        }

        // Map back to yes/no
        yesBid = cheapSide === 'yes' ? cheapBid : expBid;
        noBid  = cheapSide === 'yes' ? expBid   : cheapBid;

        combined = parseFloat((yesBid + noBid).toFixed(4));

        if (combined > config.makerMmMaxCombined) {
            logger.info(`MakerMM${tag}: combined $${combined.toFixed(4)} > max — waiting`);
            await sleep(POLL_SEC * 1000);
            continue;
        }

        // If combined is more than 1 tick below target the market spread is too tight.
        // Wait for better conditions instead of entering with lower-than-expected profit.
        const minCombined = parseFloat((config.makerMmMaxCombined - ts).toFixed(4));
        if (combined < minCombined) {
            logger.info(`MakerMM${tag}: spread too tight — combined $${combined.toFixed(4)} < target $${config.makerMmMaxCombined} — waiting`);
            await sleep(POLL_SEC * 1000);
            continue;
        }

        yesEntryBid = yesBestBid;
        noEntryBid = noBestBid;

        const waitSec = ((Date.now() - waitStart) / 1000).toFixed(1);
        logger.success(`MakerMM${tag}: ready after ${waitSec}s — YES $${yesBid} + NO $${noBid} = $${combined.toFixed(4)} (topBid YES:$${yesBestBid} NO:$${noBestBid})`);
        break;
    }

    // ── Calculate shares ──────────────────────────────────────────
    const targetShares = config.makerMmTradeSize;

    if (targetShares < CLOB_MIN_ORDER_SHARES) {
        logger.warn(`MakerMM${tag}: shares ${targetShares} < min ${CLOB_MIN_ORDER_SHARES} — skipping`);
        return;
    }

    const yesCost = targetShares * yesBid;
    const noCost  = targetShares * noBid;
    const totalCost = yesCost + noCost;

    if (!config.dryRun) {
        const balance = await getUsdcBalance();
        if (balance < totalCost) {
            logger.error(`MakerMM${tag}: insufficient balance $${balance.toFixed(2)} (need $${totalCost.toFixed(2)})`);
            return;
        }
    }

    // ── Snapshot balance BEFORE placing orders ────────────────────────────────
    // Critical for re-entry: same tokenIds are reused each cycle, so leftover
    // tokens from a previous cycle would otherwise fool the fill-detection logic
    // into thinking the new orders filled instantly, causing a new cycle to start
    // while the actual new orders remain open in the orderbook.
    const [yesBaseline, noBaseline] = await Promise.all([
        getTokenBalance(yesTokenId),
        getTokenBalance(noTokenId),
    ]);
    if ((yesBaseline || 0) > 0 || (noBaseline || 0) > 0) {
        logger.info(`MakerMM${tag}: pre-order baseline — YES=${(yesBaseline || 0).toFixed(4)} NO=${(noBaseline || 0).toFixed(4)} (leftover from prior cycle)`);
    }

    // ── Place orders ONCE (NO repricing) ──────────────────────
    logger.trade(`MakerMM${tag}: placing BUY — YES $${yesBid} × ${targetShares} + NO $${noBid} × ${targetShares} = $${totalCost.toFixed(2)}`);

    const [yesBuy, noBuy] = await Promise.all([
        placeLimitBuy(yesTokenId, targetShares, yesBid, tickSize, negRisk),
        placeLimitBuy(noTokenId, targetShares, noBid, tickSize, negRisk),
    ]);

    logger.info(`MakerMM${tag}: order results — YES: ${yesBuy.success ? 'OK' : 'FAIL'} (id=${yesBuy.orderId?.slice(-8) || 'none'}), NO: ${noBuy.success ? 'OK' : 'FAIL'} (id=${noBuy.orderId?.slice(-8) || 'none'})`);

    // If one side failed, check if actually filled on-chain OR via order book before retrying
    let finalYesBuy = yesBuy;
    let finalNoBuy = noBuy;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries && (!finalYesBuy.success || !finalNoBuy.success); attempt++) {
        // Check 1: On-chain balance (most reliable) — compare against baseline
        const [yesBalance, noBalance] = await Promise.all([
            getTokenBalance(yesTokenId),
            getTokenBalance(noTokenId),
        ]);
        const yesNet = (yesBalance || 0) - (yesBaseline || 0);
        const noNet = (noBalance || 0) - (noBaseline || 0);

        // Check 2: Order status via CLOB API (backup check)
        const [yesOrderStatus, noOrderStatus] = await Promise.all([
            finalYesBuy.success ? null : checkOrderStatus(yesBuy.orderId),
            finalNoBuy.success ? null : checkOrderStatus(noBuy.orderId),
        ]);

        if (yesOrderStatus || noOrderStatus) {
            logger.info(`MakerMM${tag}: order status check — YES: ${yesOrderStatus || 'N/A'}, NO: ${noOrderStatus || 'N/A'}`);
        }

        // Use net (new) balance to determine if actually filled — not total balance
        if (!finalYesBuy.success && (
            yesNet >= targetShares * 0.5 ||
            yesOrderStatus === 'filled' ||
            yesOrderStatus === 'partial'
        )) {
            logger.success(`MakerMM${tag}: YES already filled (net: ${yesNet.toFixed(4)}, order: ${yesOrderStatus}) — no retry`);
            finalYesBuy = { success: true, orderId: yesBuy.orderId || `filled-${Date.now()}` };
        }

        if (!finalNoBuy.success && (
            noNet >= targetShares * 0.5 ||
            noOrderStatus === 'filled' ||
            noOrderStatus === 'partial'
        )) {
            logger.success(`MakerMM${tag}: NO already filled (net: ${noNet.toFixed(4)}, order: ${noOrderStatus}) — no retry`);
            finalNoBuy = { success: true, orderId: noBuy.orderId || `filled-${Date.now()}` };
        }

        if (finalYesBuy.success && finalNoBuy.success) break;

        // Cancel existing order before retry to avoid duplicate orders
        if (!finalYesBuy.success) {
            logger.warn(`MakerMM${tag}: retrying YES order (attempt ${attempt}/${maxRetries})...`);
            await cancelOrder(yesBuy.orderId);
            await sleep(500);
            finalYesBuy = await placeLimitBuy(yesTokenId, targetShares, yesBid, tickSize, negRisk);
            if (finalYesBuy.success) {
                logger.success(`MakerMM${tag}: YES order succeeded on retry ${attempt}`);
            }
        }
        if (!finalNoBuy.success) {
            logger.warn(`MakerMM${tag}: retrying NO order (attempt ${attempt}/${maxRetries})...`);
            await cancelOrder(noBuy.orderId);
            await sleep(500);
            finalNoBuy = await placeLimitBuy(noTokenId, targetShares, noBid, tickSize, negRisk);
            if (finalNoBuy.success) {
                logger.success(`MakerMM${tag}: NO order succeeded on retry ${attempt}`);
            }
        }
    }

    if (!finalYesBuy.success || !finalNoBuy.success) {
        logger.error(`MakerMM${tag}: order failed after retries — YES: ${finalYesBuy.success}, NO: ${finalNoBuy.success}`);
        await Promise.all([
            finalYesBuy.success ? cancelOrder(finalYesBuy.orderId) : null,
            finalNoBuy.success ? cancelOrder(finalNoBuy.orderId) : null,
        ]);
        return;
    }

    // ── Build position and wait ─────────────────────────────────
    const pos = {
        asset: asset || 'btc',
        conditionId,
        question,
        endTime,
        marketOpenTime,
        tickSize,
        negRisk,
        status: 'monitoring',
        targetShares,
        yes: {
            tokenId: yesTokenId,
            buyPrice: yesBid,
            cost: yesCost,
            orderId: finalYesBuy.orderId,
            filled: false,
            baseline: yesBaseline || 0,
        },
        no: {
            tokenId: noTokenId,
            buyPrice: noBid,
            cost: noCost,
            orderId: finalNoBuy.orderId,
            filled: false,
            baseline: noBaseline || 0,
        },
        totalProfit: 0,
    };

    activePositions.set(conditionId, pos);
    await monitorUntilFilled(pos, tag, label);
    activePositions.delete(conditionId);

    // If holding a single-sided position (expensive filled, cheap cancelled) — wait and redeem
    if (pos.holdingSide) {
        await waitAndRedeem(pos, tag);
        return { oneSided: false }; // not a stuck one-sided cycle, intentional hold
    }

    const sign = pos.totalProfit >= 0 ? '+' : '';
    logger.info(`MakerMM${tag}: done | P&L: ${sign}$${pos.totalProfit.toFixed(2)}`);

    return { oneSided: pos.oneSided ?? false };
}
