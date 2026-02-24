/**
 * RedeemEngine.js
 * Auto-redemption service for the OneShot Dominant Side Hold engine.
 *
 * When a market expires and the position is cleared, this service queues the
 * position and polls at a regular interval until the CTF contract shows a
 * non-zero payout denominator (i.e. the market has been resolved on-chain).
 * It then either:
 *   - DRY_RUN=true  → simulates the outcome, logs win/loss P&L
 *   - DRY_RUN=false → submits a real redeemPositions() transaction on Polygon
 *
 * Resolution flow:
 *   1. Gamma API check  → market.closed || market.resolved
 *   2. On-chain check   → CTF.payoutDenominator(conditionId) > 0
 *   3. Compute payout   → payouts[0] for UP (YES), payouts[1] for DOWN (NO)
 *   4. Execute / log
 *   5. Emit 'redemption:complete' on EventBus with final P&L
 *
 * Payout index mapping:
 *   side === 'up'   → outcome index 0 (YES / Up token)
 *   side === 'down' → outcome index 1 (NO  / Down token)
 */

import { ethers } from 'ethers';
import logger from '../utils/logger.js';
import { getPolygonProvider } from '../services/client.js';
import { redeemPosition, CTF_ADDRESS } from '../services/ctf.js';
import { dbg } from './debug.js';

// ── On-chain constants (read-only — no writes go through EOA) ─────────────────

