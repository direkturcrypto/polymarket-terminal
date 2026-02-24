/**
 * SignalEngine.js
 * Steps C & D of the runtime sequence.
 *
 * Pipeline per features event:
 *   1. Hard gate check  — immediately reject on any hard failure
 *   2. Side selection   — evaluate UP and DOWN sides independently
 *   3. Score            — weighted composite (imbalance, slope, spread, retrace)
 *   4. Trend confirm    — slope positive + retrace small
 *   5. Emit signal      — NO_TRADE (with reason) or ENTER_LONG / ENTER_SHORT
 *
 * Signal event shape:
 *   { ts, marketSlug, tteSec, signal, side, score, reason, snapshot, features }
 */

import { Signal, ReasonCode } from './constants.js';

// ── Score weights ──────────────────────────────────────────────────────────────
const W_IMBALANCE = 0.35;
const W_SLOPE     = 0.35;
const W_SPREAD    = 0.20;
const W_RETRACE   = 0.10;

// ── Scoring thresholds ─────────────────────────────────────────────────────────
const SLOPE_STRONG  = 0.0015;  // Strong momentum (price/sample)
const SLOPE_WEAK    = 0.0003;  // Weak-but-positive momentum
const IMB_STRONG    = 0.25;    // Strong bid-side dominance
const IMB_WEAK      = 0.08;    // Mild bid-side dominance
const SPREAD_TIGHT  = 0.01;    // Tight spread
const SPREAD_MAX    = 0.02;    // Gate maximum (hard gate uses this too)
const RETRACE_SMALL = 0.15;    // Essentially no retrace
const RETRACE_MID   = 0.35;    // Moderate retrace
const CONFIRM_SLOPE = 0.0001;  // Minimum positive slope for trend confirmation
const CONFIRM_RTRC  = 0.30;    // Maximum retrace for trend confirmation

