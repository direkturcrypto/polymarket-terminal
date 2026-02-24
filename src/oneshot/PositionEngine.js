/**
 * PositionEngine.js
 * Step G of the runtime sequence.
 *
 * Maintains position state per market and evaluates exit conditions
 * on every incoming snapshot tick.
 *
 * Exit priority (highest → lowest):
 *   1. EXIT_TIME_FLATTEN  — TTE <= 12s (hard close, overrides everything)
 *   2. EXIT_TP_HIT        — Current bestBid >= entryPrice + tpTicks × tickSize
 *   3. EXIT_ADVERSE_MOVE  — Mid has dropped >= 2 ticks below entry
 *   4. EXIT_SLOPE_DROP    — Slope has been <= 0 continuously for >= 4 seconds
 *   5. EXIT_TIME_REDUCE   — TTE <= 20s (signals REDUCE_ONLY mode to orchestrator)
 */

import { ReasonCode } from './constants.js';

const HARD_FLATTEN_TTE  = 12;  // seconds
const REDUCE_TTE        = 20;  // seconds
const ADVERSE_TICKS     = 2;   // how many ticks below entry triggers adverse exit
const SLOPE_DROP_HOLD_MS = 4_000; // ms slope must remain <= 0 to trigger exit

export class PositionEngine {
    /**
     * @param {Object} opts
     * @param {number} opts.tpTicks  - Take-profit in ticks above entry price
     */
    constructor({ tpTicks = 1 }) {
        this._tpTicks = tpTicks;

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
            openedAt:       Date.now(),
            tpPrice:        this._roundToTick(entryPrice + this._tpTicks * tickSize, tickSize),
            _slopeDropTs:   null,   // timestamp when slope first went <= 0
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
     * Close the position and return exit data including realised P&L.
     *
     * @param {string} marketSlug
     * @param {number} exitPrice  - Actual fill price of the exit order
     * @returns {{ pnl: number, shares: number, entryPrice: number, exitPrice: number }}
     */
    close(marketSlug, exitPrice) {
        const pos = this._positions.get(marketSlug);
        if (!pos) return { pnl: 0, shares: 0, entryPrice: 0, exitPrice };

        const pnl = (exitPrice - pos.entryPrice) * pos.shares;
        this._positions.delete(marketSlug);

        return { pnl, shares: pos.shares, entryPrice: pos.entryPrice, exitPrice };
    }

    // ── Exit evaluation ────────────────────────────────────────────────────

    /**
     * Evaluate whether the current position should be exited.
     * Called on every snapshot tick while in POSITION_OPEN or REDUCE_ONLY state.
     *
     * @param {string} marketSlug
     * @param {Object} snapshot   - Current market snapshot
     * @param {Object|null} features  - Latest features from FeatureEngine (may be null)
     * @returns {{ shouldExit: boolean, reason: string|null, isReduceOnly: boolean }}
     */
    evaluateExit(marketSlug, snapshot, features) {
        const pos = this._positions.get(marketSlug);
        if (!pos) return { shouldExit: false, reason: null, isReduceOnly: false };

        const { tteSec } = snapshot;
        const bookSide   = pos.side === 'up' ? snapshot.up : snapshot.down;
        const sideFeat   = features ? (pos.side === 'up' ? features.up : features.down) : null;
        const now        = Date.now();

        // 1. Hard time flatten
        if (tteSec <= HARD_FLATTEN_TTE) {
            return { shouldExit: true, reason: ReasonCode.EXIT_TIME_FLATTEN, isReduceOnly: false };
        }

        // 2. Take-profit hit
        if (bookSide.bestBid >= pos.tpPrice) {
            return { shouldExit: true, reason: ReasonCode.EXIT_TP_HIT, isReduceOnly: false };
        }

        // 3. Adverse move: mid has fallen >= 2 ticks below entry
        const adverseFloor = pos.entryPrice - ADVERSE_TICKS * pos.tickSize;
        if (bookSide.mid < adverseFloor) {
            return { shouldExit: true, reason: ReasonCode.EXIT_ADVERSE_MOVE, isReduceOnly: false };
        }

        // 4. Slope drop: slope <= 0 sustained for SLOPE_DROP_HOLD_MS
        if (sideFeat) {
            if (sideFeat.midSlope6s <= 0) {
                if (!pos._slopeDropTs) {
                    // Start the slope-drop timer
                    this._positions.set(marketSlug, { ...pos, _slopeDropTs: now });
                } else if (now - pos._slopeDropTs >= SLOPE_DROP_HOLD_MS) {
                    return { shouldExit: true, reason: ReasonCode.EXIT_SLOPE_DROP, isReduceOnly: false };
                }
            } else {
                // Positive slope — reset the drop timer
                if (pos._slopeDropTs) {
                    this._positions.set(marketSlug, { ...pos, _slopeDropTs: null });
                }
            }
        }

        // 5. Reduce-only signal (non-exiting, just changes state in orchestrator)
        if (tteSec <= REDUCE_TTE) {
            return { shouldExit: false, reason: ReasonCode.EXIT_TIME_REDUCE, isReduceOnly: true };
        }

        return { shouldExit: false, reason: null, isReduceOnly: false };
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    _roundToTick(price, tickSize) {
        const factor = Math.round(1 / tickSize);
        return Math.round(price * factor) / factor;
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
 * @property {number} tpPrice
 * @property {number} openedAt
 * @property {number|null} _slopeDropTs
 */
