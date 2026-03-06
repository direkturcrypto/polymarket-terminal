/**
 * makerWs.js
 * WebSocket client for Polymarket CLOB orderbook + trade data.
 * Used by the simulation to display real-time orderbook and simulate fills.
 *
 * Message formats from CLOB WS:
 *   1. Book snapshot (initial): [{asset_id, bids, asks, timestamp, hash}] (array, no event_type)
 *   2. price_change: {event_type:"price_change", price_changes:[{asset_id, price, size, side, best_bid, best_ask}]}
 *   3. last_trade_price: {event_type:"last_trade_price", asset_id, price}
 */

import WebSocket from 'ws';
import logger from '../utils/logger.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL = 30_000;
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_DELAY = 30_000;

export class OrderbookWs {
    constructor() {
        this.ws = null;
        this.pingTimer = null;
        this.reconnectTimer = null;
        this.reconnectDelay = RECONNECT_DELAY;
        this.isShutdown = false;

        // Subscribed assets
        this.assetIds = [];
        this.conditionId = null;

        // Orderbook state per asset: Map<price, size>
        this.bids = new Map(); // assetId → Map<price, size>
        this.asks = new Map(); // assetId → Map<price, size>

        // Best bid/ask per asset (from price_change events)
        this.bestBid = new Map(); // assetId → number
        this.bestAsk = new Map(); // assetId → number

        // Recent trades per asset
        this.trades = new Map(); // assetId → [{ price, side, size, timestamp }]

        // Last trade price per asset
        this.lastPrice = new Map(); // assetId → number

        // Callbacks
        this.onBookUpdate = null;
        this.onTradeUpdate = null;
        this.onPriceUpdate = null;
    }

    subscribe(conditionId, assetIds) {
        // Shutdown existing connection if any
        if (this.ws) {
            this.cleanup(false);
        }

        this.conditionId = conditionId;
        this.assetIds = assetIds;
        this.isShutdown = false;

        for (const id of assetIds) {
            this.bids.set(id, new Map());
            this.asks.set(id, new Map());
            this.trades.set(id, []);
        }

        this.connect();
    }

    connect() {
        if (this.isShutdown) return;

        this.ws = new WebSocket(WS_URL);

        this.ws.on('open', () => {
            logger.info('MAKER WS: connected to orderbook feed');
            this.reconnectDelay = RECONNECT_DELAY;

            // Subscribe to all assets in one message
            const msg = {
                auth: {},
                type: 'subscribe',
                markets: [],
                assets_ids: this.assetIds,
                channels: ['book'],
            };
            this.ws.send(JSON.stringify(msg));

            this.startPing();
        });

        this.ws.on('message', (raw) => {
            this.handleMessage(raw);
        });

        this.ws.on('ping', () => {
            this.ws?.pong();
        });

        this.ws.on('close', (code, reason) => {
            logger.warn(`MAKER WS: disconnected (${code})`);
            this.cleanup(true);
        });

        this.ws.on('error', (err) => {
            logger.warn(`MAKER WS error: ${err.message}`);
            this.cleanup(true);
        });
    }

    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        // Initial book snapshot comes as an array [{...}]
        if (Array.isArray(msg)) {
            for (const evt of msg) {
                if (evt.asset_id && evt.bids) {
                    this.handleBookSnapshot(evt.asset_id, evt);
                }
            }
            return;
        }

