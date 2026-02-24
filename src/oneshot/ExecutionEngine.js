/**
 * ExecutionEngine.js
 * Steps E & F of the runtime sequence.
 *
 * Responsibilities:
 *   - Submit a limit-marketable FOK BUY order at bestAsk
 *   - Wait up to fillTimeoutMs for an ack/fill response
 *   - Return structured fill result (filled | partial | cancelled)
 *   - Submit market-sell (FOK) for exits and cut-losses
 *   - Place GTC limit-sell for take-profit orders
 *
 * In dry-run mode all calls short-circuit with simulated successful results.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import logger from '../utils/logger.js';

const FILL_TIMEOUT_MS = 800;

export class ExecutionEngine {
    /**
     * @param {Object} opts
     * @param {import('@polymarket/clob-client').ClobClient} opts.client
     * @param {boolean} opts.dryRun
     * @param {number}  [opts.fillTimeoutMs=800]
     */
    constructor({ client, dryRun, fillTimeoutMs = FILL_TIMEOUT_MS }) {
        this._client        = client;
        this._dryRun        = dryRun;
        this._fillTimeoutMs = fillTimeoutMs;

        /** Cache tick sizes to avoid repeated API calls */
        this._tickCache = new Map();
    }

    // ── Buy ───────────────────────────────────────────────────────────────────

    /**
     * Submit a limit-marketable FOK buy and wait for the fill result.
     *
     * @param {Object} opts
     * @param {string} opts.tokenId     - ERC1155 token ID (UP or DOWN)
     * @param {number} opts.size        - Number of shares to buy (≥ 5)
     * @param {number} opts.price       - Limit price (bestAsk from snapshot)
     * @param {string} opts.marketSlug  - For logging
     *
     * @returns {Promise<FillResult>}
     */
    async submitBuy({ tokenId, size, price, marketSlug }) {
        if (this._dryRun) {
            logger.trade(`[SIM] BUY ${marketSlug} | ${size} shares @ $${price}`);
            return {
                orderId:      `sim_buy_${Date.now()}`,
                status:       'filled',
                filledSize:   size,
                avgFillPrice: price,
                ackMs:        45,
                fillMs:       90,
            };
        }

        const startTs = Date.now();
        const { tickSize, negRisk } = await this._getMarketOpts(tokenId);

        logger.trade(`BUY ${marketSlug} | ${size} shares @ $${price}`);

        const response = await this._withTimeout(
            this._client.createAndPostOrder(
                { tokenID: tokenId, price: price.toString(), size, side: Side.BUY },
                { tickSize, negRisk },
                OrderType.FOK,
            ),
            this._fillTimeoutMs,
        );

        const ackMs  = Date.now() - startTs;
        const fillMs = ackMs;

        if (!response?.success) {
            logger.warn(`ExecutionEngine: buy not filled — ${response?.errorMsg ?? 'no response'}`);
            return { orderId: null, status: 'cancelled', filledSize: 0, ackMs, fillMs };
        }

        const takingAmt = parseFloat(response.takingAmount || '0');
        const makingAmt = parseFloat(response.makingAmount || '0');

        if (takingAmt > 0) {
            const avgFillPrice = makingAmt > 0 ? makingAmt / takingAmt : price;
            logger.success(`ExecutionEngine: filled ${takingAmt.toFixed(2)} shares @ avg $${avgFillPrice.toFixed(4)}`);
            return { orderId: response.orderID, status: 'filled', filledSize: takingAmt, avgFillPrice, ackMs, fillMs };
        }

        // Some CLOB responses indicate fill via status string rather than amounts
        const isMatched = /matched|filled/i.test(response.status ?? '');
        if (isMatched || response.success) {
            return { orderId: response.orderID, status: 'filled', filledSize: size, avgFillPrice: price, ackMs, fillMs };
        }

        return { orderId: response.orderID, status: 'cancelled', filledSize: 0, ackMs, fillMs };
    }

    // ── Sell (exit / cut-loss) ────────────────────────────────────────────────

    /**
     * Submit a market-sell FOK order to exit a position immediately.
     *
     * @param {Object} opts
     * @param {string} opts.tokenId
     * @param {number} opts.size        - Shares to sell
     * @param {number} opts.price       - Minimum acceptable sell price (5% slippage floor applied internally)
     * @param {string} opts.marketSlug
     */
    async submitSell({ tokenId, size, price, marketSlug }) {
        if (this._dryRun) {
            logger.trade(`[SIM] SELL ${marketSlug} | ${size} shares @ ~$${price}`);
            return { orderId: `sim_sell_${Date.now()}`, status: 'filled' };
        }

        const { tickSize, negRisk } = await this._getMarketOpts(tokenId);
        const minPrice = Math.max(price * 0.95, 0.01);

        logger.trade(`SELL ${marketSlug} | ${size} shares @ min $${minPrice.toFixed(4)}`);

        const response = await this._client.createAndPostMarketOrder(
            { tokenID: tokenId, side: Side.SELL, amount: size, price: minPrice },
            { tickSize, negRisk },
            OrderType.FOK,
        ).catch((err) => {
            logger.warn(`ExecutionEngine: sell error — ${err.message}`);
            return null;
        });

        const filled = response?.success ?? false;
        if (!filled) logger.warn(`ExecutionEngine: sell not filled — ${response?.errorMsg ?? 'unknown'}`);

        return { orderId: response?.orderID ?? null, status: filled ? 'filled' : 'failed' };
    }

    /**
     * Place a GTC limit-sell order for take-profit.
     * Returns the order ID so the caller can cancel it if exit conditions change.
     *
     * @param {Object} opts
     * @param {string} opts.tokenId
     * @param {number} opts.size       - Shares to sell
     * @param {number} opts.tpPrice    - Exact target sell price (aligned to tick size)
     * @param {string} opts.marketSlug
     */
    async submitTPOrder({ tokenId, size, tpPrice, marketSlug }) {
        if (this._dryRun) {
            logger.trade(`[SIM] TP ORDER ${marketSlug} | ${size} shares @ $${tpPrice}`);
            return { orderId: `sim_tp_${Date.now()}`, status: 'placed' };
        }

        const { tickSize, negRisk } = await this._getMarketOpts(tokenId);

        const response = await this._client.createAndPostOrder(
            { tokenID: tokenId, price: tpPrice.toString(), size, side: Side.SELL },
            { tickSize, negRisk },
            OrderType.GTC,
        ).catch((err) => {
            logger.warn(`ExecutionEngine: TP order error — ${err.message}`);
            return null;
        });

        const placed = response?.success ?? false;
        logger.info(`ExecutionEngine: TP order ${placed ? 'placed' : 'failed'} | ${marketSlug} @ $${tpPrice}`);

        return { orderId: response?.orderID ?? null, status: placed ? 'placed' : 'failed' };
    }

    /** Cancel an open order by order ID */
    async cancelOrder(orderId) {
        if (this._dryRun || !orderId) return;
        try {
            await this._client.cancelOrder({ orderID: orderId });
        } catch (err) {
            logger.warn(`ExecutionEngine: cancel failed for ${orderId} — ${err.message}`);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    async _getMarketOpts(tokenId) {
        if (this._tickCache.has(tokenId)) return this._tickCache.get(tokenId);

        let tickSize = '0.01';
        let negRisk  = false;

        try {
            tickSize = String(await this._client.getTickSize(tokenId) ?? '0.01');
            negRisk  = await this._client.getNegRisk(tokenId).catch(() => false) ?? false;
        } catch { /* use defaults */ }

        const opts = { tickSize, negRisk };
        this._tickCache.set(tokenId, opts);
        return opts;
    }

    /**
     * Wrap a promise with a hard timeout.
     * Resolves to null on timeout rather than rejecting — execution layer
     * treats null as a no-fill and transitions back to IDLE cleanly.
     */
    _withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve(null), ms)),
        ]);
    }
}

/**
 * @typedef {Object} FillResult
 * @property {string|null} orderId
 * @property {'filled'|'partial'|'cancelled'} status
 * @property {number} filledSize
 * @property {number} avgFillPrice
 * @property {number} ackMs
 * @property {number} fillMs
 */
