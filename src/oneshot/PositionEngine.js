/**
 * PositionEngine.js
 * Step G of the runtime sequence.
 *
 * Maintains position state per market and evaluates exit conditions
 * on every incoming snapshot tick.
 *
 * Strategy: Hold to Expiry (Dominant Side)
 * ─────────────────────────────────────────
 * Positions entered on the dominant (probable winner) side are held until
 * the market expires and the payout is claimed via the on-chain redeemer.
 * There are no take-profit sells, no momentum-based exits.
 *
 * Exit conditions (priority order):
 *   1. EXIT_EXPIRED       — TTE <= 0: market has closed, pending on-chain redemption
 *   2. EXIT_ADVERSE_MOVE  — Token mid has collapsed below the stop-loss floor
 *                           (configurable absolute threshold, e.g. 0.20)
 *                           Protects against a complete market reversal while still
 *                           allowing normal price fluctuations in the dominant range.
 */

import { ReasonCode } from './constants.js';

export class PositionEngine {
    /**
     * @param {Object} opts
     * @param {number} [opts.stopLossMid=0.20]  - Exit if token mid falls below this absolute level.
     *                                            Set to 0 to disable the stop-loss entirely.
     */
    constructor({ stopLossMid = 0.20 } = {}) {
        this._stopLossMid = stopLossMid;

        /** @type {Map<string, PositionState>} */
        this._positions = new Map();
    }

    // ── Position lifecycle ─────────────────────────────────────────────────

    /**
     * Record a newly filled position.
     *
     * @param {string} marketSlug
     * @param {Object} data
     * @param {string} data.tokenId
     * @param {'up'|'down'} data.side
     * @param {number} data.shares
     * @param {number} data.entryPrice
     * @param {number} data.tickSize
     */
    open(marketSlug, { tokenId, side, shares, entryPrice, tickSize }) {
        this._positions.set(marketSlug, {
            marketSlug,
            tokenId,
            side,
            shares,
            entryPrice,
            tickSize,
            openedAt: Date.now(),
        });
    }

    /** @returns {PositionState|null} */
    getPosition(marketSlug) {
        return this._positions.get(marketSlug) ?? null;
    }

    hasPosition(marketSlug) {
        return this._positions.has(marketSlug);
    }

    /**
     * Close the position actively (adverse-move emergency exit) and return exit data.
     *
     * @param {string} marketSlug
     * @param {number} exitPrice  - Actual fill price of the sell order
     * @returns {{ pnl: number, shares: number, entryPrice: number, exitPrice: number }}
     */
    close(marketSlug, exitPrice) {
        const pos = this._positions.get(marketSlug);
        if (!pos) return { pnl: 0, shares: 0, entryPrice: 0, exitPrice };

        const pnl = (exitPrice - pos.entryPrice) * pos.shares;
        this._positions.delete(marketSlug);

        return { pnl, shares: pos.shares, entryPrice: pos.entryPrice, exitPrice };
    }

    /**
     * Mark a position as expired (market closed, pending on-chain redemption).
     * Does NOT compute final P&L — that is settled by the redeemer service.
     *
     * @param {string} marketSlug
     * @returns {PositionState|null}
     */
    closeExpired(marketSlug) {
        const pos = this._positions.get(marketSlug) ?? null;
        if (pos) this._positions.delete(marketSlug);
        return pos;
    }

    // ── Exit evaluation ────────────────────────────────────────────────────

    /**
     * Evaluate whether the current position should be exited.
     * Called on every snapshot tick while in POSITION_OPEN state.
     *
     * @param {string} marketSlug
     * @param {Object} snapshot   - Current market snapshot
     * @returns {{ shouldExit: boolean, reason: string|null, isExpired: boolean }}
     */
    evaluateExit(marketSlug, snapshot) {
        const pos = this._positions.get(marketSlug);
        if (!pos) return { shouldExit: false, reason: null, isExpired: false };

        const { tteSec } = snapshot;
        const bookSide   = pos.side === 'up' ? snapshot.up : snapshot.down;

        // 1. Market expired — hand off to on-chain redeemer
        if (tteSec <= 0) {
            return { shouldExit: false, reason: ReasonCode.EXIT_EXPIRED, isExpired: true };
        }

        // 2. Catastrophic stop-loss: token has completely collapsed
        //    (market reversed strongly against us — salvage remaining value)
        if (this._stopLossMid > 0 && bookSide.mid < this._stopLossMid) {
            return { shouldExit: true, reason: ReasonCode.EXIT_ADVERSE_MOVE, isExpired: false };
        }

        return { shouldExit: false, reason: null, isExpired: false };
    }
}

/**
 * @typedef {Object} PositionState
 * @property {string} marketSlug
 * @property {string} tokenId
 * @property {'up'|'down'} side
 * @property {number} shares
 * @property {number} entryPrice
 * @property {number} tickSize
 * @property {number} openedAt
 */
