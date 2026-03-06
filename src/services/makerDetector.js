/**
 * makerDetector.js
 * Detects upcoming markets for the Maker strategy (buy low, sell high).
 * Supports multiple assets AND multiple durations (e.g. 5m,15m).
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { proxyFetch } from '../utils/proxy.js';

const DURATION_SECS = { '5m': 300, '15m': 900 };

let pollTimer = null;
let onMarketCb = null;
const seenKeys = new Set();

function slotSec(duration) {
    return DURATION_SECS[duration] || 300;
}

function currentSlot(duration) {
    const sec = slotSec(duration);
    return Math.floor(Date.now() / 1000 / sec) * sec;
}

function nextSlot(duration) {
    return currentSlot(duration) + slotSec(duration);
}

async function fetchBySlug(asset, duration, slotTimestamp) {
    const slug = `${asset}-updown-${duration}-${slotTimestamp}`;
    try {
        const resp = await proxyFetch(`${config.gammaHost}/markets/slug/${slug}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.conditionId ? data : null;
    } catch {
        return null;
    }
}

function extractMarketData(market, asset, duration) {
    const conditionId = market.conditionId || market.condition_id || '';
    if (!conditionId) return null;

    let tokenIds = market.clobTokenIds ?? market.clob_token_ids;
    if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
    }

    let yesTokenId, noTokenId;
    if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
        [yesTokenId, noTokenId] = tokenIds;
    } else if (Array.isArray(market.tokens) && market.tokens.length >= 2) {
        yesTokenId = market.tokens[0]?.token_id ?? market.tokens[0]?.tokenId;
        noTokenId = market.tokens[1]?.token_id ?? market.tokens[1]?.tokenId;
    }

    if (!yesTokenId || !noTokenId) return null;

    return {
        asset,
        duration,
        conditionId,
        question: market.question || market.title || '',
        endTime: market.endDate || market.end_date_iso || market.endDateIso,
        eventStartTime: market.eventStartTime || market.event_start_time,
        yesTokenId: String(yesTokenId),
        noTokenId: String(noTokenId),
        negRisk: market.negRisk ?? market.neg_risk ?? false,
        tickSize: String(market.orderPriceMinTickSize ?? market.minimum_tick_size ?? market.minimumTickSize ?? '0.01'),
    };
}

async function scheduleAsset(asset, duration, slotTimestamp) {
    const key = `${asset}-${duration}-${slotTimestamp}`;
    if (seenKeys.has(key)) return;

    const market = await fetchBySlug(asset, duration, slotTimestamp);
    if (!market) return;

    const data = extractMarketData(market, asset, duration);
    if (!data) {
        logger.warn(`MAKER: skipping ${asset.toUpperCase()} ${duration} slot ${slotTimestamp} — missing token IDs`);
        seenKeys.add(key);
        return;
    }

    seenKeys.add(key);

    const openAt = data.eventStartTime ? new Date(data.eventStartTime).getTime() : slotTimestamp * 1000;
    const elapsedSec = Math.round((Date.now() - openAt) / 1000);
    if (elapsedSec > 15) {
        logger.info(`MAKER: ${asset.toUpperCase()} ${duration} next slot already ${elapsedSec}s old — skipping`);
        return;
    }

    const secsUntilOpen = Math.round((openAt - Date.now()) / 1000);
    if (secsUntilOpen > 0) {
        logger.success(`MAKER: ${asset.toUpperCase()} ${duration} found "${data.question.slice(0, 40)}" — placing orders (${secsUntilOpen}s before open)`);
    } else {
        logger.success(`MAKER: ${asset.toUpperCase()} ${duration} found "${data.question.slice(0, 40)}" — placing orders now`);
    }

    if (onMarketCb) onMarketCb(data);
}

async function poll() {
    try {
        const tasks = [];
        for (const duration of config.makerDurations) {
            const next = nextSlot(duration);
            for (const asset of config.makerAssets) {
                tasks.push(scheduleAsset(asset, duration, next));
            }
        }
        await Promise.all(tasks);
    } catch (err) {
        logger.error('MAKER detector poll error:', err.message);
    }
}

export function startMakerDetector(onNewMarket) {
    onMarketCb = onNewMarket;
    seenKeys.clear();

    poll();
    pollTimer = setInterval(poll, config.makerPollInterval);

    const durStr = config.makerDurations.join(', ');
    for (const duration of config.makerDurations) {
        const ns = nextSlot(duration);
        const secsUntil = ns - Math.floor(Date.now() / 1000);
        logger.info(`MAKER detector — ${duration}: next slot *-updown-${duration}-${ns} (opens in ${secsUntil}s)`);
    }
    logger.info(`MAKER detector started — assets: ${config.makerAssets.join(', ').toUpperCase()} | durations: ${durStr}`);
    logger.info(`Strategy: BUY @ $${config.makerBuyPrice} → SELL @ $${config.makerSellPrice} | ${config.makerTradeSize} shares/side`);
}

export function stopMakerDetector() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}
