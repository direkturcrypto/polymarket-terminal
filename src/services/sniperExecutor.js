/**
 * sniperExecutor.js
 * Places GTC limit BUY orders at a very low price on both sides of a market.
 *
 * Strategy:
 *   - For each market detected by sniperDetector, place two GTC BUY orders:
 *       UP   token at $SNIPER_PRICE × SNIPER_SHARES shares
 *       DOWN token at $SNIPER_PRICE × SNIPER_SHARES shares
 *   - Orders sit in the orderbook. If someone panic-dumps below the price,
 *     the order fills and becomes redeemable if that side wins.
 *   - GTC orders expire automatically when the market closes — no cleanup needed.
 *
 * Cost per market: SNIPER_PRICE × SNIPER_SHARES × 2 sides
 * e.g. $0.01 × 5 × 2 = $0.10 per market, $0.30 for 3 assets per 5-min slot
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, getCollateralStatus, getTradingContext } from './client.js';
import logger from '../utils/logger.js';

// In-memory tracking of placed snipe orders (for TUI status panel)
const activeSnipes = []; // { asset, side, question, orderId, price, shares, cost, potentialPayout }
const BALANCE_COOLDOWN_MS = 60_000;
let insufficientFundsCooldownUntil = 0;
let lastInsufficientFundsLogAt = 0;

function extractOrderFailureReason(value) {
  if (!value) return 'unknown';

  if (typeof value.errorMsg === 'string' && value.errorMsg.trim()) {
    return value.errorMsg.trim();
  }

  if (typeof value.error === 'string' && value.error.trim()) {
    return value.error.trim();
  }

  if (typeof value.message === 'string' && value.message.trim()) {
    return value.message.trim();
  }

  const responseData = value.response?.data;
  if (typeof responseData?.error === 'string' && responseData.error.trim()) {
    return responseData.error.trim();
  }

  if (typeof responseData?.message === 'string' && responseData.message.trim()) {
    return responseData.message.trim();
  }

  return 'unknown';
}

function isBalanceOrAllowanceFailure(reason) {
  return /not enough balance|allowance|insufficient balance|insufficient allowance/i.test(reason);
}

async function logInsufficientBalanceContext() {
  const now = Date.now();
  if (now - lastInsufficientFundsLogAt < BALANCE_COOLDOWN_MS) {
    return;
  }
  lastInsufficientFundsLogAt = now;

  const context = getTradingContext();
  logger.warn(
    `SNIPER: order wallet=${context.orderMakerAddress ?? 'unknown'} | signer=${context.signerAddress ?? 'unknown'} | proxy=${context.proxyWallet ?? 'none'} | signatureType=${context.signatureType}`,
  );

  try {
    const collateral = await getCollateralStatus();
    if (collateral) {
      logger.warn(
        `SNIPER: collateral balance=${collateral.balanceFormatted} USDC, allowance=${collateral.allowanceFormatted} USDC`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`SNIPER: unable to read collateral status — ${message}`);
  }
}

export function getActiveSnipes() {
  return [...activeSnipes];
}

export async function executeSnipe(market) {
  const { asset, conditionId, question, yesTokenId, noTokenId, tickSize, negRisk } = market;
  const label = question.slice(0, 40);
  const sim = config.dryRun ? '[SIM] ' : '';

  if (!config.dryRun && Date.now() < insufficientFundsCooldownUntil) {
    const waitSeconds = Math.max(
      1,
      Math.ceil((insufficientFundsCooldownUntil - Date.now()) / 1000),
    );
    logger.warn(
      `SNIPER: skipping ${asset.toUpperCase()} order attempts for ${waitSeconds}s (balance/allowance cooldown)`,
    );
    return;
  }

  const sides = [
    { name: 'UP', tokenId: yesTokenId },
    { name: 'DOWN', tokenId: noTokenId },
  ];

  logger.info(
    `SNIPER: ${sim}${asset.toUpperCase()} — "${label}" | $${config.sniperPrice} × ${config.sniperShares}sh each side`,
  );

  for (const { name, tokenId } of sides) {
    if (config.dryRun) {
      const cost = config.sniperPrice * config.sniperShares;
      logger.trade(
        `SNIPER[SIM]: ${asset.toUpperCase()} ${name} @ $${config.sniperPrice} × ${config.sniperShares}sh | cost $${cost.toFixed(3)} | payout $${config.sniperShares} if wins`,
      );
      activeSnipes.push({
        asset: asset.toUpperCase(),
        side: name,
        question: label,
        orderId: `sim-${Date.now()}-${tokenId.slice(-6)}`,
        price: config.sniperPrice,
        shares: config.sniperShares,
        cost,
        potentialPayout: config.sniperShares,
      });
      continue;
    }

    const client = getClient();
    try {
      const res = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          side: Side.BUY,
          price: config.sniperPrice,
          size: config.sniperShares,
        },
        { tickSize, negRisk },
        OrderType.GTC,
      );

      if (res?.success) {
        const cost = config.sniperPrice * config.sniperShares;
        logger.trade(
          `SNIPER: ${asset.toUpperCase()} ${name} @ $${config.sniperPrice} × ${config.sniperShares}sh | cost $${cost.toFixed(3)} | order ${res.orderID}`,
        );
        activeSnipes.push({
          asset: asset.toUpperCase(),
          side: name,
          question: label,
          orderId: res.orderID,
          price: config.sniperPrice,
          shares: config.sniperShares,
          cost,
          potentialPayout: config.sniperShares,
        });
      } else {
        const reason = extractOrderFailureReason(res);
        logger.warn(`SNIPER: ${asset.toUpperCase()} ${name} order failed — ${reason}`);

        if (isBalanceOrAllowanceFailure(reason)) {
          insufficientFundsCooldownUntil = Date.now() + BALANCE_COOLDOWN_MS;
          await logInsufficientBalanceContext();
          logger.warn(
            `SNIPER: pausing new order attempts for ${Math.round(BALANCE_COOLDOWN_MS / 1000)}s due to insufficient balance/allowance`,
          );
          break;
        }
      }
    } catch (err) {
      const reason = extractOrderFailureReason(err);
      logger.error(`SNIPER: ${asset.toUpperCase()} ${name} error — ${reason}`);

      if (isBalanceOrAllowanceFailure(reason)) {
        insufficientFundsCooldownUntil = Date.now() + BALANCE_COOLDOWN_MS;
        await logInsufficientBalanceContext();
        logger.warn(
          `SNIPER: pausing new order attempts for ${Math.round(BALANCE_COOLDOWN_MS / 1000)}s due to insufficient balance/allowance`,
        );
        break;
      }
    }
  }
}
