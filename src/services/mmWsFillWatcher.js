/**
 * mmWsFillWatcher.js
 * Real-time order fill detection for the Market Maker via Polymarket RTDS WebSocket.
 *
 * Subscribes to the `activity` topic and filters events by the bot's own proxy wallet.
 * When a SELL trade is detected on a token we're watching, emits a 'fill' event
 * so mmExecutor can react instantly instead of polling every 10s.
 *
 * Usage:
 *   import { mmFillWatcher } from './mmWsFillWatcher.js';
 *   mmFillWatcher.watch(tokenId);          // start watching a token
 *   mmFillWatcher.unwatch(tokenId);        // stop watching
 *   mmFillWatcher.on('fill', ({ tokenId, size, price }) => { ... });
 *   mmFillWatcher.start();
 *   mmFillWatcher.stop();
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';
const PING_INTERVAL_MS = 5000;
const INITIAL_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;

class MMFillWatcher extends EventEmitter {
    constructor() {
        super();
        this._ws = null;
        this._pingTimer = null;
        this._reconnectTimer = null;
        this._reconnectDelay = INITIAL_RECONNECT_DELAY;
        this._shuttingDown = false;
        this._watchedTokens = new Set(); // token IDs we care about
        this._connected = false;
    }

    /** Register a token ID to watch for fills */
    watch(tokenId) {
        if (tokenId) this._watchedTokens.add(tokenId);
    }

    /** Stop watching a token ID */
    unwatch(tokenId) {
        this._watchedTokens.delete(tokenId);
    }

    /** Check if currently connected */
    get connected() {
        return this._connected;
    }

    /** Start the WebSocket connection */
    start() {
        this._shuttingDown = false;
        this._reconnectDelay = INITIAL_RECONNECT_DELAY;
        this._connect();
    }

    /** Gracefully stop */
    stop() {
        this._shuttingDown = true;
        this._cleanup(false);
        this._watchedTokens.clear();
        logger.info('MM fill watcher stopped');
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _connect() {
        if (this._shuttingDown) return;

        logger.info('MM fill watcher: connecting to RTDS WebSocket...');
        this._ws = new WebSocket(RTDS_WS_URL);

        this._ws.on('open', () => {
            this._connected = true;
            this._reconnectDelay = INITIAL_RECONNECT_DELAY;
            logger.success('MM fill watcher: WebSocket connected');

            this._ws.send(JSON.stringify({
                action: 'subscribe',
                subscriptions: [{
                    topic: 'activity',
                    type: 'trades',
                }],
            }));

            this._startPing();
        });

        this._ws.on('message', (data) => this._handleMessage(data));

        this._ws.on('ping', () => {
            this._ws?.pong();
        });

        this._ws.on('close', (code, reason) => {
            this._connected = false;
            const reasonStr = reason ? reason.toString() : 'no reason';
            logger.warn(`MM fill watcher: WS closed (${code}): ${reasonStr}`);
            this._cleanup(true);
        });

        this._ws.on('error', (err) => {
            this._connected = false;
            logger.error(`MM fill watcher: WS error: ${err.message}`);
            this._cleanup(true);
        });
    }

    _handleMessage(rawData) {
        let msg;
        try {
            msg = JSON.parse(rawData.toString());
        } catch {
            const text = rawData.toString().trim();
            if (text === 'ping') this._ws?.send('pong');
            return;
        }

        if (msg.type === 'ping' || msg === 'ping') {
            this._ws?.send('pong');
            return;
        }

        if (msg.topic !== 'activity') return;

        const payload = msg.payload;
        if (!payload) return;

        // Filter: only our own proxy wallet
        const ourWallet = config.proxyWallet?.toLowerCase();
        if (!ourWallet) return;

        const proxyWallet = (payload.proxyWallet || payload.proxy_wallet || '').toLowerCase();
        if (proxyWallet !== ourWallet) return;

        // Filter: only tokens we're watching
        const tokenId = payload.asset || '';
        if (!tokenId || !this._watchedTokens.has(tokenId)) return;

        const side = (payload.side || '').toUpperCase();
        const size = parseFloat(payload.size || '0');
        const price = parseFloat(payload.price || '0');

        if (size <= 0) return;

        logger.info(`MM fill watcher: detected ${side} on token ${tokenId.slice(-8)} — ${size} shares @ $${price.toFixed(3)}`);

        this.emit('fill', {
            tokenId,
            side,
            size,
            price,
            conditionId: payload.conditionId || payload.condition_id || '',
            timestamp: payload.timestamp || new Date().toISOString(),
        });
    }

    _startPing() {
        this._stopPing();
        this._pingTimer = setInterval(() => {
            if (this._ws?.readyState === WebSocket.OPEN) {
                this._ws.send('ping');
            }
        }, PING_INTERVAL_MS);
    }

    _stopPing() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }

    _cleanup(reconnect = true) {
        this._stopPing();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            this._ws.removeAllListeners();
            if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
                this._ws.terminate();
            }
            this._ws = null;
        }
        this._connected = false;
        if (reconnect && !this._shuttingDown) {
            this._scheduleReconnect();
        }
    }

    _scheduleReconnect() {
        logger.info(`MM fill watcher: reconnecting in ${this._reconnectDelay / 1000}s...`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectDelay = Math.min(this._reconnectDelay * 2, MAX_RECONNECT_DELAY);
            this._connect();
        }, this._reconnectDelay);
    }
}

// Singleton instance
export const mmFillWatcher = new MMFillWatcher();
