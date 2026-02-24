/**
 * SignalEngine.js
 * Steps C & D of the runtime sequence.
 *
 * Strategy: Dominant Side Hold
 * ────────────────────────────
 * Unlike a scalper that chases momentum on any side, this engine enters ONLY the
 * side that the market already considers the PROBABLE WINNER (mid > 50%).  The
 * position is then held to expiry (redeemed at $1.00 on-chain) rather than sold
 * back to the order book.
 *
 * Pipeline per features event:
 *   1. Hard gate check   — stale, TTE out of range, spread too wide, depth thin
 *   2. Dominant side     — compare up.mid vs down.mid; require a clear gap
 *   3. Mid threshold     — dominant side mid must be >= minDominantMid (e.g. 0.60)
 *   4. Composite score   — weighted (mid strength, imbalance, spread)
 *   5. Emit signal       — NO_TRADE (with reason) or ENTER_LONG / ENTER_SHORT
 *
 * Signal event shape:
 *   { ts, marketSlug, tteSec, signal, side, score, reason, snapshot, features }
 */

import { Signal, ReasonCode } from './constants.js';
import { dbg, DEBUG } from './debug.js';

// ── Score weights ──────────────────────────────────────────────────────────────
// Mid price strength is the most important factor — it reflects market consensus.
const W_MID       = 0.45;   // How strongly the market favours this side
const W_IMBALANCE = 0.35;   // Order-book depth confirms the dominant direction
const W_SPREAD    = 0.20;   // Execution cost (tight spread = better fill)

// ── Thresholds ─────────────────────────────────────────────────────────────────
const MIN_MID_GAP   = 0.05;  // Minimum |up.mid - down.mid| to consider a side dominant
const SPREAD_TIGHT  = 0.01;  // Spread considered tight
const SPREAD_MAX    = 0.02;  // Gate maximum (hard gate uses this too)
const IMB_STRONG    = 0.20;  // Strong bid-side depth dominance
const IMB_WEAK      = 0.05;  // Mild bid-side depth dominance

/** Throttle debug output: log detail every N evaluations per market */
const DEBUG_EVERY = 5;

