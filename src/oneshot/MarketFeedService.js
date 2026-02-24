/**
 * MarketFeedService.js
 * Step A of the runtime sequence.
 *
 * Responsibilities:
 *   1. Discover active 5m/15m UP↑DOWN↓ markets for configured assets via Gamma API
 *   2. Poll the CLOB orderbook for both UP and DOWN tokens every pollIntervalMs
 *   3. Normalise raw book data into a consistent snapshot format
 *   4. Detect stale books (no levels, or fetch latency > STALE_THRESHOLD_MS)
 *   5. Emit 'snapshot' events on the event bus
 *
 * Market discovery mirrors the logic in sniperDetector.js / mmDetector.js:
 *   - API endpoint:  /markets/slug/{slug}   (not /markets?slug=...)
 *   - Token IDs:     clobTokenIds[0/1]      (JSON string parsed if needed)
 *   - Tick size:     market.orderPriceMinTickSize  (no separate API call)
 *   - Slot formula:  Math.floor(Date.now()/1000/SLOT_SEC) * SLOT_SEC
 *
 * Snapshot shape:
 *   { ts, marketSlug, conditionId, tteSec, tickSize, up: BookSide, down: BookSide, stale }
 *
 * BookSide shape:
 *   { tokenId, bids, asks, bestBid, bestAsk, mid, spread, depthBid, depthAsk,
 *     bestBidSize, bestAskSize }
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { dbg, DEBUG } from './debug.js';

const STALE_THRESHOLD_MS = 1500;
const TOP_N_LEVELS       = 5;      // Levels counted for depth calculation
const DISCOVER_INTERVAL  = 30_000; // Re-scan for new markets every 30s
const DEBUG_POLL_EVERY   = 10;     // Throttle: log one poll summary every N ticks

export class MarketFeedService {
    /**
     * @param {Object} opts
     * @param {import('@polymarket/clob-client').ClobClient} opts.client
     * @param {string[]}  opts.assets          - e.g. ['btc', 'eth', 'sol']
     * @param {string}    opts.duration         - '5m' or '15m'
     * @param {number}    opts.pollIntervalMs   - Book poll cadence in ms (200–500)
     * @param {import('./EventBus.js').default} opts.eventBus
     */
    constructor({ client, assets, duration = '5m', pollIntervalMs = 300, eventBus }) {
        this._client      = client;
        this._assets      = assets;
        this._duration    = duration;
        this._slotSec     = duration === '15m' ? 900 : 300; // same as sniperDetector/mmDetector
        this._pollMs      = pollIntervalMs;
        this._eventBus    = eventBus;

        /** @type {Map<string, MarketRecord>} slug → market record */
        this._markets     = new Map();

        this._pollTimer    = null;
        this._discoverTimer = null;

        /** Per-market tick counter for throttled debug logs */
        this._pollCount   = new Map();
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async start() {
        await this._discoverMarkets();
        this._pollTimer     = setInterval(() => this._tick().catch(() => {}), this._pollMs);
        this._discoverTimer = setInterval(() => this._discoverMarkets().catch(() => {}), DISCOVER_INTERVAL);
        logger.info(`MarketFeedService: started | assets=[${this._assets}] interval=${this._pollMs}ms`);
        if (DEBUG) logger.info('[DBG:FEED] Debug mode ON — verbose feed logging enabled');
    }

    stop() {
        clearInterval(this._pollTimer);
        clearInterval(this._discoverTimer);
        logger.info('MarketFeedService: stopped');
    }

    /** Active market slugs currently being polled */
    get activeMarkets() {
        return [...this._markets.keys()];
    }

    // ── Market discovery ──────────────────────────────────────────────────────

    async _discoverMarkets() {
        // Probe current slot AND next upcoming slot (same as sniperDetector)
        const curr = this._currentSlot();
        const next = curr + this._slotSec;
        const slots = [curr, next];

        dbg('FEED', `--- discovery cycle | curr=${curr} next=${next} | probing ${this._assets.length * 2} slug(s) ---`);

        for (const asset of this._assets) {
            for (const slotTs of slots) {
                const slug = `${asset}-updown-${this._duration}-${slotTs}`;

                if (this._markets.has(slug)) {
                    dbg('FEED', `  ${slug} → already tracked`);
                    continue;
                }

                dbg('FEED', `  probing ${slug} ...`);

                try {
                    // ── Use /markets/slug/{slug} — same endpoint as sniperDetector ──
                    const market = await this._fetchBySlug(slug);

                    if (!market) {
                        dbg('FEED', `  ${slug} → not found (API returned null)`);
                        continue;
                    }

                    // ── Extract end time ─────────────────────────────────────────
                    // endDate  = "2026-02-24T06:35:00Z" (full datetime — use this)
                    // endDateIso = "2026-02-24" (date only, parses to midnight UTC — skip)
                    const endTs = this._parseEndTs(market);
                    if (!endTs) {
                        dbg('FEED', `  ${slug} → found but endDate unparseable (keys: ${Object.keys(market).slice(0, 8).join(',')})`);
                        continue;
                    }
                    if (Date.now() >= endTs) {
                        dbg('FEED', `  ${slug} → found but expired (endTs=${new Date(endTs).toISOString()})`);
                        continue;
                    }

                    // ── Extract token IDs — same logic as sniperDetector/mmDetector ──
                    const { upTokenId, downTokenId } = this._extractTokenIds(market);
                    if (!upTokenId || !downTokenId) {
                        logger.warn(`MarketFeedService: missing token IDs for ${slug}`);
                        dbg('FEED', `  clobTokenIds raw: ${JSON.stringify(market.clobTokenIds)}`);
                        continue;
                    }

                    // ── Tick size from market object — same as mmDetector ────────
                    const tickSize = parseFloat(
                        market.orderPriceMinTickSize ??
                        market.minimum_tick_size ??
                        market.minimumTickSize ??
                        '0.01',
                    ) || 0.01;

                    const negRisk = market.negRisk ?? market.neg_risk ?? false;

                    this._markets.set(slug, {
                        slug,
                        conditionId: market.conditionId || market.condition_id,
                        upTokenId,
                        downTokenId,
                        endTs,
                        tickSize,
                        negRisk,
                    });

                    const secLeft = Math.floor((endTs - Date.now()) / 1000);
                    logger.success(`MarketFeedService: tracking ${slug} (closes in ${secLeft}s)`);
                    dbg('FEED',
                        `  up=${upTokenId.slice(0, 16)}... ` +
                        `down=${downTokenId.slice(0, 16)}... ` +
                        `tick=${tickSize} negRisk=${negRisk}`,
                    );

                } catch (err) {
                    dbg('FEED', `  ${slug} → error: ${err.message}`);
                    // Network blip — will retry on next cycle
                }
            }
        }

        // Prune markets that have fully expired (5s grace for final snapshots)
        for (const [slug, mkt] of this._markets) {
            if (Date.now() > mkt.endTs + 5_000) {
                this._markets.delete(slug);
                this._pollCount.delete(slug);
                logger.info(`MarketFeedService: pruned ${slug}`);
            }
        }

        if (this._markets.size === 0) {
            dbg('FEED', 'No active markets — retrying in 30s');
        } else {
            dbg('FEED', `Tracking: [${[...this._markets.keys()].join(', ')}]`);
        }
    }

    // ── Slot helpers (identical to sniperDetector / mmDetector) ──────────────

    _currentSlot() {
        return Math.floor(Date.now() / 1000 / this._slotSec) * this._slotSec;
    }

    // ── Gamma API ─────────────────────────────────────────────────────────────

    /** Uses /markets/slug/{slug} — the same direct endpoint as sniperDetector */
    async _fetchBySlug(slug) {
        const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        // Returns a single object (not an array) when using the slug endpoint
        return data?.conditionId || data?.condition_id ? data : null;
    }

    _parseEndTs(market) {
        // endDate  = "2026-02-24T06:35:00Z" → correct full datetime
        // endDateIso = "2026-02-24" → date-only, parses to midnight UTC (wrong!)
        const raw = market.endDate || market.end_date || market.endDateIso || market.end_date_iso;
        if (!raw) return null;
        const ts = new Date(raw).getTime();
        return Number.isFinite(ts) ? ts : null;
    }

    /**
     * Extract UP/DOWN token IDs using the same logic as sniperDetector / mmDetector.
     *
     * clobTokenIds may be:
     *   - a real JS array:   ["123...", "456..."]
     *   - a JSON string:     '["123...","456..."]'
     * UP  = clobTokenIds[0]  (YES / Up)
     * DOWN = clobTokenIds[1] (NO  / Down)
     */
    _extractTokenIds(market) {
        let tokenIds = market.clobTokenIds ?? market.clob_token_ids;

        // Unwrap JSON string if the API returned it encoded
        if (typeof tokenIds === 'string') {
            try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
        }

        let upTokenId   = null;
        let downTokenId = null;

        if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
            [upTokenId, downTokenId] = tokenIds.map(String);
        } else if (Array.isArray(market.tokens) && market.tokens.length >= 2) {
            // Fallback: named tokens array (less common)
            upTokenId   = String(market.tokens[0]?.token_id ?? market.tokens[0]?.tokenId ?? '');
            downTokenId = String(market.tokens[1]?.token_id ?? market.tokens[1]?.tokenId ?? '');
            if (!upTokenId || !downTokenId) { upTokenId = null; downTokenId = null; }
        }

        return { upTokenId, downTokenId };
    }

    // ── Book polling ──────────────────────────────────────────────────────────

    async _tick() {
        if (this._markets.size === 0) return;

        for (const [, mkt] of this._markets) {
            const tteSec = Math.floor((mkt.endTs - Date.now()) / 1000);
            if (tteSec <= 0) continue;

            const fetchStart = Date.now();

            try {
                const [upBook, downBook] = await Promise.all([
                    this._client.getOrderBook(mkt.upTokenId),
                    this._client.getOrderBook(mkt.downTokenId),
                ]);

                const fetchMs = Date.now() - fetchStart;
                const stale   = fetchMs > STALE_THRESHOLD_MS;

                const snapshot = this._buildSnapshot(mkt, upBook, downBook, tteSec, stale);
                this._eventBus.emit('snapshot', snapshot);

                // ── Throttled debug poll summary ──────────────────────────────
                if (DEBUG) {
                    const count = (this._pollCount.get(mkt.slug) ?? 0) + 1;
                    this._pollCount.set(mkt.slug, count);

                    if (count % DEBUG_POLL_EVERY === 1) {
                        const u = snapshot.up;
                        const d = snapshot.down;
                        dbg('POLL',
                            `${mkt.slug} | tte=${tteSec}s | fetchMs=${fetchMs}ms${stale ? ' [STALE]' : ''}\n` +
                            `         UP   bid=${u.bestBid.toFixed(4)}/ask=${u.bestAsk.toFixed(4)} ` +
                                `sprd=${u.spread.toFixed(4)} mid=${u.mid.toFixed(4)} ` +
                                `dBid=${u.depthBid.toFixed(1)} dAsk=${u.depthAsk.toFixed(1)}\n` +
                            `         DOWN bid=${d.bestBid.toFixed(4)}/ask=${d.bestAsk.toFixed(4)} ` +
                                `sprd=${d.spread.toFixed(4)} mid=${d.mid.toFixed(4)} ` +
                                `dBid=${d.depthBid.toFixed(1)} dAsk=${d.depthAsk.toFixed(1)}`,
                        );
                    }
                }

            } catch (err) {
                dbg('POLL', `${mkt.slug} → poll error: ${err.message}`);
            }
        }
    }

    // ── Snapshot builder ──────────────────────────────────────────────────────

    _buildSnapshot(mkt, upBook, downBook, tteSec, stale) {
        const up   = this._buildSide(mkt.upTokenId,   upBook);
        const down = this._buildSide(mkt.downTokenId, downBook);
        return {
            ts:          Date.now(),
            marketSlug:  mkt.slug,
            conditionId: mkt.conditionId,
            tteSec,
            tickSize:    mkt.tickSize,
            negRisk:     mkt.negRisk,
            up,
            down,
            stale:       stale || up.bestBid === 0 || down.bestBid === 0,
        };
    }

    _buildSide(tokenId, book) {
        const parse = (raw = []) =>
            (Array.isArray(raw) ? raw : [])
                .filter((l) => l?.price && l?.size)
                .map((l)    => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                .filter((l) => l.price > 0 && l.size > 0);

        const bids = parse(book?.bids).sort((a, b) => b.price - a.price);
        const asks = parse(book?.asks).sort((a, b) => a.price - b.price);

        const bestBid  = bids[0]?.price ?? 0;
        const bestAsk  = asks[0]?.price ?? 1;
        const mid      = bestBid > 0 && bestAsk < 1
            ? (bestBid + bestAsk) / 2
            : (bestBid || bestAsk || 0.5);
        const spread   = Math.max(0, bestAsk - bestBid);

        const topN     = Math.min(TOP_N_LEVELS, Math.max(bids.length, asks.length));
        const depthBid = bids.slice(0, topN).reduce((s, l) => s + l.size, 0);
        const depthAsk = asks.slice(0, topN).reduce((s, l) => s + l.size, 0);

        return {
            tokenId,
            bids,
            asks,
            bestBid,
            bestAsk,
            mid,
            spread,
            depthBid,
            depthAsk,
            bestBidSize: bids[0]?.size ?? 0,
            bestAskSize: asks[0]?.size ?? 0,
        };
    }
}