        // Subsequent messages are objects with event_type
        switch (msg.event_type) {
            case 'book':
                if (msg.asset_id) {
                    this.handleBookSnapshot(msg.asset_id, msg);
                }
                break;

            case 'price_change':
                this.handlePriceChange(msg);
                break;

            case 'last_trade_price':
                if (msg.asset_id) {
                    this.handleLastPrice(msg.asset_id, msg);
                }
                break;

            default:
                // Full book updates without event_type (non-array single object)
                if (msg.asset_id && msg.bids) {
                    this.handleBookSnapshot(msg.asset_id, msg);
                }
                break;
        }
    }

    handleBookSnapshot(assetId, evt) {
        if (!this.assetIds.includes(assetId)) return;

        // Replace entire book for this asset
        const bidMap = new Map();
        for (const b of (evt.bids || [])) {
            const price = parseFloat(b.price);
            const size = parseFloat(b.size);
            if (size > 0) bidMap.set(price, size);
        }
        this.bids.set(assetId, bidMap);

        const askMap = new Map();
        for (const a of (evt.asks || [])) {
            const price = parseFloat(a.price);
            const size = parseFloat(a.size);
            if (size > 0) askMap.set(price, size);
        }
        this.asks.set(assetId, askMap);

        if (this.onBookUpdate) {
            this.onBookUpdate(assetId, this.getBook(assetId));
        }
    }

    handlePriceChange(msg) {
        const changes = msg.price_changes || [];

        for (const change of changes) {
            const assetId = change.asset_id;
            if (!assetId || !this.assetIds.includes(assetId)) continue;

            const price = parseFloat(change.price);
            const size = parseFloat(change.size);
            const side = change.side; // "BUY" = bid, "SELL" = ask

            if (side === 'BUY') {
                const bidMap = this.bids.get(assetId);
                if (bidMap) {
                    if (size > 0) {
                        bidMap.set(price, size);
                    } else {
                        bidMap.delete(price); // size 0 = remove level
                    }
                }
            } else if (side === 'SELL') {
                const askMap = this.asks.get(assetId);
                if (askMap) {
                    if (size > 0) {
                        askMap.set(price, size);
                    } else {
                        askMap.delete(price);
                    }
                }
            }

            // Update best bid/ask from the event
            if (change.best_bid) this.bestBid.set(assetId, parseFloat(change.best_bid));
            if (change.best_ask) this.bestAsk.set(assetId, parseFloat(change.best_ask));
        }

        // Notify for each affected asset
        const affectedAssets = new Set(changes.map(c => c.asset_id).filter(id => this.assetIds.includes(id)));
        for (const assetId of affectedAssets) {
            if (this.onBookUpdate) {
                this.onBookUpdate(assetId, this.getBook(assetId));
            }
        }
    }

    handleLastPrice(assetId, evt) {
        if (!this.assetIds.includes(assetId)) return;
        const price = parseFloat(evt.price || '0');
        this.lastPrice.set(assetId, price);

        if (this.onPriceUpdate) {
            this.onPriceUpdate(assetId, price);
        }
    }

    /**
     * Get sorted orderbook for an asset
     */
    getBook(assetId) {
        const bidMap = this.bids.get(assetId) || new Map();
        const askMap = this.asks.get(assetId) || new Map();

        const bids = Array.from(bidMap.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => b.price - a.price);

        const asks = Array.from(askMap.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => a.price - b.price);

        return { bids, asks };
    }

    /**
     * Check if a simulated order would fill based on current orderbook.
     */
    checkSimFill(assetId, side, price, size) {
        const book = this.getBook(assetId);

        if (side === 'buy') {
            const eligible = book.asks.filter((a) => a.price <= price);
            if (eligible.length === 0) return null;

            let filled = 0;
            let totalCost = 0;
            for (const ask of eligible) {
                const take = Math.min(ask.size, size - filled);
                filled += take;
                totalCost += take * ask.price;
                if (filled >= size) break;
            }

            if (filled > 0) {
                return { filled: Math.min(filled, size), avgPrice: totalCost / filled };
            }
        } else {
            const eligible = book.bids.filter((b) => b.price >= price);
            if (eligible.length === 0) return null;

            let filled = 0;
            let totalRevenue = 0;
            for (const bid of eligible) {
                const take = Math.min(bid.size, size - filled);
                filled += take;
                totalRevenue += take * bid.price;
                if (filled >= size) break;
            }

            if (filled > 0) {
                return { filled: Math.min(filled, size), avgPrice: totalRevenue / filled };
            }
        }

        return null;
    }

    getLastPrice(assetId) {
        return this.lastPrice.get(assetId) || 0;
    }

    getBestBid(assetId) {
        // Try from price_change data first, fallback to computed from book
        const cached = this.bestBid.get(assetId);
        if (cached) return cached;
        const book = this.getBook(assetId);
        return book.bids[0]?.price || 0;
    }

    getBestAsk(assetId) {
        const cached = this.bestAsk.get(assetId);
        if (cached) return cached;
        const book = this.getBook(assetId);
        return book.asks[0]?.price || 0;
    }

    getRecentTrades(assetId, limit = 10) {
        const trades = this.trades.get(assetId) || [];
        return trades.slice(-limit);
    }

    startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping(); // Use proper WebSocket ping frames
            }
        }, PING_INTERVAL);
    }

    stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    cleanup(reconnect = true) {
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.terminate();
            }
            this.ws = null;
        }
        if (reconnect && !this.isShutdown) {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
                this.connect();
            }, this.reconnectDelay);
        }
    }

    shutdown() {
        this.isShutdown = true;
        this.cleanup(false);
    }
}