export class SignalEngine {
    /**
     * @param {Object} opts
     * @param {import('./EventBus.js').default} opts.eventBus
     * @param {number}  opts.scoreThreshold  - Minimum score to trigger entry (0–1)
     * @param {number}  opts.minTopSize      - Minimum shares at best bid/ask for gate
     * @param {number}  [opts.tteMin=25]     - Minimum TTE in seconds (gate lower bound)
     * @param {number}  [opts.tteMax=120]    - Maximum TTE in seconds (gate upper bound)
     */
    constructor({ eventBus, scoreThreshold, minTopSize, tteMin = 25, tteMax = 120 }) {
        this._eventBus       = eventBus;
        this._scoreThreshold = scoreThreshold;
        this._minTopSize     = minTopSize;
        this._tteMin         = tteMin;
        this._tteMax         = tteMax;

        this._eventBus.on('features', (feat) => this._onFeatures(feat));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _onFeatures(feat) {
        const { ts, marketSlug, tteSec, up, down, snapshot } = feat;

        // ── Step C: hard gate check ─────────────────────────────────────────

        const gate = this._hardGates(snapshot, tteSec);
        if (!gate.pass) {
            this._emit(marketSlug, Signal.NO_TRADE, null, 0, gate.reason, ts, snapshot, feat);
            return;
        }

        // ── Step D: evaluate each side, pick best qualifying signal ─────────

        const upResult   = this._evaluateSide(up,   snapshot.up);
        const downResult = this._evaluateSide(down, snapshot.down);

        // Determine which side (if any) qualifies
        const upQual   = upResult.score   >= this._scoreThreshold && upResult.confirmed;
        const downQual = downResult.score >= this._scoreThreshold && downResult.confirmed;

        if (!upQual && !downQual) {
            // Emit the reason from whichever side had the higher score
            const dominant = upResult.score >= downResult.score ? upResult : downResult;
            const reason   = dominant.confirmed ? ReasonCode.SIG_SCORE_LOW : ReasonCode.SIG_NO_CONFIRM;
            this._emit(marketSlug, Signal.NO_TRADE, null, dominant.score, reason, ts, snapshot, feat);
            return;
        }

        // Pick the stronger qualifying side
        let signal;
        let side;
        let score;

        if (upQual && (!downQual || upResult.score >= downResult.score)) {
            signal = Signal.ENTER_LONG;
            side   = 'up';
            score  = upResult.score;
        } else {
            signal = Signal.ENTER_SHORT;
            side   = 'down';
            score  = downResult.score;
        }

        this._emit(marketSlug, signal, side, score, null, ts, snapshot, feat);
    }

    /**
     * Hard gates — any failure aborts the evaluation immediately.
     * @returns {{ pass: boolean, reason: string|null }}
     */
    _hardGates(snapshot, tteSec) {
        if (snapshot.stale)
            return { pass: false, reason: ReasonCode.GATE_STALE_BOOK };

        if (tteSec < this._tteMin || tteSec > this._tteMax)
            return { pass: false, reason: ReasonCode.GATE_TTE_FAIL };

        if (snapshot.up.spread > SPREAD_MAX || snapshot.down.spread > SPREAD_MAX)
            return { pass: false, reason: ReasonCode.GATE_SPREAD_WIDE };

        const thinUp   = snapshot.up.bestBidSize   < this._minTopSize
                      || snapshot.up.bestAskSize   < this._minTopSize;
        const thinDown = snapshot.down.bestBidSize < this._minTopSize
                      || snapshot.down.bestAskSize < this._minTopSize;

        if (thinUp && thinDown)
            return { pass: false, reason: ReasonCode.GATE_DEPTH_THIN };

        return { pass: true, reason: null };
    }

    /**
     * Score and confirm one side.
     * @param {Object} sideFeatures  - From FeatureEngine (midSlope6s, imbalance, ...)
     * @param {Object} sideBook      - Current BookSide from snapshot
     * @returns {{ score: number, confirmed: boolean }}
     */
    _evaluateSide(sideFeatures, sideBook) {
        const { midSlope6s, retrace3s, imbalance, spread } = sideFeatures;

        // Score components (each 0–1, then weighted)
        const slopeScore     = this._scoreSlope(midSlope6s);
        const imbalanceScore = this._scoreImbalance(imbalance);
        const spreadScore    = this._scoreSpread(spread);
        const retraceScore   = this._scoreRetrace(retrace3s);

        const score =
            W_SLOPE     * slopeScore     +
            W_IMBALANCE * imbalanceScore +
            W_SPREAD    * spreadScore    +
            W_RETRACE   * retraceScore;

        // Trend confirmation: positive momentum + low retrace
        const confirmed = midSlope6s > CONFIRM_SLOPE && retrace3s < CONFIRM_RTRC;

        return { score, confirmed };
    }

    // ── Scoring helpers ───────────────────────────────────────────────────────

    _scoreSlope(slope) {
        if (slope >= SLOPE_STRONG) return 1.0;
        if (slope >= SLOPE_WEAK)   return 0.5;
        if (slope > 0)             return 0.2;
        return 0;
    }

    _scoreImbalance(imb) {
        if (imb >= IMB_STRONG) return 1.0;
        if (imb >= IMB_WEAK)   return 0.5;
        if (imb > 0)           return 0.2;
        return 0;
    }

    _scoreSpread(spread) {
        if (spread <= SPREAD_TIGHT) return 1.0;
        if (spread <= SPREAD_MAX)   return 0.5;
        return 0;
    }

    _scoreRetrace(retrace) {
        if (retrace <= RETRACE_SMALL) return 1.0;
        if (retrace <= RETRACE_MID)   return 0.5;
        return 0;
    }

    _emit(marketSlug, signal, side, score, reason, ts, snapshot, features) {
        this._eventBus.emit('signal', {
            ts,
            marketSlug,
            tteSec:   snapshot.tteSec,
            signal,
            side,
            score,
            reason,
            snapshot,
            features,
        });
    }
}