const CTF_ABI = [
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

export class RedeemEngine {
    /**
     * @param {Object} opts
     * @param {boolean} opts.dryRun            - If true, simulate instead of real tx
     * @param {number}  [opts.pollIntervalMs]  - How often to check pending queue (ms)
     * @param {import('./EventBus.js').default} opts.eventBus
     */
    constructor({ dryRun, pollIntervalMs = 30_000, eventBus }) {
        this._dryRun    = dryRun;
        this._pollMs    = pollIntervalMs;
        this._eventBus  = eventBus;
        this._pollTimer = null;

        /**
         * @type {Map<string, PendingRedemption>}
         * Key: conditionId
         */
        this._queue = new Map();

        /** Prevent concurrent processing of the same conditionId */
        this._processing = new Set();
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    start() {
        this._pollTimer = setInterval(() => this._poll().catch(() => {}), this._pollMs);
        logger.info(`RedeemEngine: started | poll every ${this._pollMs / 1000}s | dryRun=${this._dryRun}`);
    }

    stop() {
        clearInterval(this._pollTimer);
        if (this._queue.size > 0) {
            logger.warn(`RedeemEngine: stopped — ${this._queue.size} position(s) still pending redemption:`);
            for (const [, item] of this._queue) {
                logger.warn(`  → ${item.marketSlug} | ${item.side.toUpperCase()} | ${item.shares} shares @ $${item.entryPrice.toFixed(4)}`);
            }
        } else {
            logger.info('RedeemEngine: stopped — no pending redemptions');
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Add an expired position to the redemption queue.
     * Safe to call multiple times — duplicate conditionIds are ignored.
     *
     * @param {Object}         data
     * @param {string}         data.conditionId
     * @param {string}         data.marketSlug
     * @param {'up'|'down'}    data.side
     * @param {number}         data.shares
     * @param {number}         data.entryPrice
     * @param {boolean}        data.negRisk
     */
    queueRedemption({ conditionId, marketSlug, side, shares, entryPrice, negRisk }) {
        if (!conditionId) {
            logger.warn(`RedeemEngine: missing conditionId for ${marketSlug} — skipping queue`);
            return;
        }
        if (this._queue.has(conditionId)) return;

        this._queue.set(conditionId, {
            conditionId,
            marketSlug,
            side,
            shares,
            entryPrice,
            negRisk: negRisk ?? false,
            queuedAt: Date.now(),
        });

        logger.info(
            `RedeemEngine: queued ${marketSlug} | ${side.toUpperCase()} | ` +
            `${shares} shares @ $${entryPrice.toFixed(4)} | pending on-chain resolution`,
        );

        // Trigger an immediate check rather than waiting for the first poll tick
        this._checkAndRedeem(this._queue.get(conditionId)).catch(() => {});
    }

    /** Number of positions waiting to be redeemed */
    get pendingCount() {
        return this._queue.size;
    }

    // ── Poll loop ─────────────────────────────────────────────────────────────

    async _poll() {
        if (this._queue.size === 0) return;
        dbg('REDEEM', `poll — ${this._queue.size} pending: [${[...this._queue.keys()].map((id) => id.slice(0, 8) + '...').join(', ')}]`);

        for (const [, item] of this._queue) {
            if (this._processing.has(item.conditionId)) continue;
            this._processing.add(item.conditionId);
            this._checkAndRedeem(item)
                .catch((err) => logger.error(`RedeemEngine: error on ${item.marketSlug} — ${err.message}`))
                .finally(() => this._processing.delete(item.conditionId));
        }
    }

    // ── Resolution check ──────────────────────────────────────────────────────

    async _checkAndRedeem(item) {
        // Always use on-chain as ground truth for payout data
        const onChain = await this._checkOnChainPayout(item.conditionId);

        if (!onChain.resolved) {
            // Gamma API as a secondary status check (informational only)
            const gammaResolved = await this._checkGammaResolution(item.conditionId);
            const secWaiting    = Math.floor((Date.now() - item.queuedAt) / 1000);

            dbg('REDEEM',
                `${item.marketSlug} | not yet settled on-chain | ` +
                `gammaResolved=${gammaResolved} | waited=${secWaiting}s`,
            );
            return; // retry on next poll tick
        }

        await this._settle(item, onChain.payouts);
    }

    // ── Settlement ────────────────────────────────────────────────────────────

    async _settle(item, payouts) {
        // UP token = outcome index 0 (YES), DOWN token = outcome index 1 (NO)
        const outcomeIdx     = item.side === 'up' ? 0 : 1;
        const payoutFraction = payouts[outcomeIdx] ?? 0;
        const won            = payoutFraction > 0;
        const received       = payoutFraction * item.shares;   // USDC back from CTF
        const cost           = item.entryPrice * item.shares;  // USDC paid at entry
        const pnl            = received - cost;

        if (this._dryRun) {
            // Simulate: just log the outcome without touching the chain
            this._logSettlement(item, won, pnl, received, cost);
        } else {
            // Real redemption: submit on-chain tx
            const success = await this._executeRedeem(item);
            if (!success) {
                // tx failed — keep in queue, retry on next poll
                logger.warn(`RedeemEngine: redemption tx failed for ${item.marketSlug} — will retry`);
                return;
            }
            this._logSettlement(item, won, pnl, received, cost);
        }

        // Clear from queue and notify orchestrator
        this._queue.delete(item.conditionId);

        this._eventBus.emit('redemption:complete', {
            conditionId: item.conditionId,
            marketSlug:  item.marketSlug,
            side:        item.side,
            won,
            pnl,
            shares:      item.shares,
            entryPrice:  item.entryPrice,
        });
    }

    _logSettlement(item, won, pnl, received, cost) {
        const tag = this._dryRun ? '[SIM]' : '';

        if (won) {
            const pct = cost > 0 ? ((pnl / cost) * 100).toFixed(1) : '0.0';
            logger.money(
                `${tag} RedeemEngine WIN | ${item.marketSlug} | ${item.side.toUpperCase()} won | ` +
                `+$${pnl.toFixed(4)} (+${pct}%) | ` +
                `${item.shares} shares: paid $${cost.toFixed(4)} → received $${received.toFixed(4)}`,
            );
        } else {
            logger.error(
                `${tag} RedeemEngine LOSS | ${item.marketSlug} | ${item.side.toUpperCase()} lost | ` +
                `-$${cost.toFixed(4)} (-100%) | ${item.shares} shares @ $${item.entryPrice.toFixed(4)}`,
            );
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    async _checkGammaResolution(conditionId) {
        try {
            const url  = `${config.gammaHost}/markets?condition_id=${conditionId}`;
            const resp = await fetch(url);
            if (!resp.ok) return false;
            const markets = await resp.json();
            if (!Array.isArray(markets) || markets.length === 0) return false;
            const m = markets[0];
            return !!(m.closed || m.resolved);
        } catch {
            return false;
        }
    }

    /**
     * Read payoutNumerators and payoutDenominator from the CTF contract.
     * Returns resolved=true only when denominator > 0 (market has been settled).
     */
    async _checkOnChainPayout(conditionId) {
        try {
            const provider = await getPolygonProvider();
            const ctf      = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

            const denom = await ctf.payoutDenominator(conditionId);
            if (denom.isZero()) return { resolved: false, payouts: [] };

            const payouts = [];
            for (let i = 0; i < 2; i++) {
                const num = await ctf.payoutNumerators(conditionId, i);
                payouts.push(num.toNumber() / denom.toNumber());
            }
            return { resolved: true, payouts };
        } catch {
            return { resolved: false, payouts: [] };
        }
    }

    /** Submit redeemPositions() via Gnosis Safe proxy wallet (same path as MM) */
    async _executeRedeem(item) {
        try {
            logger.info(`RedeemEngine: submitting redeem tx | ${item.marketSlug}...`);
            await redeemPosition(item.conditionId, item.negRisk);
            logger.success(`RedeemEngine: redeemed | ${item.marketSlug}`);
            return true;
        } catch (err) {
            logger.error(`RedeemEngine: tx error | ${item.marketSlug} — ${err.message}`);
            return false;
        }
    }
}

/**
 * @typedef {Object} PendingRedemption
 * @property {string}      conditionId
 * @property {string}      marketSlug
 * @property {'up'|'down'} side
 * @property {number}      shares
 * @property {number}      entryPrice
 * @property {boolean}     negRisk
 * @property {number}      queuedAt   - timestamp when queued
 */
