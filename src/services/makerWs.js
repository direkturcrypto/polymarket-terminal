/**
 * makerWs.js
 * WebSocket client for Polymarket CLOB orderbook + trade data.
 * Used by the simulation to display real-time orderbook and simulate fills.
 *
 * Endpoints:
 *   - Book updates (bids/asks)
 *   - Last trade price
 *   - Trade history
 */

import WebSocket from 'ws';
import logger from '../utils/logger.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL = 10_000;
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

        // Orderbook state per asset
        this.books = new Map(); // assetId → { bids: [], asks: [] }

        // Recent trades per asset
        this.trades = new Map(); // assetId → [{ price, side, size, timestamp }]

        // Last trade price per asset
        this.lastPrice = new Map(); // assetId → number

        // Callbacks
        this.onBookUpdate = null;    // (assetId, book) => void
        this.onTradeUpdate = null;   // (assetId, trade) => void
        this.onPriceUpdate = null;   // (assetId, price) => void
    }

    subscribe(conditionId, assetIds) {
        this.conditionId = conditionId;
        this.assetIds = assetIds;

        for (const id of assetIds) {
            this.books.set(id, { bids: [], asks: [] });
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

            // Subscribe to book + trades for all assets
            for (const assetId of this.assetIds) {
                this.ws.send(JSON.stringify({
                    auth: {},
                    type: 'subscribe',
                    markets: [this.conditionId],
                    assets_ids: [assetId],
                    channels: ['book', 'trades'],
                }));
            }

            this.startPing();
        });

        this.ws.on('message', (raw) => {
            this.handleMessage(raw);
        });

        this.ws.on('ping', () => {
            this.ws?.pong();
        });

        this.ws.on('close', () => {
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
            const text = raw.toString().trim();
            if (text === 'ping') this.ws?.send('pong');
            return;
        }

        if (msg.type === 'ping' || msg === 'ping') {
            this.ws?.send('pong');
            return;
        }

        // Handle different event types from the CLOB WS
        const events = Array.isArray(msg) ? msg : [msg];

        for (const evt of events) {
            const assetId = evt.asset_id;
            if (!assetId || !this.assetIds.includes(assetId)) continue;

            switch (evt.event_type) {
                case 'book':
                    this.handleBook(assetId, evt);
                    break;
                case 'last_trade_price':
                    this.handleLastPrice(assetId, evt);
                    break;
                case 'tick_size_change':
                    break; // ignore
                default:
                    // Could be trade data
                    if (evt.price && evt.side) {
                        this.handleTrade(assetId, evt);
                    }
                    break;
            }
        }
    }

    handleBook(assetId, evt) {
        const bids = (evt.bids || []).map((b) => ({
            price: parseFloat(b.price),
            size: parseFloat(b.size),
        })).sort((a, b) => b.price - a.price);

        const asks = (evt.asks || []).map((a) => ({
            price: parseFloat(a.price),
            size: parseFloat(a.size),
        })).sort((a, b) => a.price - b.price);

        this.books.set(assetId, { bids, asks, timestamp: evt.timestamp });

        if (this.onBookUpdate) {
            this.onBookUpdate(assetId, { bids, asks });
        }
    }

    handleLastPrice(assetId, evt) {
        const price = parseFloat(evt.price || '0');
        this.lastPrice.set(assetId, price);

        if (this.onPriceUpdate) {
            this.onPriceUpdate(assetId, price);
        }
    }

    handleTrade(assetId, evt) {
        const trade = {
            price: parseFloat(evt.price || '0'),
            side: evt.side || '',
            size: parseFloat(evt.size || evt.amount || '0'),
            timestamp: evt.timestamp || new Date().toISOString(),
        };

        const trades = this.trades.get(assetId) || [];
        trades.push(trade);
        if (trades.length > 50) trades.splice(0, trades.length - 50);
        this.trades.set(assetId, trades);

        if (this.onTradeUpdate) {
            this.onTradeUpdate(assetId, trade);
        }
    }

    /**
     * Check if a simulated order would fill based on current orderbook.
     * @param {string} assetId - token ID
     * @param {'buy'|'sell'} side - order side
     * @param {number} price - limit price
     * @param {number} size - order size
     * @returns {{ filled: number, avgPrice: number } | null}
     */
    checkSimFill(assetId, side, price, size) {
        const book = this.books.get(assetId);
        if (!book) return null;

        if (side === 'buy') {
            // Buy order fills against asks at or below our price
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
            // Sell order fills against bids at or above our price
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

    getBook(assetId) {
        return this.books.get(assetId) || { bids: [], asks: [] };
    }

    getLastPrice(assetId) {
        return this.lastPrice.get(assetId) || 0;
    }

    getRecentTrades(assetId, limit = 10) {
        const trades = this.trades.get(assetId) || [];
        return trades.slice(-limit);
    }

    startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send('ping');
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
