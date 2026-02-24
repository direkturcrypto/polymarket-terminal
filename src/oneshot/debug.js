/**
 * debug.js
 * Lightweight debug helper for the OneShot engine.
 *
 * Enable by setting ONESHOT_DEBUG=true in your .env or environment,
 * or by passing --debug on the command line:
 *
 *   ONESHOT_DEBUG=true npm run oneshot
 *   npm run oneshot -- --debug
 *   npm run oneshot-debug            (shorthand script)
 */

import logger from '../utils/logger.js';

export const DEBUG = process.env.ONESHOT_DEBUG === 'true'
    || process.argv.includes('--debug');

/**
 * Log a debug message — no-op when DEBUG is false.
 * Prefixes every line with a [DBG <tag>] marker so you can grep by component.
 *
 * @param {string} tag   - Component name, e.g. 'FEED', 'GATE', 'SCORE'
 * @param {string} msg   - Message string
 */
export function dbg(tag, msg) {
    if (!DEBUG) return;
    logger.info(`[DBG:${tag}] ${msg}`);
}
