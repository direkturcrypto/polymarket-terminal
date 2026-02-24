/**
 * RiskEngine.js
 * Step H of the runtime sequence.
 *
 * Global risk enforcement across all markets in the same session:
 *
 *   Consecutive loss cap  — after N consecutive losses, enter COOLDOWN for
 *                           `cooldownRounds` market opportunities
 *   Daily loss cap        — if total daily P&L drops below -dailyLossCap,
 *                           HALT all trading for the rest of the day
 *
 * All policy violations are surfaced via canTrade() so the orchestrator
 * can gate entries without needing direct access to internal state.
 */

import logger from '../utils/logger.js';
import { ReasonCode } from './constants.js';

export class RiskEngine {
    /**
     * @param {Object} opts
     * @param {number} opts.maxConsecLosses  - Consecutive losses before cooldown
     * @param {number} opts.cooldownRounds   - Market slots to skip during cooldown
     * @param {number} opts.dailyLossCap     - Max cumulative daily loss in USDC (positive number)
     */
    constructor({ maxConsecLosses = 2, cooldownRounds = 3, dailyLossCap = 20 }) {
        this._maxConsecLosses = maxConsecLosses;
        this._cooldownRounds  = cooldownRounds;
        this._dailyLossCap    = dailyLossCap;

        this._dailyPnl      = 0;
        this._consecLosses  = 0;
        this._cooldownLeft  = 0;
        this._halted        = false;

        this._sessionStart  = Date.now();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Check whether a new entry is allowed.
     * @returns {{ ok: boolean, reason: string|null, halted: boolean }}
     */
    canTrade() {
        if (this._halted) {
            return { ok: false, reason: ReasonCode.RISK_DAILY_CAP, halted: true };
        }
        if (this._cooldownLeft > 0) {
            return { ok: false, reason: ReasonCode.RISK_CONSEC_LOSS, halted: false };
        }
        return { ok: true, reason: null, halted: false };
    }

    /** True if the engine is in cooldown (but not halted) */
    isCooldown() {
        return !this._halted && this._cooldownLeft > 0;
    }

    /** True if trading has been permanently halted for today */
    isHalted() {
        return this._halted;
    }

    /**
     * Record the P&L of a closed position and update risk counters.
     * @param {number} pnl - Realised P&L in USDC (negative = loss)
     */
    recordResult(pnl) {
        this._dailyPnl += pnl;

        if (pnl < 0) {
            this._consecLosses++;

            if (this._consecLosses >= this._maxConsecLosses) {
                this._cooldownLeft = this._cooldownRounds;
                logger.warn(
                    `RiskEngine: ${this._consecLosses} consecutive losses — ` +
                    `entering cooldown for ${this._cooldownRounds} rounds`,
                );
            }
        } else {
            // Reset consecutive loss streak on any win
            this._consecLosses = 0;
        }

        // Daily cap check
        if (this._dailyPnl <= -Math.abs(this._dailyLossCap)) {
            this._halted = true;
            logger.error(
                `RiskEngine: daily loss cap hit ($${this._dailyPnl.toFixed(2)}) — ` +
                `trading HALTED for the rest of the session`,
            );
        }

        this._logState(pnl);
    }

    /**
     * Decrement the cooldown counter by one market slot.
     * Called by the orchestrator each time a new market opportunity is seen
     * while in cooldown mode.
     */
    decrementCooldown() {
        if (this._cooldownLeft > 0) {
            this._cooldownLeft--;
            logger.info(`RiskEngine: cooldown rounds remaining: ${this._cooldownLeft}`);

            if (this._cooldownLeft === 0) {
                this._consecLosses = 0;
                logger.success('RiskEngine: cooldown lifted — resuming normal trading');
            }
        }
    }

    /** Current session statistics snapshot */
    stats() {
        return {
            dailyPnl:     this._dailyPnl,
            consecLosses: this._consecLosses,
            cooldownLeft: this._cooldownLeft,
            halted:       this._halted,
        };
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _logState(pnl) {
        const sign  = pnl >= 0 ? '+' : '';
        const stats = this.stats();
        logger.info(
            `RiskEngine: pnl=${sign}$${pnl.toFixed(4)} | ` +
            `daily=$${stats.dailyPnl.toFixed(4)} | ` +
            `streak=${stats.consecLosses} | ` +
            `cooldown=${stats.cooldownLeft}`,
        );
    }
}
