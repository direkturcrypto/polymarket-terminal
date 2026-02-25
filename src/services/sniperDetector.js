/**
 * sniperDetector.js
 * Detects markets for configured assets and dispatches two sniper strategies:
 *
 * 1) Book strategy (existing)
 *    - Places low-price resting orders on 5m markets:
 *      - current slot (if enough time remains)
 *      - next slot
 *
 * 2) Late-close strategy (new)
 *    - Near market close (< configured seconds), scans 5m/15m markets and
 *      lets sniper executor attempt high-probability snipes.
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';

const DURATION_SLOT_SECONDS = {
  '5m': 5 * 60,
  '15m': 15 * 60,
};

let pollTimer = null;
let onMarketCb = null;
const seenKeys = new Set();

function slotSeconds(duration) {
  return DURATION_SLOT_SECONDS[duration] ?? DURATION_SLOT_SECONDS['5m'];
}

function currentSlot(duration) {
  const seconds = slotSeconds(duration);
  return Math.floor(Date.now() / 1000 / seconds) * seconds;
}

function nextSlot(duration) {
  return currentSlot(duration) + slotSeconds(duration);
}

async function fetchBySlug(asset, duration, slotTimestamp) {
  const slug = `${asset}-updown-${duration}-${slotTimestamp}`;
  try {
    const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`);
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
    try {
      tokenIds = JSON.parse(tokenIds);
    } catch {
      tokenIds = null;
    }
  }

  let yesTokenId;
  let noTokenId;
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
    tickSize: String(market.orderPriceMinTickSize ?? market.minimum_tick_size ?? '0.01'),
  };
}

function computeSecondsToClose(data, slotTimestamp, duration) {
  const fallbackEndAt = (slotTimestamp + slotSeconds(duration)) * 1000;
  const endAt = data.endTime ? new Date(data.endTime).getTime() : fallbackEndAt;
  return Math.round((endAt - Date.now()) / 1000);
}

async function scheduleBookAsset(asset, duration, slotTimestamp, isCurrent = false) {
  const key = `book-${asset}-${duration}-${slotTimestamp}`;
  if (seenKeys.has(key)) return;

  const market = await fetchBySlug(asset, duration, slotTimestamp);
  if (!market) return;

  const data = extractMarketData(market, asset, duration);
  if (!data) {
    logger.warn(`SNIPER: skipping ${asset} ${duration} slot ${slotTimestamp} — missing token IDs`);
    seenKeys.add(key);
    return;
  }

  seenKeys.add(key);

  if (isCurrent) {
    const secsLeft = computeSecondsToClose(data, slotTimestamp, duration);

    if (secsLeft < config.sniperLateCloseWindow) {
      if (config.sniperLateEnabled) {
        logger.info(
          `SNIPER: ${asset.toUpperCase()} ${duration} current market closing soon (${secsLeft}s) — late-close strategy will handle`,
        );
      } else {
        logger.info(
          `SNIPER: ${asset.toUpperCase()} ${duration} current market closing soon (${secsLeft}s) — skipping`,
        );
      }
      return;
    }

    logger.success(
      `SNIPER: ${asset.toUpperCase()} ${duration} current market active (${secsLeft}s left) — placing orders now`,
    );
    if (onMarketCb) onMarketCb({ ...data, strategy: 'book', secondsToClose: secsLeft });
    return;
  }

  const openAt = data.eventStartTime
    ? new Date(data.eventStartTime).getTime()
    : slotTimestamp * 1000;
  const secsUntilOpen = Math.round((openAt - Date.now()) / 1000);
  logger.success(
    `SNIPER: ${asset.toUpperCase()} found "${data.question.slice(0, 40)}"${secsUntilOpen > 0 ? ` — ${secsUntilOpen}s before open` : ''} (${duration})`,
  );

  if (onMarketCb) onMarketCb({ ...data, strategy: 'book' });
}

async function scheduleLateCloseAsset(asset, duration) {
  if (!config.sniperLateEnabled) {
    return;
  }

  const slotTimestamp = currentSlot(duration);
  const key = `late-${asset}-${duration}-${slotTimestamp}`;
  if (seenKeys.has(key)) return;

  const market = await fetchBySlug(asset, duration, slotTimestamp);
  if (!market) return;

  const data = extractMarketData(market, asset, duration);
  if (!data) {
    seenKeys.add(key);
    return;
  }

  const secsLeft = computeSecondsToClose(data, slotTimestamp, duration);
  if (secsLeft <= 0) {
    seenKeys.add(key);
    return;
  }

  if (secsLeft > config.sniperLateCloseWindow) {
    return;
  }

  seenKeys.add(key);
  logger.success(
    `SNIPER: ${asset.toUpperCase()} ${duration} late window active (${secsLeft}s to close) — scanning ${Math.round(config.sniperLateMinPrice * 100)}-${Math.round(config.sniperLateMaxPrice * 100)}c opportunities`,
  );

  if (onMarketCb) onMarketCb({ ...data, strategy: 'late', secondsToClose: secsLeft });
}

async function poll() {
  try {
    const curr5m = currentSlot('5m');
    const next5m = nextSlot('5m');

    const tasks = config.sniperAssets.flatMap((asset) => {
      const assetTasks = [
        scheduleBookAsset(asset, '5m', curr5m, true),
        scheduleBookAsset(asset, '5m', next5m, false),
      ];

      if (config.sniperLateEnabled) {
        for (const duration of config.sniperLateDurations) {
          assetTasks.push(scheduleLateCloseAsset(asset, duration));
        }
      }

      return assetTasks;
    });

    await Promise.all(tasks);
  } catch (err) {
    logger.error('SNIPER detector poll error:', err.message);
  }
}

export function startSniperDetector(onNewMarket) {
  onMarketCb = onNewMarket;
  seenKeys.clear();

  poll();
  pollTimer = setInterval(poll, config.mmPollInterval);

  const next5m = nextSlot('5m');
  const secsUntilNext5m = next5m - Math.floor(Date.now() / 1000);
  logger.info(`SNIPER detector started — assets: ${config.sniperAssets.join(', ').toUpperCase()}`);
  logger.info(`Next slot: *-updown-5m-${next5m} (opens in ${secsUntilNext5m}s)`);
  logger.info(`Order: $${config.sniperPrice} × ${config.sniperShares} shares per side`);

  if (config.sniperLateEnabled) {
    logger.info(
      `Late-close snatch enabled — durations: ${config.sniperLateDurations.join(', ')} | close < ${config.sniperLateCloseWindow}s | price ${config.sniperLateMinPrice.toFixed(2)}-${config.sniperLateMaxPrice.toFixed(2)}`,
    );
  }
}

export function stopSniperDetector() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
