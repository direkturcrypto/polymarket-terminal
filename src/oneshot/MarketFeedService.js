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
 * Snapshot shape:
 *   { ts, marketSlug, conditionId, tteSec, tickSize, up: BookSide, down: BookSide, stale }
 *
 * BookSide shape:
 *   { tokenId, bids, asks, bestBid, bestAsk, mid, spread, depthBid, depthAsk }
 */

import logger from '../utils/logger.js';
import { dbg, DEBUG } from './debug.js';

const GAMMA_HOST         = 'https://gamma-api.polymarket.com';
const STALE_THRESHOLD_MS = 1500;
const TOP_N_LEVELS       = 5;    // Levels counted for depth calculation
const DISCOVER_INTERVAL  = 30_000; // Re-scan for new markets every 30s
const DEBUG_POLL_EVERY   = 10;   // Log a poll summary every N ticks per market (debug only)

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
        this._client       = client;
        this._assets       = assets;
        this._duration     = duration;
        this._durationMin  = duration === '15m' ? 15 : 5;
        this._pollMs       = pollIntervalMs;
        this._eventBus     = eventBus;

        /** @type {Map<string, MarketRecord>} slug → market record */
        this._markets      = new Map();

        this._pollTimer     = null;
        this._discoverTimer = null;

        /** Per-market tick counter for throttled debug logs */
        this._pollCount    = new Map();
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
        const durationMin = this._durationMin;

        // Probe current slot and the immediately upcoming slot
        const slots = [
            this._slotTs(),
            this._slotTs() + durationMin * 60,
        ];

        dbg('FEED', `--- discovery cycle | probing ${this._assets.length * slots.length} slug(s) ---`);

        for (const asset of this._assets) {
            for (const slotTs of slots) {
                const slug = `${asset}-updown-${this._duration}-${slotTs}`;

                if (this._markets.has(slug)) {
                    dbg('FEED', `  ${slug} → already tracked, skip`);
                    continue;
                }

                dbg('FEED', `  probing ${slug} ...`);

                try {
                    const market = await this._fetchMarketBySlug(slug);

                    if (!market) {
                        dbg('FEED', `  ${slug} → not found on Gamma API`);
                        continue;
                    }

                    const endTs = this._parseEndTs(market);
                    if (!endTs) {
                        dbg('FEED', `  ${slug} → found but endTs unparseable`);
                        continue;
                    }
                    if (Date.now() >= endTs) {
                        dbg('FEED', `  ${slug} → found but already expired`);
                        continue;
                    }

                    const { upTokenId, downTokenId } = this._extractTokenIds(market);
                    if (!upTokenId || !downTokenId) {
                        logger.warn(`MarketFeedService: could not extract token IDs for ${slug}`);
                        dbg('FEED', `  tokens shape: ${JSON.stringify(Object.keys(market).slice(0, 10))}`);
                        continue;
                    }

                    const tickSize = await this._fetchTickSize(upTokenId);

                    this._markets.set(slug, {
                        slug,
                        conditionId: market.conditionId || market.condition_id,
                        upTokenId,
                        downTokenId,
                        endTs,
                        tickSize,
                        negRisk: market.negRisk || market.neg_risk || false,
                    });

                    const secLeft = Math.floor((endTs - Date.now()) / 1000);
                    logger.success(`MarketFeedService: tracking ${slug} (closes in ${secLeft}s)`);
                    dbg('FEED', `  upToken=${upTokenId.slice(0, 12)}... downToken=${downTokenId.slice(0, 12)}... tick=${tickSize}`);

                } catch (err) {
                    dbg('FEED', `  ${slug} → discovery error: ${err.message}`);
                    // Network blip — will retry on next discovery cycle
                }
            }
        }

        // Prune expired markets (5s grace period for final snapshots)
        for (const [slug, mkt] of this._markets) {
            if (Date.now() > mkt.endTs + 5_000) {
                this._markets.delete(slug);
                this._pollCount.delete(slug);
                logger.info(`MarketFeedService: pruned expired market ${slug}`);
            }
        }

        if (this._markets.size === 0) {
            dbg('FEED', 'No active markets found — will retry in 30s');
        } else {
            dbg('FEED', `Active markets: [${[...this._markets.keys()].join(', ')}]`);
        }
    }

    /** Deterministic UTC slot boundary timestamp (seconds) */
    _slotTs() {
        const slotMs = this._durationMin * 60_000;
        return Math.floor(Date.now() / slotMs) * slotMs / 1000;
    }

    async _fetchMarketBySlug(slug) {
        const url  = `${GAMMA_HOST}/markets?slug=${encodeURIComponent(slug)}&limit=1`;
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        const market = Array.isArray(data) ? data[0] : data;
        return market?.conditionId || market?.condition_id ? market : null;
    }

    _parseEndTs(market) {
        // endDate contains the full datetime (e.g. "2026-02-24T06:35:00Z").
        // endDateIso is date-only ("2026-02-24") and parses to midnight UTC —
        // which is already in the past by market-open time, so it must come last.
        const raw = market.endDate || market.end_date || market.endDateIso || market.end_date_iso;
        if (!raw) return null;
        const ts = new Date(raw).getTime();
        return Number.isFinite(ts) ? ts : null;
    }

    _extractTokenIds(market) {
        let upTokenId   = null;
        let downTokenId = null;

        // Shape 1: tokens[] array with { tokenId, outcome }
        const tokens = market.tokens;
        if (Array.isArray(tokens)) {
            for (const t of tokens) {
                const outcome = String(t.outcome || t.title || '').toLowerCase();
                const id      = t.tokenId || t.token_id || t.id || t.asset;
                if (!id) continue;
                if (outcome.includes('up') || outcome === 'yes') upTokenId   = String(id);
                if (outcome.includes('down') || outcome === 'no') downTokenId = String(id);
            }
        }

        // Shape 2: clobTokenIds[0/1]
        if ((!upTokenId || !downTokenId) && Array.isArray(market.clobTokenIds) && market.clobTokenIds.length >= 2) {
            upTokenId   = upTokenId   ?? String(market.clobTokenIds[0]);
            downTokenId = downTokenId ?? String(market.clobTokenIds[1]);
        }

        return { upTokenId, downTokenId };
    }

    async _fetchTickSize(tokenId) {
        try {
            const ts = await this._client.getTickSize(tokenId);
            return parseFloat(ts) || 0.01;
        } catch {
            return 0.01;
        }
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

                // ── Debug: throttled poll summary (every N ticks) ─────────────
                if (DEBUG) {
                    const count = (this._pollCount.get(mkt.slug) ?? 0) + 1;
                    this._pollCount.set(mkt.slug, count);

                    if (count % DEBUG_POLL_EVERY === 1) {
                        const u = snapshot.up;
                        const d = snapshot.down;
                        const staleFlag = stale ? ' [STALE]' : '';
                        dbg('POLL',
                            `${mkt.slug} | tte=${tteSec}s | fetchMs=${fetchMs}ms${staleFlag}\n` +
                            `         UP   bid=${u.bestBid.toFixed(4)}/ask=${u.bestAsk.toFixed(4)} ` +
                                `spread=${u.spread.toFixed(4)} mid=${u.mid.toFixed(4)} ` +
                                `depthBid=${u.depthBid.toFixed(1)} depthAsk=${u.depthAsk.toFixed(1)}\n` +
                            `         DOWN bid=${d.bestBid.toFixed(4)}/ask=${d.bestAsk.toFixed(4)} ` +
                                `spread=${d.spread.toFixed(4)} mid=${d.mid.toFixed(4)} ` +
                                `depthBid=${d.depthBid.toFixed(1)} depthAsk=${d.depthAsk.toFixed(1)}`,
                        );
                    }
                }

            } catch (err) {
                dbg('POLL', `${mkt.slug} → poll error: ${err.message}`);
            }
        }
    }

    _buildSnapshot(mkt, upBook, downBook, tteSec, stale) {
        return {
            ts:          Date.now(),
            marketSlug:  mkt.slug,
            conditionId: mkt.conditionId,
            tteSec,
            tickSize:    mkt.tickSize,
            negRisk:     mkt.negRisk,
            up:          this._buildSide(mkt.upTokenId,   upBook),
            down:        this._buildSide(mkt.downTokenId, downBook),
            stale:       stale || this._isBooksEmpty(upBook, downBook),
        };
    }

    _buildSide(tokenId, book) {
        const parse  = (raw = []) =>
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

    _isBooksEmpty(upBook, downBook) {
        const isEmpty = (b) => !b || (!Array.isArray(b.bids) && !Array.isArray(b.asks));
        return isEmpty(upBook) || isEmpty(downBook);
    }
}
