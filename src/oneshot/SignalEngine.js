/**
 * SignalEngine.js
 * Steps C & D of the runtime sequence.
 *
 * Strategy: Dominant Side Hold — Momentum-Aware Entry
 * ────────────────────────────────────────────────────
 * Enters ONLY the side that the market already prices as probable winner
 * (mid > 50%) AND whose price is either rising or stable.
 *
 * "Follow where the odds are moving" — midSlope6s from FeatureEngine is now
 * a first-class scoring factor.  A dominant side that is actively FADING
 * (slope < SLOPE_CANCEL) is blocked entirely even if its mid is still > 0.60,
 * because a fading dominant signals a potential reversal.
 *
 * Entry pipeline (per 'features' event):
 *   1. Hard gates      — stale, TTE out of [tteMin, tteMax], spread > SPREAD_MAX, depth thin
 *   2. Dominant side   — identify which token the market prices higher; require mid gap >= MIN_MID_GAP
 *   3. Min probability — dominant mid must be >= minDominantMid (e.g. 0.58)
 *   4. Momentum gate   — dominant midSlope6s must be >= SLOPE_CANCEL (not actively fading)
 *   5. Score           — weighted: mid strength (35%) + momentum (30%) + imbalance (20%) + spread (15%)
 *   6. Threshold       — score >= scoreThreshold
 *
 * Key parameter changes vs previous version:
 *   - SPREAD_MAX: 0.02 → 0.04  (near-expiry books often have 0.03 spread)
 *   - tteMax:       90 → 150s  (catch direction when it is being established)
 *   - Added W_MOMENTUM = 0.30  (replaces old W_SLOPE/W_RETRACE scalper metrics)
 *   - Added momentum gate (SIG_FADING_DOMINANT) to block reversals
 */

import { Signal, ReasonCode } from './constants.js';
import { dbg, DEBUG } from './debug.js';

// ── Score weights ──────────────────────────────────────────────────────────────
const W_MID       = 0.35;   // How strongly the market prices this side as winner
const W_MOMENTUM  = 0.30;   // Is the dominant odds direction being maintained?
const W_IMBALANCE = 0.20;   // Order-book depth confirms the direction
const W_SPREAD    = 0.15;   // Execution cost (less critical for hold-to-expiry)

// ── Gate thresholds ────────────────────────────────────────────────────────────
const SPREAD_MAX   = 0.04;    // Hard gate: spread wider than this → skip
const MIN_MID_GAP  = 0.08;    // Hard gate: |up.mid - down.mid| must exceed this

// ── Momentum constants ─────────────────────────────────────────────────────────
// SLOPE_CANCEL: if dominant side's 6s slope is below this, the market may be
// reversing — block entry even if mid is still above threshold.
const SLOPE_CANCEL = -0.0020; // Active fade = potential reversal, do not enter
const SLOPE_STRONG = 0.0020;  // Clearly rising — best signal
const SLOPE_MILD   = 0.0005;  // Gently rising — still good

// ── Imbalance constants ────────────────────────────────────────────────────────
const IMB_STRONG = 0.20;
const IMB_WEAK   = 0.05;

/** Throttle debug output: log detail every N evaluations per market */
const DEBUG_EVERY = 5;

