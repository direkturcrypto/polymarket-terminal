/**
 * makerDetector.js
 * Detects upcoming markets for the Maker strategy (buy low, sell high).
 * Same slug-based detection as mmDetector but reads from MAKER_* config.
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { proxyFetch } from '../utils/proxy.js';

const SLOT_SEC = config.makerDuration === '15m' ? 900 : 300;

let pollTimer = null;
let onMarketCb = null;
const seenKeys = new Set();

function currentSlot() {
    return Math.floor(Date.now() / 1000 / SLOT_SEC) * SLOT_SEC;
}

function nextSlot() {
    return currentSlot() + SLOT_SEC;
}

async function fetchBySlug(asset, slotTimestamp) {
    const slug = `${asset}-updown-${config.makerDuration}-${slotTimestamp}`;
    try {
        const resp = await proxyFetch(`${config.gammaHost}/markets/slug/${slug}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.conditionId ? data : null;
    } catch {
        return null;
    }
}

function extractMarketData(market, asset) {
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

async function scheduleAsset(asset, slotTimestamp) {
    const key = `${asset}-${slotTimestamp}`;
    if (seenKeys.has(key)) return;

    const market = await fetchBySlug(asset, slotTimestamp);
    if (!market) return;

    const data = extractMarketData(market, asset);
    if (!data) {
        logger.warn(`MAKER: skipping ${asset.toUpperCase()} slot ${slotTimestamp} — missing token IDs`);
        seenKeys.add(key);
        return;
    }

    seenKeys.add(key);

    const openAt = data.eventStartTime ? new Date(data.eventStartTime).getTime() : slotTimestamp * 1000;
    const elapsedSec = Math.round((Date.now() - openAt) / 1000);
    if (elapsedSec > 15) {
        logger.info(`MAKER: ${asset.toUpperCase()} next slot already ${elapsedSec}s old — skipping`);
        return;
    }

    const secsUntilOpen = Math.round((openAt - Date.now()) / 1000);
    if (secsUntilOpen > 0) {
        logger.success(`MAKER: ${asset.toUpperCase()} found "${data.question.slice(0, 40)}" — placing orders (${secsUntilOpen}s before open)`);
    } else {
        logger.success(`MAKER: ${asset.toUpperCase()} found "${data.question.slice(0, 40)}" — placing orders now`);
    }

    if (onMarketCb) onMarketCb(data);
}

async function poll() {
    try {
        const next = nextSlot();
        await Promise.all(config.makerAssets.map((asset) => scheduleAsset(asset, next)));
    } catch (err) {
        logger.error('MAKER detector poll error:', err.message);
    }
}

export function startMakerDetector(onNewMarket) {
    onMarketCb = onNewMarket;
    seenKeys.clear();

    poll();
    pollTimer = setInterval(poll, config.makerPollInterval);

    const ns = nextSlot();
    const secsUntil = ns - Math.floor(Date.now() / 1000);
    logger.info(`MAKER detector started — assets: ${config.makerAssets.join(', ').toUpperCase()} | duration: ${config.makerDuration}`);
    logger.info(`Next slot: *-updown-${config.makerDuration}-${ns} (opens in ${secsUntil}s)`);
    logger.info(`Strategy: BUY @ $${config.makerBuyPrice} → SELL @ $${config.makerSellPrice} | ${config.makerTradeSize} shares/side`);
}

export function stopMakerDetector() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}
