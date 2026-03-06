/**
 * makerExecutor.js
 * Buy Low, Sell High Market Maker — no splitPosition, no cut-loss.
 *
 * Flow:
 *   1. Place concurrent limit BUY on UP + DOWN at makerBuyPrice (e.g. 2c)
 *   2. Monitor both orders in parallel (multi-thread style)
 *   3. When one side fills (even partial):
 *      a. Immediately place limit SELL for filled shares at makerSellPrice (e.g. 3c)
 *      b. Cancel the other side's buy order
 *   4. Partial fills → partial sells placed immediately
 *   5. Monitor sell orders until filled or market expires
 *   6. No cut-loss — worst case is losing buy cost (2c/share) on wrong side,
 *      or gaining $1/share if on winning side and sell doesn't fill
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient } from './client.js';
import logger from '../utils/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory store of active maker positions
const activePositions = new Map();

export function getActiveMakerPositions() {
    return Array.from(activePositions.values());
}

// ── Order helpers ─────────────────────────────────────────────────────────────

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
        if (!res?.success) return { success: false };
        return { success: true, orderId: res.orderID };
    } catch (err) {
        logger.error('MAKER limit buy error:', err.message);
        return { success: false };
    }
}

async function placeLimitSell(tokenId, shares, price, tickSize, negRisk) {
    if (config.dryRun) {
        return { success: true, orderId: `sim-sell-${Date.now()}-${tokenId.slice(-6)}` };
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
        logger.error('MAKER limit sell error:', err.message);
        return { success: false };
    }
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
    const { asset, conditionId, question, endTime, yesTokenId, noTokenId, negRisk, tickSize } = market;
    const tag = asset ? `[${asset.toUpperCase()}]` : '';
    const label = question.substring(0, 40);
    const sim = config.dryRun ? '[SIM] ' : '';
    const { makerBuyPrice, makerSellPrice, makerTradeSize, makerMonitorMs } = config;

    logger.info(`MAKER${tag}: ${sim}entering — ${label}`);
    logger.info(`MAKER${tag}: BUY @ $${makerBuyPrice} → SELL @ $${makerSellPrice} | ${makerTradeSize} shares/side`);

    // ── 1. Place BUY UP + DOWN concurrently ──────────────────────
    logger.trade(`MAKER${tag}: ${sim}placing BUY UP + DOWN @ $${makerBuyPrice}`);

    const [upBuy, downBuy] = await Promise.all([
        placeLimitBuy(yesTokenId, makerTradeSize, makerBuyPrice, tickSize, negRisk),
        placeLimitBuy(noTokenId, makerTradeSize, makerBuyPrice, tickSize, negRisk),
    ]);

    if (!upBuy.success && !downBuy.success) {
        logger.error(`MAKER${tag}: both buy orders failed — aborting`);
        return;
    }

    if (upBuy.success) logger.trade(`MAKER${tag}: ${sim}UP BUY placed | order ${upBuy.orderId}`);
    if (downBuy.success) logger.trade(`MAKER${tag}: ${sim}DOWN BUY placed | order ${downBuy.orderId}`);

    // ── 2. Build position state ──────────────────────────────────
    const pos = {
        asset: asset || 'btc',
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
            sellOrders: [],     // { orderId, shares, filled, fillPrice }
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
        winner: null,           // 'up' or 'down'
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

    // ── Final P&L ────────────────────────────────────────────────
    const pnl = pos.totalRevenue - pos.totalCost;
    const sign = pnl >= 0 ? '+' : '';

    if (pos.status === 'expired-holding') {
        // Position held to expiry — will resolve on-chain
        const side = pos[pos.winner];
        logger.info(`MAKER${tag}: ${sim}holding ${side.buyFilled.toFixed(2)} ${pos.winner.toUpperCase()} shares to resolution`);
        logger.info(`MAKER${tag}: ${sim}if winning side → payout $${side.buyFilled.toFixed(2)} (cost $${pos.totalCost.toFixed(4)})`);
        logger.info(`MAKER${tag}: ${sim}if losing side  → payout $0 (loss $${pos.totalCost.toFixed(4)})`);
    } else {
        logger.money(`MAKER${tag}: ${sim}strategy complete | cost $${pos.totalCost.toFixed(4)} | revenue $${pos.totalRevenue.toFixed(4)} | P&L ${sign}$${pnl.toFixed(4)}`);
    }

    activePositions.delete(conditionId);
}

// ── Buy phase: monitor both sides concurrently ───────────────────────────────

async function monitorBuyPhase(pos, tag, sim) {
    const { makerBuyPrice, makerSellPrice, makerMonitorMs } = config;

    // Run two concurrent monitors — first full fill wins
    const monitorSide = async (sideKey) => {
        const side = pos[sideKey];
        const otherKey = sideKey === 'up' ? 'down' : 'up';
        const sideName = sideKey.toUpperCase();

        if (!side.buyOrderId) return; // order failed at placement

        while (!pos.winner) {
            const msLeft = new Date(pos.endTime).getTime() - Date.now();

            // Market expired — buy orders expire naturally
            if (msLeft <= 0) break;

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

            // New fills detected → place sell immediately
            const newFill = fill.matched - side.buyFilled;
            if (newFill > 0) {
                side.buyFilled = fill.matched;
                pos.totalCost += newFill * makerBuyPrice;

                logger.money(`MAKER${tag}: ${sim}${sideName} BUY filled ${newFill.toFixed(2)} shares @ $${makerBuyPrice} (total: ${side.buyFilled.toFixed(2)}/${config.makerTradeSize})`);

                // Place sell immediately for the newly filled amount
                const sellResult = await placeLimitSell(side.tokenId, newFill, makerSellPrice, pos.tickSize, pos.negRisk);
                if (sellResult.success) {
                    side.sellOrders.push({
                        orderId: sellResult.orderId,
                        shares: newFill,
                        filled: false,
                        fillPrice: null,
                    });
                    logger.trade(`MAKER${tag}: ${sim}${sideName} SELL placed ${newFill.toFixed(2)} shares @ $${makerSellPrice}`);
                }
            }

            // Fully filled → we have a winner
            if (fill.fullyFilled) {
                pos.winner = sideKey;
                pos.status = 'selling';
                logger.success(`MAKER${tag}: ${sim}${sideName} fully filled! Cancelling ${otherKey.toUpperCase()} buy...`);

                // Cancel the other side's buy
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

    // Run both side monitors concurrently — race to first full fill
    await Promise.race([
        monitorSide('up'),
        monitorSide('down'),
    ]);

    // If no winner (market expired without fills)
    if (!pos.winner) {
        // Check if any partial fills exist
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

// ── Sell phase: monitor sell orders until filled or market expires ────────────

async function monitorSellPhase(pos, tag, sim) {
    if (pos.status === 'done') return;

    const { makerSellPrice, makerMonitorMs } = config;
    const winnerKey = pos.winner;
    if (!winnerKey) return;

    const side = pos[winnerKey];
    const sideName = winnerKey.toUpperCase();

    logger.info(`MAKER${tag}: monitoring ${side.sellOrders.length} sell order(s) for ${sideName}`);

    while (true) {
        const msLeft = new Date(pos.endTime).getTime() - Date.now();

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

        // Market expired — position resolves on-chain (no cut-loss)
        if (msLeft <= 0) {
            pos.status = 'expired-holding';
            logger.info(`MAKER${tag}: market expired — holding position to resolution (no cut-loss)`);
            break;
        }

        await sleep(makerMonitorMs);
    }
}