export class SignalEngine {
    /**
     * @param {Object} opts
     * @param {import('./EventBus.js').default} opts.eventBus
     * @param {number}  opts.scoreThreshold   - Minimum composite score to trigger entry (0–1)
     * @param {number}  opts.minTopSize        - Minimum shares at best bid/ask for depth gate
     * @param {number}  opts.minDominantMid    - Dominant side mid must be >= this (e.g. 0.58)
     * @param {number}  [opts.tteMin=15]       - Minimum TTE in seconds
     * @param {number}  [opts.tteMax=150]      - Maximum TTE in seconds
     */
    constructor({ eventBus, scoreThreshold, minTopSize, minDominantMid = 0.58, tteMin = 15, tteMax = 150 }) {
        this._eventBus        = eventBus;
        this._scoreThreshold  = scoreThreshold;
        this._minTopSize      = minTopSize;
        this._minDominantMid  = minDominantMid;
        this._tteMin          = tteMin;
        this._tteMax          = tteMax;

        /** Per-market evaluation counter for throttled debug logs */
        this._evalCount = new Map();

        this._eventBus.on('features', (feat) => this._onFeatures(feat));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _onFeatures(feat) {
        const { ts, marketSlug, tteSec, snapshot } = feat;

        const evalN = (this._evalCount.get(marketSlug) ?? 0) + 1;
        this._evalCount.set(marketSlug, evalN);
        const logThis = DEBUG && (evalN % DEBUG_EVERY === 1);

        // ── Step C: hard gates ──────────────────────────────────────────────

        const gate = this._hardGates(snapshot, tteSec);

        if (logThis) {
            if (!gate.pass) {
                dbg('GATE',
                    `${marketSlug} | tte=${tteSec}s | FAIL → ${gate.reason} | ` +
                    `upSprd=${snapshot.up.spread.toFixed(3)} dnSprd=${snapshot.down.spread.toFixed(3)} ` +
                    `upMid=${snapshot.up.mid.toFixed(3)} dnMid=${snapshot.down.mid.toFixed(3)}`,
                );
            } else {
                dbg('GATE',
                    `${marketSlug} | tte=${tteSec}s | PASS | ` +
                    `upMid=${snapshot.up.mid.toFixed(3)} dnMid=${snapshot.down.mid.toFixed(3)}`,
                );
            }
        }

        if (!gate.pass) {
            this._emit(marketSlug, Signal.NO_TRADE, null, 0, gate.reason, ts, snapshot, feat);
            return;
        }

        // ── Step D1: identify dominant side ─────────────────────────────────
        // The dominant side is whichever token the market prices higher.

        const upMid   = snapshot.up.mid;
        const downMid = snapshot.down.mid;
        const midGap  = Math.abs(upMid - downMid);

        if (midGap < MIN_MID_GAP) {
            if (logThis) {
                dbg('SCORE',
                    `${marketSlug} | NO_DOMINANT | upMid=${upMid.toFixed(3)} dnMid=${downMid.toFixed(3)} ` +
                    `gap=${midGap.toFixed(3)} < ${MIN_MID_GAP}`,
                );
            }
            this._emit(marketSlug, Signal.NO_TRADE, null, 0, ReasonCode.SIG_NO_DOMINANT, ts, snapshot, feat);
            return;
        }

        const isDominantUp = upMid > downMid;
        const dominantMid  = isDominantUp ? upMid   : downMid;
        const dominantBook = isDominantUp ? snapshot.up   : snapshot.down;
        const dominantFeat = isDominantUp ? feat.up  : feat.down;
        const signal       = isDominantUp ? Signal.ENTER_LONG : Signal.ENTER_SHORT;
        const side         = isDominantUp ? 'up' : 'down';
        const slope        = dominantFeat?.midSlope6s ?? 0;

        // ── Step D2: minimum probability gate ───────────────────────────────

        if (dominantMid < this._minDominantMid) {
            if (logThis) {
                dbg('SCORE',
                    `${marketSlug} | ${side.toUpperCase()} | LOW_DOMINANT | ` +
                    `mid=${dominantMid.toFixed(3)} < ${this._minDominantMid}`,
                );
            }
            this._emit(marketSlug, Signal.NO_TRADE, null, 0, ReasonCode.SIG_LOW_DOMINANT, ts, snapshot, feat);
            return;
        }

        // ── Step D3: momentum gate ───────────────────────────────────────────
        // If the dominant side's price is actively falling, the market may be
        // reversing.  A fading dominant is more dangerous than a weak dominant.

        if (slope < SLOPE_CANCEL) {
            if (logThis) {
                dbg('SCORE',
                    `${marketSlug} | ${side.toUpperCase()} | FADING | ` +
                    `slope=${slope.toFixed(5)} < ${SLOPE_CANCEL} (reversal risk)`,
                );
            }
            this._emit(marketSlug, Signal.NO_TRADE, null, 0, ReasonCode.SIG_FADING_DOMINANT, ts, snapshot, feat);
            return;
        }

        // ── Step D4: composite score ─────────────────────────────────────────

        const midScore       = this._scoreMid(dominantMid);
        const momentumScore  = this._scoreMomentum(slope);
        const imbalanceScore = this._scoreImbalance(dominantFeat?.imbalance ?? 0);
        const spreadScore    = this._scoreSpread(dominantBook.spread);

        const score =
            W_MID       * midScore       +
            W_MOMENTUM  * momentumScore  +
            W_IMBALANCE * imbalanceScore +
            W_SPREAD    * spreadScore;

        if (logThis) {
            dbg('SCORE',
                `${marketSlug} | ${side.toUpperCase()} dominant | ` +
                `mid=${dominantMid.toFixed(3)} gap=${midGap.toFixed(3)} slope=${slope.toFixed(5)} | ` +
                `midS=${midScore.toFixed(2)} momS=${momentumScore.toFixed(2)} ` +
                `imbS=${imbalanceScore.toFixed(2)} sprdS=${spreadScore.toFixed(2)} ` +
                `→ score=${score.toFixed(3)} (need ${this._scoreThreshold})`,
            );
        }

        if (score < this._scoreThreshold) {
            this._emit(marketSlug, Signal.NO_TRADE, null, score, ReasonCode.SIG_SCORE_LOW, ts, snapshot, feat);
            return;
        }

        // Always log qualifying entries regardless of throttle
        dbg('SIGNAL',
            `>>> ${signal} | ${marketSlug} | ` +
            `mid=${dominantMid.toFixed(3)} slope=${slope.toFixed(5)} ` +
            `score=${score.toFixed(3)} tte=${tteSec}s`,
        );

        this._emit(marketSlug, signal, side, score, null, ts, snapshot, feat);
    }

    // ── Hard gates ────────────────────────────────────────────────────────────

    _hardGates(snapshot, tteSec) {
        if (snapshot.stale)
            return { pass: false, reason: ReasonCode.GATE_STALE_BOOK };

        if (tteSec < this._tteMin || tteSec > this._tteMax)
            return { pass: false, reason: ReasonCode.GATE_TTE_FAIL };

        // Use the dominant side's spread only — underdog's spread is irrelevant
        // since we never buy the underdog.
        const dominantSpread = Math.min(snapshot.up.spread, snapshot.down.spread);
        if (dominantSpread > SPREAD_MAX)
            return { pass: false, reason: ReasonCode.GATE_SPREAD_WIDE };

        // Require adequate depth on at least one side (dominant side check happens after)
        const thinUp   = snapshot.up.bestBidSize   < this._minTopSize
                      || snapshot.up.bestAskSize   < this._minTopSize;
        const thinDown = snapshot.down.bestBidSize < this._minTopSize
                      || snapshot.down.bestAskSize < this._minTopSize;

        if (thinUp && thinDown)
            return { pass: false, reason: ReasonCode.GATE_DEPTH_THIN };

        return { pass: true, reason: null };
    }

    // ── Scoring helpers ───────────────────────────────────────────────────────

    /**
     * Score market confidence in the dominant side.
     * Higher mid price = market is more certain = higher score.
     * Entry "sweet spot" is 0.60–0.80 (clear direction, still worth holding).
     */
    _scoreMid(mid) {
        if (mid >= 0.85) return 1.00;
        if (mid >= 0.75) return 0.85;
        if (mid >= 0.65) return 0.65;
        if (mid >= 0.58) return 0.40;
        return 0;
    }

    /**
     * Score the momentum (direction) of the dominant side's price movement.
     * This is the "follow where the odds are moving" factor.
     *
     * Positive slope = dominant side is getting more expensive = conviction increasing.
     * Flat slope     = direction held, acceptable.
     * Mild negative  = slight give-back, cautious but still allowed.
     * SLOPE_CANCEL   = actively fading = blocked by momentum gate before reaching here.
     */
    _scoreMomentum(slope) {
        if (slope >= SLOPE_STRONG) return 1.00;   // Strong, fast move in dominant direction
        if (slope >= SLOPE_MILD)   return 0.75;   // Steady climb
        if (slope >= 0)            return 0.50;   // Flat / holding
        if (slope >= -0.0005)      return 0.20;   // Slight give-back — cautious
        return 0.05;                              // Between -0.0005 and SLOPE_CANCEL — marginal
    }

    /**
     * Score order-book imbalance for the dominant side.
     * Positive = more buy depth on dominant side = confirms direction.
     * Mildly negative = tolerated (sellers exist on winner too, normal).
     */
    _scoreImbalance(imb) {
        if (imb >= IMB_STRONG) return 1.00;
        if (imb >= IMB_WEAK)   return 0.70;
        if (imb >= -0.10)      return 0.40;   // Neutral to slight sell pressure
        if (imb >= -0.25)      return 0.10;   // Notable sell pressure
        return 0;
    }

    /**
     * Score execution cost (spread).
     * For hold-to-expiry the spread is paid once at entry, so wider spreads
     * are more tolerated than in a scalping strategy — hence 4 tiers up to SPREAD_MAX.
     */
    _scoreSpread(spread) {
        if (spread <= 0.01) return 1.00;
        if (spread <= 0.02) return 0.70;
        if (spread <= 0.03) return 0.40;
        if (spread <= 0.04) return 0.10;
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
