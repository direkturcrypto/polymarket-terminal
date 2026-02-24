/**
 * FeatureEngine.js
 * Step B of the runtime sequence.
 *
 * Maintains a rolling 15-second buffer of market snapshots per market
 * and computes the following features on each incoming snapshot:
 *
 *   midSlope6s   — Linear regression slope of the mid price over the last 6s
 *                  (positive = upward momentum, unit: price change per second)
 *   retrace3s    — Fractional pullback from the 6s rolling peak to current mid
 *                  (0 = no retrace, 1 = fully retraced to baseline)
 *   imbalance    — (depthBid - depthAsk) / (depthBid + depthAsk)
 *                  (positive = buyers dominate, negative = sellers dominate)
 *   spread       — Current bestAsk - bestBid
 *   depthTop3    — Sum of the top-3 bid levels (buy-side depth at best prices)
 *
 * Features are computed independently for both UP and DOWN book sides.
 *
 * Emits a 'features' event on the event bus with shape:
 *   { ts, marketSlug, tteSec, up: SideFeatures, down: SideFeatures, snapshot }
 */

const BUFFER_WINDOW_MS = 15_000;
const SLOPE_WINDOW_MS  =  6_000;
const RETRACE_PEAK_MS  =  6_000;  // Look-back window for peak in retrace calc
const DEPTH_TOP_N      = 3;

export class FeatureEngine {
    /**
     * @param {Object} opts
     * @param {import('./EventBus.js').default} opts.eventBus
     */
    constructor({ eventBus }) {
        this._eventBus = eventBus;

        /** @type {Map<string, Array<{ts, up_mid, down_mid, up_spread, up_depthBid, up_depthAsk, up_bestBidSize, up_bestAskSize, down_spread, down_depthBid, down_depthAsk, down_bestBidSize, down_bestAskSize}>>} */
        this._buffers  = new Map();

        /** @type {Map<string, Object>} Most recent features per market */
        this._latest   = new Map();

        this._eventBus.on('snapshot', (snap) => this._onSnapshot(snap));
    }

    /** Retrieve the most recently computed features for a given market */
    getLatest(marketSlug) {
        return this._latest.get(marketSlug) ?? null;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _onSnapshot(snap) {
        const { marketSlug, ts, tteSec, up, down } = snap;

        // Add to rolling buffer
        if (!this._buffers.has(marketSlug)) this._buffers.set(marketSlug, []);
        const buf = this._buffers.get(marketSlug);

        buf.push({
            ts,
            up_mid:           up.mid,
            up_spread:        up.spread,
            up_depthBid:      up.depthBid,
            up_depthAsk:      up.depthAsk,
            up_bestBidSize:   up.bestBidSize,
            up_bestAskSize:   up.bestAskSize,
            down_mid:         down.mid,
            down_spread:      down.spread,
            down_depthBid:    down.depthBid,
            down_depthAsk:    down.depthAsk,
            down_bestBidSize: down.bestBidSize,
            down_bestAskSize: down.bestAskSize,
        });

        // Evict entries older than the buffer window
        const cutoff = ts - BUFFER_WINDOW_MS;
        while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();

        const features = {
            ts,
            marketSlug,
            tteSec,
            up:       this._computeSideFeatures(buf, 'up',   up),
            down:     this._computeSideFeatures(buf, 'down', down),
            snapshot: snap,
        };

        this._latest.set(marketSlug, features);
        this._eventBus.emit('features', features);
    }

    /**
     * Compute all features for one book side using the rolling buffer.
     *
     * @param {Array}  buf        - Rolling buffer entries (ascending ts)
     * @param {string} side       - 'up' or 'down'
     * @param {Object} currentBook - Live BookSide from current snapshot
     */
    _computeSideFeatures(buf, side, currentBook) {
        const now    = buf[buf.length - 1]?.ts ?? Date.now();
        const midKey = `${side}_mid`;

        // Slice for slope window (last 6s)
        const slopeBuf = buf.filter((e) => e.ts >= now - SLOPE_WINDOW_MS);
        const mids6s   = slopeBuf.map((e) => e[midKey]);

        // Slice for retrace peak look-back (last 6s)
        const retraceBuf = buf.filter((e) => e.ts >= now - RETRACE_PEAK_MS);
        const midsRetrace = retraceBuf.map((e) => e[midKey]);

        const midSlope6s = this._linearSlope(mids6s);
        const retrace3s  = this._retrace(midsRetrace, currentBook.mid);

        // Imbalance from depth
        const totalDepth = currentBook.depthBid + currentBook.depthAsk;
        const imbalance  = totalDepth > 0
            ? (currentBook.depthBid - currentBook.depthAsk) / totalDepth
            : 0;

        // Top-3 bid depth from current book
        const depthTop3 = currentBook.bids
            .slice(0, DEPTH_TOP_N)
            .reduce((s, l) => s + l.size, 0);

        return {
            midSlope6s,
            retrace3s,
            imbalance,
            spread:     currentBook.spread,
            depthTop3,
            bufLen:     slopeBuf.length, // diagnostic
        };
    }

    /**
     * Ordinary least-squares slope through an array of mid-price values.
     * Returns slope in units of "price change per sample interval".
     * Returns 0 if fewer than 2 data points are available.
     */
    _linearSlope(values) {
        const n = values.length;
        if (n < 2) return 0;

        const meanX = (n - 1) / 2;
        const meanY = values.reduce((a, b) => a + b, 0) / n;

        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
            const dx = i - meanX;
            num += dx * (values[i] - meanY);
            den += dx * dx;
        }
        return den === 0 ? 0 : num / den;
    }

    /**
     * Fractional retrace: how far the current mid has pulled back from
     * the rolling peak within the look-back window.
     *
     *   0 = price is at its peak (no retrace)
     *   1 = price is at its trough (full retrace)
     */
    _retrace(mids, currentMid) {
        if (mids.length === 0) return 0;

        const peak   = Math.max(...mids, currentMid);
        const trough = Math.min(...mids, currentMid);
        const range  = peak - trough;

        if (range < 1e-9) return 0;
        return Math.max(0, (peak - currentMid) / range);
    }
}