export class SignalEngine {
    /**
     * @param {Object} opts
     * @param {import('./EventBus.js').default} opts.eventBus
     * @param {number}  opts.scoreThreshold   - Minimum score to trigger entry (0–1)
     * @param {number}  opts.minTopSize        - Minimum shares at best bid/ask for depth gate
     * @param {number}  opts.minDominantMid    - Dominant side must have mid >= this (e.g. 0.60)
     * @param {number}  [opts.tteMin=20]       - Minimum TTE in seconds
     * @param {number}  [opts.tteMax=90]       - Maximum TTE in seconds
     */
    constructor({ eventBus, scoreThreshold, minTopSize, minDominantMid = 0.60, tteMin = 20, tteMax = 90 }) {
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

        // Track evaluation count for throttled debug output
        const evalN = (this._evalCount.get(marketSlug) ?? 0) + 1;
        this._evalCount.set(marketSlug, evalN);
        const logThis = DEBUG && (evalN % DEBUG_EVERY === 1);

        // ── Step C: hard gate check ─────────────────────────────────────────

        const gate = this._hardGates(snapshot, tteSec);

        if (logThis) {
            if (!gate.pass) {
                dbg('GATE',
                    `${marketSlug} | tte=${tteSec}s | FAIL → ${gate.reason} | ` +
                    `upSprd=${snapshot.up.spread.toFixed(4)} dnSprd=${snapshot.down.spread.toFixed(4)} ` +
                    `upBidSz=${snapshot.up.bestBidSize.toFixed(1)} upAskSz=${snapshot.up.bestAskSize.toFixed(1)}`,
                );
            } else {
                dbg('GATE',
                    `${marketSlug} | tte=${tteSec}s | PASS | ` +
                    `upMid=${snapshot.up.mid.toFixed(4)} dnMid=${snapshot.down.mid.toFixed(4)}`,
                );
            }
        }

        if (!gate.pass) {
            this._emit(marketSlug, Signal.NO_TRADE, null, 0, gate.reason, ts, snapshot, feat);
            return;
        }

        // ── Step D: identify dominant side ──────────────────────────────────
        // The dominant side is whichever token the market prices higher.
        // We only ever buy the probable winner — never the underdog.

        const upMid   = snapshot.up.mid;
        const downMid = snapshot.down.mid;
        const midGap  = Math.abs(upMid - downMid);

        if (midGap < MIN_MID_GAP) {
            // Market is too balanced to pick a winner
            if (logThis) {
                dbg('SCORE',
                    `${marketSlug} | NO_DOMINANT | upMid=${upMid.toFixed(4)} dnMid=${downMid.toFixed(4)} ` +
                    `gap=${midGap.toFixed(4)} < ${MIN_MID_GAP}`,
                );
            }
            this._emit(marketSlug, Signal.NO_TRADE, null, 0, ReasonCode.SIG_NO_DOMINANT, ts, snapshot, feat);
            return;
        }

        const isDominantUp  = upMid > downMid;
        const dominantMid   = isDominantUp ? upMid   : downMid;
        const dominantBook  = isDominantUp ? snapshot.up   : snapshot.down;
        const dominantFeat  = isDominantUp ? feat.up  : feat.down;
        const signal        = isDominantUp ? Signal.ENTER_LONG : Signal.ENTER_SHORT;
        const side          = isDominantUp ? 'up' : 'down';

        // ── Minimum probability gate ─────────────────────────────────────────
        // Require the dominant token to be priced at least minDominantMid.
        // Below this threshold the market is too uncertain (e.g. 0.55 = only 55%
        // confident — not worth the binary risk of holding to expiry).

        if (dominantMid < this._minDominantMid) {
            if (logThis) {
                dbg('SCORE',
                    `${marketSlug} | ${side.toUpperCase()} | LOW_DOMINANT | ` +
                    `mid=${dominantMid.toFixed(4)} < ${this._minDominantMid}`,
                );
            }
            this._emit(marketSlug, Signal.NO_TRADE, null, 0, ReasonCode.SIG_LOW_DOMINANT, ts, snapshot, feat);
            return;
        }

        // ── Composite score ──────────────────────────────────────────────────

        const midScore       = this._scoreMid(dominantMid);
        const imbalanceScore = this._scoreImbalance(dominantFeat.imbalance);
        const spreadScore    = this._scoreSpread(dominantBook.spread);

        const score = W_MID * midScore + W_IMBALANCE * imbalanceScore + W_SPREAD * spreadScore;

        if (logThis) {
            dbg('SCORE',
                `${marketSlug} | ${side.toUpperCase()} dominant | mid=${dominantMid.toFixed(4)} gap=${midGap.toFixed(4)} | ` +
                `midS=${midScore.toFixed(2)} imbS=${imbalanceScore.toFixed(2)} sprdS=${spreadScore.toFixed(2)} ` +
                `→ score=${score.toFixed(3)} (need ${this._scoreThreshold})`,
            );
        }

        if (score < this._scoreThreshold) {
            this._emit(marketSlug, Signal.NO_TRADE, null, score, ReasonCode.SIG_SCORE_LOW, ts, snapshot, feat);
            return;
        }

        // Always log qualifying entries regardless of throttle
        dbg('SIGNAL',
            `>>> ${signal} | ${marketSlug} | mid=${dominantMid.toFixed(4)} ` +
            `score=${score.toFixed(3)} tte=${tteSec}s`,
        );

        this._emit(marketSlug, signal, side, score, null, ts, snapshot, feat);
    }

    // ── Hard gates ────────────────────────────────────────────────────────────

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

    // ── Scoring helpers ───────────────────────────────────────────────────────

    /**
     * Score how strongly the market favours this side.
     * Higher mid = market is more confident = higher score.
     *   0.60–0.69 → 0.4  (marginal dominance, acceptable)
     *   0.70–0.79 → 0.7  (solid dominance)
     *   0.80–0.89 → 0.9  (strong dominance)
     *   0.90+     → 1.0  (near-certain — but low payout)
     */
    _scoreMid(mid) {
        if (mid >= 0.90) return 1.0;
        if (mid >= 0.80) return 0.9;
        if (mid >= 0.70) return 0.7;
        if (mid >= 0.60) return 0.4;
        return 0;
    }

    /**
     * Score order-book imbalance for the dominant side.
     * Positive imbalance means more buy depth (bids > asks) — confirms direction.
     * A mildly negative imbalance is tolerated (some ask pressure is normal).
     */
    _scoreImbalance(imb) {
        if (imb >= IMB_STRONG) return 1.0;
        if (imb >= IMB_WEAK)   return 0.7;
        if (imb >= -0.10)      return 0.4;   // neutral to slight ask pressure — still ok
        if (imb >= -0.25)      return 0.1;   // notable selling pressure — cautious
        return 0;                             // strongly negative — skip
    }

    _scoreSpread(spread) {
        if (spread <= SPREAD_TIGHT) return 1.0;
        if (spread <= SPREAD_MAX)   return 0.5;
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
