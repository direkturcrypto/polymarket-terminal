/**
 * makerExecutor.js
 * Buy Low, Sell High Market Maker — no splitPosition.
 *
 * Flow:
 *   1. Ensure ERC1155 exchange approval (one-time, needed to sell tokens)
 *   2. Place concurrent limit BUY on UP + DOWN at makerBuyPrice (e.g. 2c)
 *   3. Monitor both orders in parallel (multi-thread style)
 *   4. When one side fills (even partial):
 *      a. Wait briefly for on-chain settlement
 *      b. Place limit SELL for filled shares at makerSellPrice (e.g. 3c)
 *      c. Cancel the other side's buy order
 *   5. Partial fills → partial sells placed immediately
 *   6. CL at 10s before close: cancel unfilled buy orders
 *   7. Place sells for any filled positions (retry 3x if settlement pending)
 *   8. Monitor sell orders until filled or market close
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient } from './client.js';
import { ensureExchangeApproval } from './ctf.js';
import logger from '../utils/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CL_SECONDS = 10; // cancel unfilled sells 10s before market close
const SELL_DELAY_MS = 2000; // wait for on-chain settlement before placing sell
const MAX_SELL_RETRIES = 3;
const MIN_ORDER_SIZE = 5; // Polymarket minimum order size

// In-memory store of active maker positions
const activePositions = new Map();

export function getActiveMakerPositions() {
    return Array.from(activePositions.values());
}

// ── Simulation stats ─────────────────────────────────────────────────────────

const simStats = {
    startBalance: config.makerSimBalance,
    balance: config.makerSimBalance,
    wins: 0,        // sell filled → realized profit
    losses: 0,      // buy filled, sell NOT filled → loss = buy cost
    skips: 0,       // no fills at all → $0
    totalTrades: 0,
    cumulativePnl: 0,
    history: [],    // [{ time, side, result, pnl, balance }]
};

export function getSimStats() {
    return { ...simStats, history: [...simStats.history] };
}

function recordTrade(result, side, pnl) {
    simStats.totalTrades++;
    simStats.cumulativePnl += pnl;
    simStats.balance += pnl;

    if (result === 'win') simStats.wins++;
    else if (result === 'loss') simStats.losses++;
    else simStats.skips++;

    simStats.history.push({
        time: new Date().toISOString().replace('T', ' ').substring(11, 19),
        side: side || '-',
        result,
        pnl,
        balance: simStats.balance,
    });

    if (simStats.history.length > 50) simStats.history.splice(0, simStats.history.length - 50);
}

// ── Approval tracking ────────────────────────────────────────────────────────

let approvalChecked = false;

async function ensureApproval(negRisk) {
    if (config.dryRun || approvalChecked) return;
    try {
        await ensureExchangeApproval(negRisk);
        approvalChecked = true;
    } catch (err) {
        logger.error(`MAKER: exchange approval failed — ${err.message}`);
    }
}

// ── Order helpers ─────────────────────────────────────────────────────────────

async function placeLimitBuy(tokenId, shares, price, tickSize, negRisk) {
    const size = Math.max(MIN_ORDER_SIZE, Math.floor(shares));
    if (config.dryRun) {
        return { success: true, orderId: `sim-buy-${Date.now()}-${tokenId.slice(-6)}`, size };
    }
    const client = getClient();
    try {
        const res = await client.createAndPostOrder(
            { tokenID: tokenId, side: Side.BUY, price, size },
            { tickSize, negRisk },
            OrderType.GTC,
        );
        if (!res?.success) return { success: false };
        return { success: true, orderId: res.orderID, size };
    } catch (err) {
        logger.error('MAKER limit buy error:', err.message);
        return { success: false };
    }
}

async function placeLimitSellWithRetry(tokenId, shares, price, tickSize, negRisk, tag) {
    const size = Math.max(MIN_ORDER_SIZE, Math.floor(shares));
    if (config.dryRun) {
        return { success: true, orderId: `sim-sell-${Date.now()}-${tokenId.slice(-6)}` };
    }

    const client = getClient();

    for (let attempt = 1; attempt <= MAX_SELL_RETRIES; attempt++) {
        try {
            const res = await client.createAndPostOrder(
                { tokenID: tokenId, side: Side.SELL, price, size },
                { tickSize, negRisk },
                OrderType.GTC,
            );
            if (res?.success) {
                return { success: true, orderId: res.orderID };
            }

            const errMsg = res?.errorMsg || 'unknown';
            logger.warn(`MAKER${tag}: sell attempt ${attempt}/${MAX_SELL_RETRIES} failed: ${errMsg}`);
        } catch (err) {
            logger.warn(`MAKER${tag}: sell attempt ${attempt}/${MAX_SELL_RETRIES} error: ${err.message}`);
        }

        if (attempt < MAX_SELL_RETRIES) {
            // Wait longer each retry — tokens might not have settled yet
            const delay = SELL_DELAY_MS * attempt;
            logger.info(`MAKER${tag}: waiting ${delay / 1000}s for on-chain settlement before retry...`);
            await sleep(delay);
        }
    }

    return { success: false };
}

async function cancelOrder(orderId) {
    if (config.dryRun || !orderId || orderId.startsWith('sim-')) return true;
    try {
        await getClient().cancelOrder({ orderID: orderId });
        return true;
    } catch (err) {
        logger.warn('MAKER cancel order error:', err.message);
        return false;
    }
}

// ── Order status ──────────────────────────────────────────────────────────────

async function getOrderFill(orderId) {
    if (!orderId || orderId.startsWith('sim-')) {
        return { matched: 0, status: 'LIVE', fullyFilled: false };
    }
    try {
        const order = await getClient().getOrder(orderId);
        if (!order) return { matched: 0, status: 'UNKNOWN', fullyFilled: false };
        const matched = parseFloat(order.size_matched || '0');
        return {
            matched,
            status: order.status,
            fullyFilled: order.status === 'MATCHED',
        };
    } catch {
        return { matched: 0, status: 'ERROR', fullyFilled: false };
    }
}

// Simulation: check if market price would fill our order
async function simCheckFill(tokenId, side, price) {
    try {
        const mp = await getClient().getMidpoint(tokenId);
        const midPrice = parseFloat(mp?.mid ?? mp ?? '0') || 0;
        if (side === 'buy' && midPrice <= price) return midPrice;
        if (side === 'sell' && midPrice >= price) return midPrice;
        return null;
    } catch {
        return null;
    }
}

// ── Core strategy ─────────────────────────────────────────────────────────────

export async function executeMakerStrategy(market) {
    const { asset, duration, conditionId, question, endTime, yesTokenId, noTokenId, negRisk, tickSize } = market;
    const tag = asset ? `[${asset.toUpperCase()}/${duration || '5m'}]` : '';
    const label = question.substring(0, 40);
    const sim = config.dryRun ? '[SIM] ' : '';
    const { makerBuyPrice, makerSellPrice, makerTradeSize, makerMonitorMs } = config;

    // Check sim balance
    const costPerSide = makerTradeSize * makerBuyPrice;
    if (config.dryRun && simStats.balance < costPerSide) {
        logger.warn(`MAKER${tag}: ${sim}insufficient sim balance $${simStats.balance.toFixed(2)} (need $${costPerSide.toFixed(2)}) — skipping`);
        recordTrade('skip', null, 0);
        return;
    }

    logger.info(`MAKER${tag}: ${sim}entering — ${label}`);
    logger.info(`MAKER${tag}: BUY @ $${makerBuyPrice} → SELL @ $${makerSellPrice} | ${makerTradeSize} shares/side | cost $${costPerSide.toFixed(2)}`);

    // ── 0. Ensure ERC1155 exchange approval (one-time) ───────────
    await ensureApproval(negRisk);

    // ── 1. Place BUY UP + DOWN concurrently ──────────────────────
    logger.trade(`MAKER${tag}: ${sim}placing BUY UP + DOWN @ $${makerBuyPrice}`);

    const [upBuy, downBuy] = await Promise.all([
        placeLimitBuy(yesTokenId, makerTradeSize, makerBuyPrice, tickSize, negRisk),
        placeLimitBuy(noTokenId, makerTradeSize, makerBuyPrice, tickSize, negRisk),
    ]);

    if (!upBuy.success && !downBuy.success) {
        logger.error(`MAKER${tag}: both buy orders failed — aborting`);
        recordTrade('skip', null, 0);
        return;
    }

    if (upBuy.success) logger.trade(`MAKER${tag}: ${sim}UP BUY placed | order ${upBuy.orderId}`);
    if (downBuy.success) logger.trade(`MAKER${tag}: ${sim}DOWN BUY placed | order ${downBuy.orderId}`);

    // ── 2. Build position state ──────────────────────────────────
    const pos = {
        asset: asset || 'btc',
        duration: duration || '5m',
        conditionId,
        question,
        endTime,
        tickSize,
        negRisk,
        status: 'buying',
        enteredAt: new Date().toISOString(),
        up: {
            tokenId: yesTokenId,
            buyOrderId: upBuy.success ? upBuy.orderId : null,
            buyFilled: 0,
            sellOrders: [],
            totalSellFilled: 0,
            cancelled: !upBuy.success,
        },
        down: {
            tokenId: noTokenId,
            buyOrderId: downBuy.success ? downBuy.orderId : null,
            buyFilled: 0,
            sellOrders: [],
            totalSellFilled: 0,
            cancelled: !downBuy.success,
        },
        winner: null,
        totalCost: 0,
        totalRevenue: 0,
    };

    activePositions.set(conditionId, pos);

    // ── 3. Monitor buy → sell (concurrent) ───────────────────────
    try {
        await monitorBuyPhase(pos, tag, sim);
        await monitorSellPhase(pos, tag, sim);
    } catch (err) {
        logger.error(`MAKER${tag}: strategy error — ${err.message}`);
    }

    // ── Final result + sim stats ─────────────────────────────────
    const pnl = pos.totalRevenue - pos.totalCost;
    const winnerSide = pos.winner?.toUpperCase() || '-';

    if (pos.status === 'done' && pos.totalRevenue > 0) {
        // WIN: sell filled
        recordTrade('win', winnerSide, pnl);
        logger.money(`MAKER${tag}: ${sim}WIN | ${winnerSide} | cost $${pos.totalCost.toFixed(4)} → revenue $${pos.totalRevenue.toFixed(4)} | P&L +$${pnl.toFixed(4)}`);
    } else if (pos.totalCost > 0) {
        // LOSS: buy filled but sell didn't fill (expired-holding)
        recordTrade('loss', winnerSide, -pos.totalCost);
        logger.warn(`MAKER${tag}: ${sim}LOSS | ${winnerSide} | cost $${pos.totalCost.toFixed(4)} (sell not filled, held to expiry)`);
    } else {
        // SKIP: nothing filled
        recordTrade('skip', null, 0);
        logger.info(`MAKER${tag}: ${sim}SKIP | no fills, $0 cost`);
    }

    // Log running stats
    const s = simStats;
    const winRate = s.wins + s.losses > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0';
    logger.info(`MAKER${tag}: ${sim}STATS | W:${s.wins} L:${s.losses} S:${s.skips} | Win%: ${winRate}% | PnL: $${s.cumulativePnl.toFixed(4)} | Balance: $${s.balance.toFixed(2)}`);

    activePositions.delete(conditionId);
}

// ── Buy phase: monitor both sides concurrently ───────────────────────────────

async function monitorBuyPhase(pos, tag, sim) {
    const { makerBuyPrice, makerSellPrice, makerMonitorMs } = config;

    const monitorSide = async (sideKey) => {
        const side = pos[sideKey];
        const otherKey = sideKey === 'up' ? 'down' : 'up';
        const sideName = sideKey.toUpperCase();

        if (!side.buyOrderId) return;

        while (!pos.winner) {
            const msLeft = new Date(pos.endTime).getTime() - Date.now();
            // CL: cancel unfilled buy at 10s before market close
            if (msLeft <= CL_SECONDS * 1000) {
                if (side.buyOrderId && !side.cancelled) {
                    logger.warn(`MAKER${tag}: CL ${CL_SECONDS}s — cancelling ${sideName} buy`);
                    await cancelOrder(side.buyOrderId);
                    side.cancelled = true;
                }
                break;
            }

            // Check fill
            let fill;
            if (config.dryRun) {
                const hitPrice = await simCheckFill(side.tokenId, 'buy', makerBuyPrice);
                if (hitPrice !== null) {
                    fill = { matched: config.makerTradeSize, fullyFilled: true };
                } else {
                    fill = { matched: 0, fullyFilled: false };
                }
            } else {
                fill = await getOrderFill(side.buyOrderId);
            }

            // New fills detected → wait for settlement, then place sell
            const newFill = fill.matched - side.buyFilled;
            if (newFill > 0) {
                side.buyFilled = fill.matched;
                pos.totalCost += newFill * makerBuyPrice;

                logger.money(`MAKER${tag}: ${sim}${sideName} BUY filled ${newFill.toFixed(2)} shares @ $${makerBuyPrice} (total: ${side.buyFilled.toFixed(2)}/${config.makerTradeSize})`);

                // Check total unsold shares — only place sell if >= MIN_ORDER_SIZE
                const soldShares = side.sellOrders.reduce((sum, so) => sum + so.shares, 0);
                const unsold = side.buyFilled - soldShares;

                if (unsold >= MIN_ORDER_SIZE) {
                    // Wait for on-chain token settlement before placing sell
                    if (!config.dryRun) {
                        logger.info(`MAKER${tag}: waiting ${SELL_DELAY_MS / 1000}s for on-chain settlement...`);
                        await sleep(SELL_DELAY_MS);
                    }

                    const sellResult = await placeLimitSellWithRetry(
                        side.tokenId, unsold, makerSellPrice,
                        pos.tickSize, pos.negRisk, tag,
                    );
                    if (sellResult.success) {
                        side.sellOrders.push({
                            orderId: sellResult.orderId,
                            shares: unsold,
                            filled: false,
                            fillPrice: null,
                        });
                        logger.trade(`MAKER${tag}: ${sim}${sideName} SELL placed ${unsold.toFixed(2)} shares @ $${makerSellPrice}`);
                    } else {
                        logger.error(`MAKER${tag}: ${sideName} SELL failed after ${MAX_SELL_RETRIES} retries — tokens held to resolution`);
                    }
                } else {
                    logger.info(`MAKER${tag}: ${sideName} unsold ${unsold.toFixed(2)} shares < ${MIN_ORDER_SIZE} min — waiting for more fills`);
                }
            }

            // Fully filled → winner
            if (fill.fullyFilled) {
                pos.winner = sideKey;
                pos.status = 'selling';
                logger.success(`MAKER${tag}: ${sim}${sideName} fully filled! Cancelling ${otherKey.toUpperCase()} buy...`);

                const other = pos[otherKey];
                if (other.buyOrderId && !other.cancelled) {
                    await cancelOrder(other.buyOrderId);
                    other.cancelled = true;
                    logger.info(`MAKER${tag}: ${otherKey.toUpperCase()} buy cancelled`);
                }
                return;
            }

            await sleep(makerMonitorMs);
        }
    };

    await Promise.race([
        monitorSide('up'),
        monitorSide('down'),
    ]);

    // Cleanup: cancel any remaining unfilled buy orders
    for (const key of ['up', 'down']) {
        const s = pos[key];
        if (s.buyOrderId && !s.cancelled) {
            await cancelOrder(s.buyOrderId);
            s.cancelled = true;
            logger.info(`MAKER${tag}: cancelled ${key.toUpperCase()} buy order`);
        }
    }

    // Place sells for filled buys that don't have sell orders yet
    for (const key of ['up', 'down']) {
        const s = pos[key];
        const soldShares = s.sellOrders.reduce((sum, so) => sum + so.shares, 0);
        const unsold = s.buyFilled - soldShares;
        if (unsold >= MIN_ORDER_SIZE) {
            logger.info(`MAKER${tag}: placing sell for ${key.toUpperCase()} ${unsold.toFixed(2)} unsold shares`);
            if (!config.dryRun) {
                logger.info(`MAKER${tag}: waiting ${SELL_DELAY_MS / 1000}s for on-chain settlement...`);
                await sleep(SELL_DELAY_MS);
            }
            const sellResult = await placeLimitSellWithRetry(
                s.tokenId, unsold, makerSellPrice,
                pos.tickSize, pos.negRisk, tag,
            );
            if (sellResult.success) {
                s.sellOrders.push({
                    orderId: sellResult.orderId,
                    shares: unsold,
                    filled: false,
                    fillPrice: null,
                });
                logger.trade(`MAKER${tag}: ${sim}${key.toUpperCase()} SELL placed ${unsold.toFixed(2)} shares @ $${makerSellPrice}`);
            } else {
                logger.error(`MAKER${tag}: ${key.toUpperCase()} SELL failed after ${MAX_SELL_RETRIES} retries — tokens held to resolution`);
            }
        }
    }

    if (!pos.winner) {
        const anyFill = pos.up.buyFilled > 0 || pos.down.buyFilled > 0;
        if (anyFill) {
            pos.winner = pos.up.buyFilled >= pos.down.buyFilled ? 'up' : 'down';
            pos.status = 'selling';
            logger.info(`MAKER${tag}: partial fill — monitoring sell for ${pos.winner.toUpperCase()} ${pos[pos.winner].buyFilled.toFixed(2)} shares`);
        } else {
            pos.status = 'done';
            logger.info(`MAKER${tag}: no fills — buy orders expired naturally, $0 loss`);
        }
    }
}

// ── Sell phase: monitor sell orders until market close ────────────────────────

async function monitorSellPhase(pos, tag, sim) {
    if (pos.status === 'done') return;

    const { makerSellPrice, makerMonitorMs } = config;
    const winnerKey = pos.winner;
    if (!winnerKey) return;

    const side = pos[winnerKey];
    const sideName = winnerKey.toUpperCase();

    if (side.sellOrders.length === 0) {
        // Sell placement failed — tokens held to resolution
        pos.status = 'expired-holding';
        logger.warn(`MAKER${tag}: no sell orders placed — held to resolution`);
        return;
    }

    logger.info(`MAKER${tag}: monitoring ${side.sellOrders.length} sell order(s) for ${sideName}`);

    while (true) {
        const msLeft = new Date(pos.endTime).getTime() - Date.now();

        // Market closed — unfilled sells resolve on-chain
        if (msLeft <= 0) {
            pos.status = side.totalSellFilled > 0 ? 'done' : 'expired-holding';
            if (pos.status === 'expired-holding') {
                logger.warn(`MAKER${tag}: market closed — unfilled sells held to resolution`);
            }
            break;
        }

        // Check all sell orders concurrently
        const checks = await Promise.all(
            side.sellOrders.map(async (so) => {
                if (so.filled) return true;

                let filled = false;
                if (config.dryRun) {
                    const hitPrice = await simCheckFill(side.tokenId, 'sell', makerSellPrice);
                    if (hitPrice !== null) {
                        filled = true;
                        so.fillPrice = hitPrice;
                    }
                } else {
                    const fill = await getOrderFill(so.orderId);
                    if (fill.fullyFilled || fill.matched >= so.shares * 0.99) {
                        filled = true;
                        so.fillPrice = makerSellPrice;
                    }
                }

                if (filled) {
                    so.filled = true;
                    side.totalSellFilled += so.shares;
                    pos.totalRevenue += so.shares * (so.fillPrice || makerSellPrice);
                    logger.money(`MAKER${tag}: ${sim}${sideName} SELL filled ${so.shares.toFixed(2)} shares @ $${(so.fillPrice || makerSellPrice).toFixed(3)}`);
                }

                return so.filled;
            })
        );

        // All sells filled → done
        if (checks.every(Boolean) && side.sellOrders.length > 0) {
            pos.status = 'done';
            logger.success(`MAKER${tag}: ${sim}all sells filled!`);
            break;
        }

        await sleep(makerMonitorMs);
    }
}
