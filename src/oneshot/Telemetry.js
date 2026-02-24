/**
 * Telemetry.js
 * Structured JSONL logger for the OneShot engine.
 *
 * Every decision tick, order lifecycle event, position exit, and state
 * transition is recorded to data/oneshot_telemetry.jsonl — one JSON object
 * per line — for offline analysis and strategy tuning.
 */

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const DATA_DIR  = path.resolve('data');
const LOG_FILE  = path.join(DATA_DIR, 'oneshot_telemetry.jsonl');

export class Telemetry {
    constructor() {
        // Ensure data/ directory exists
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    }

    // ── Public log methods ───────────────────────────────────────────────────

    /**
     * Log a per-decision-tick evaluation record.
     * Called for every signal evaluation, whether entry is taken or not.
     *
     * @param {Object} d
     * @param {string}  d.marketSlug
     * @param {number}  d.ts
     * @param {number}  d.tteSec
     * @param {number}  d.spread
     * @param {number}  d.imbalance
     * @param {number}  d.slope
     * @param {number}  d.retrace
     * @param {number}  d.depth
     * @param {boolean} d.gatePass
     * @param {string}  d.reasonCode
     * @param {number}  d.score
     * @param {string}  d.action
     */
    logDecision(d) {
        this._write({ type: 'decision', ...d });
    }

    /**
     * Log an order lifecycle event (submit → ack → fill / cancel).
     *
     * @param {Object} d
     * @param {string}  d.clientOrderId
     * @param {string}  d.side
     * @param {string}  d.marketSlug
     * @param {number}  d.px
     * @param {number}  d.qty
     * @param {number}  d.ackMs
     * @param {number}  d.fillMs
     * @param {string}  d.status
     */
    logOrder(d) {
        this._write({ type: 'order', ...d });
    }

    /**
     * Log a position exit event.
     *
     * @param {Object} d
     * @param {string}  d.marketSlug
     * @param {string}  d.exitReason
     * @param {number}  d.entryPx
     * @param {number}  d.exitPx
     * @param {number}  d.pnl
     * @param {number}  d.shares
     */
    logExit(d) {
        this._write({ type: 'exit', ...d });

        const pnlStr = d.pnl == null
            ? 'pending(on-chain)'
            : d.pnl >= 0
                ? `+$${d.pnl.toFixed(4)}`
                : `-$${Math.abs(d.pnl).toFixed(4)}`;

        logger.money(`[Telemetry] exit ${d.marketSlug} | ${d.exitReason} | pnl=${pnlStr}`);
    }

    /**
     * Log a state machine transition.
     *
     * @param {Object} d
     * @param {string}  d.marketSlug
     * @param {string}  d.from
     * @param {string}  d.to
     * @param {string}  d.reason
     * @param {number}  d.ts
     */
    logTransition(d) {
        this._write({ type: 'transition', ...d });
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    _write(record) {
        const line = JSON.stringify({ ...record, ts: record.ts ?? Date.now() }) + '\n';
        fs.appendFile(LOG_FILE, line, (err) => {
            if (err) logger.warn(`[Telemetry] write error: ${err.message}`);
        });
    }
}
