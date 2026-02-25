/**
 * mmExecutor.js
 * Executes the market-maker strategy for a single Bitcoin 5-minute market:
 *   1. Call CTF splitPosition — deposit USDC, receive equal YES+NO tokens at $0.50 flat
 *   2. Place GTC limit sells at mmSellPrice for both YES and NO
 *   3. Monitor until both fills or cut-loss time triggers
 *   4. On cut-loss:
 *        - If NEITHER side filled  → mergePositions (burn YES+NO, recover USDC, zero loss)
 *        - If ONE side already sold → cancel the other, market-sell remaining tokens
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getClient, getUsdcBalance, getPolygonProvider } from './client.js';
import { splitPosition, mergePositions } from './ctf.js';
import logger from '../utils/logger.js';

// CTF contract for on-chain balance queries
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_BALANCE_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)'];

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

function normalizePrice(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  if (parsed >= 1) {
    const microScaled = parsed / 1_000_000;
    if (microScaled > 0 && microScaled < 1) {
      return microScaled;
    }
  }

  return parsed;
}

function normalizeShares(value) {
  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  if (parsed > 1_000_000) {
    return parsed / 1_000_000;
  }

  return parsed;
}

/**
 * Get actual on-chain ERC1155 token balance for the proxy wallet.
 * Used before market-sell to avoid 'not enough balance' errors from partial fills.
 */
async function getTokenBalance(tokenId) {
  try {
    const provider = await getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_BALANCE_ABI, provider);
    const raw = await ctf.balanceOf(config.proxyWallet, tokenId);
    return parseFloat(ethers.utils.formatUnits(raw, 6));
  } catch {
    return null; // fallback: caller will use pos.shares
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-memory store of all active MM positions (conditionId → position)
const activePositions = new Map();

export function getActiveMMPositions() {
  return Array.from(activePositions.values());
}

// ── Order helpers ─────────────────────────────────────────────────────────────

async function placeLimitSell(tokenId, shares, price, tickSize, negRisk) {
  if (config.dryRun) {
    return { success: true, orderId: `sim-${Date.now()}-${tokenId.slice(-6)}` };
  }

  const client = getClient();
  try {
    const res = await client.createAndPostOrder(
      { tokenID: tokenId, side: Side.SELL, price, size: shares },
      { tickSize, negRisk },
      OrderType.GTC,
    );
    if (!res?.success) return { success: false, reason: extractOrderFailureReason(res) };
    return { success: true, orderId: res.orderID };
  } catch (err) {
    const reason = extractOrderFailureReason(err);
    logger.error('MM limit sell error:', reason);
    return { success: false, reason };
  }
}

async function placeMarketBuy(tokenId, amountUsd, tickSize, negRisk) {
  if (config.dryRun) {
    const simPrice = 0.5;
    return {
      success: true,
      fillPrice: simPrice,
      shares: amountUsd / simPrice,
    };
  }

  const client = getClient();
  try {
    const res = await client.createAndPostMarketOrder(
      { tokenID: tokenId, side: Side.BUY, amount: amountUsd, price: 0.99 },
      { tickSize, negRisk },
      OrderType.FOK,
    );

    if (!res?.success) {
      return { success: false, reason: extractOrderFailureReason(res) };
    }

    const fillPrice = normalizePrice(res.price, 0);
    const sharesFromResponse = normalizeShares(res.takingAmount);
    const shares =
      sharesFromResponse && sharesFromResponse > 0
        ? sharesFromResponse
        : fillPrice > 0
          ? amountUsd / fillPrice
          : null;

    if (!shares || shares <= 0) {
      return {
        success: false,
        reason: 'unable to infer filled share size from market buy response',
      };
    }

    return {
      success: true,
      fillPrice: fillPrice > 0 ? fillPrice : amountUsd / shares,
      shares,
    };
  } catch (err) {
    const reason = extractOrderFailureReason(err);
    return { success: false, reason };
  }
}

async function cancelOrder(orderId) {
  if (config.dryRun || !orderId || orderId.startsWith('sim-')) return true;
  try {
    const client = getClient();
    await client.cancelOrder({ orderID: orderId }); // SDK expects { orderID } object
    return true;
  } catch (err) {
    logger.warn('MM cancel order error:', err.message);
    return false;
  }
}

async function marketSell(tokenId, shares, tickSize, negRisk) {
  if (config.dryRun) {
    try {
      const client = getClient();
      const mp = await client.getMidpoint(tokenId);
      const price = parseFloat(mp?.mid ?? mp ?? '0') || 0;
      return { success: true, fillPrice: price };
    } catch {
      return { success: true, fillPrice: 0 };
    }
  }

  const client = getClient();
  try {
    const res = await client.createAndPostMarketOrder(
      { tokenID: tokenId, side: Side.SELL, amount: shares, price: 0.01 },
      { tickSize, negRisk },
      OrderType.FOK,
    );
    if (!res?.success) {
      return { success: false, fillPrice: 0, reason: extractOrderFailureReason(res) };
    }
    return { success: true, fillPrice: parseFloat(res.price || '0') };
  } catch (err) {
    const reason = extractOrderFailureReason(err);
    logger.error('MM market sell error:', reason);
    return { success: false, fillPrice: 0, reason };
  }
}

// ── Order status check ────────────────────────────────────────────────────────

async function isOrderFilled(orderId, shares) {
  if (!orderId || orderId.startsWith('sim-')) return false;
  try {
    const client = getClient();
    const order = await client.getOrder(orderId);
    if (!order) return false;
    if (order.status === 'MATCHED') return true;
    const matched = parseFloat(order.size_matched || '0');
    return matched >= shares * 0.99;
  } catch {
    return false;
  }
}

// For simulation: check if market price has reached the sell target
async function simPriceHitTarget(tokenId) {
  try {
    const client = getClient();
    const mp = await client.getMidpoint(tokenId);
    const price = parseFloat(mp?.mid ?? mp ?? '0');
    return price >= config.mmSellPrice ? price : null;
  } catch {
    return null;
  }
}

// ── Core monitoring loop ──────────────────────────────────────────────────────

async function monitorAndManage(pos) {
  const label = pos.question.substring(0, 40);

  while (true) {
    const msRemaining = new Date(pos.endTime).getTime() - Date.now();

    if (msRemaining <= 0) {
      logger.warn(`MM: market expired — ${label}`);
      pos.status = 'expired';
      break;
    }

    // ── Check YES side ──────────────────────────────────────
    if (!pos.yes.filled) {
      let filled = false;
      if (config.dryRun) {
        const hitPrice = await simPriceHitTarget(pos.yes.tokenId);
        if (hitPrice) {
          filled = true;
          pos.yes.fillPrice = hitPrice;
        }
      } else {
        filled = await isOrderFilled(pos.yes.orderId, pos.yes.shares);
        if (filled) pos.yes.fillPrice = config.mmSellPrice;
      }
      if (filled) {
        pos.yes.filled = true;
        const pnl = (pos.yes.fillPrice - pos.yes.entryPrice) * pos.yes.shares;
        logger.money(
          `MM${config.dryRun ? '[SIM]' : ''}: YES filled @ $${pos.yes.fillPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`,
        );
      }
    }

    // ── Check NO side ───────────────────────────────────────
    if (!pos.no.filled) {
      let filled = false;
      if (config.dryRun) {
        const hitPrice = await simPriceHitTarget(pos.no.tokenId);
        if (hitPrice) {
          filled = true;
          pos.no.fillPrice = hitPrice;
        }
      } else {
        filled = await isOrderFilled(pos.no.orderId, pos.no.shares);
        if (filled) pos.no.fillPrice = config.mmSellPrice;
      }
      if (filled) {
        pos.no.filled = true;
        const pnl = (pos.no.fillPrice - pos.no.entryPrice) * pos.no.shares;
        logger.money(
          `MM${config.dryRun ? '[SIM]' : ''}: NO  filled @ $${pos.no.fillPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`,
        );
      }
    }

    // ── Both filled → done ──────────────────────────────────
    if (pos.yes.filled && pos.no.filled) {
      pos.status = 'done';
      const totalPnl = calcPnl(pos);
      logger.money(`MM: BOTH sides filled! Total P&L: $${totalPnl.toFixed(2)} | ${label}`);
      break;
    }

    // ── Cut-loss time ───────────────────────────────────────
    if (msRemaining <= config.mmCutLossTime * 1000) {
      logger.warn(`MM: cut-loss triggered (${Math.round(msRemaining / 1000)}s left) — ${label}`);
      pos.status = 'cutting';
      await cutLoss(pos);
      break;
    }

    await sleep(10_000);
  }

  // Final P&L log
  const totalPnl = calcPnl(pos);
  const sign = totalPnl >= 0 ? '+' : '';
  if (pos.status !== 'done') {
    logger.info(
      `MM: strategy ended (${pos.status}) | P&L: ${sign}$${totalPnl.toFixed(2)} | ${label}`,
    );
  }
}

async function cutLoss(pos) {
  const { conditionId, tickSize, negRisk } = pos;
  const neitherFilled = !pos.yes.filled && !pos.no.filled;
  const canMergeBackToUsdc = pos.entryMethod !== 'clob';

  if (neitherFilled && canMergeBackToUsdc) {
    // ── Best case: neither side sold → cancel both, merge back to USDC ──
    logger.warn('MM: neither side filled — cancelling orders and merging back to USDC...');
    await cancelOrder(pos.yes.orderId);
    await cancelOrder(pos.no.orderId);

    // Read actual on-chain balances (may differ from original if partially consumed)
    const [yesActual, noActual] = await Promise.all([
      getTokenBalance(pos.yes.tokenId),
      getTokenBalance(pos.no.tokenId),
    ]);

    // mergePositions needs equal amounts — use the minimum actual balance
    const yesShares = yesActual ?? pos.yes.shares;
    const noShares = noActual ?? pos.no.shares;
    const mergeAmt = Math.min(yesShares, noShares);

    if (mergeAmt < 0.001) {
      logger.warn('MM: balances too low to merge — nothing to recover');
    } else {
      const recovered = await mergePositions(conditionId, mergeAmt);
      logger.money(
        `MM: merge complete — recovered ~$${recovered.toFixed ? recovered.toFixed(2) : recovered} USDC (P&L ≈ $0)`,
      );
    }

    // Mark both sides closed at entry price
    pos.yes.fillPrice = pos.yes.entryPrice;
    pos.yes.filled = true;
    pos.no.fillPrice = pos.no.entryPrice;
    pos.no.filled = true;
  } else {
    if (neitherFilled && !canMergeBackToUsdc) {
      logger.warn(
        'MM: neither side filled — cancelling orders and market-selling both sides (merge unavailable in fallback mode)...',
      );
      await cancelOrder(pos.yes.orderId);
      await cancelOrder(pos.no.orderId);
    }

    // ── One side already (partly) sold OR merge unavailable → market-sell unfilled side(s) ──
    for (const side of ['yes', 'no']) {
      const s = pos[side];
      if (s.filled) continue;

      logger.warn(`MM: cancelling ${side.toUpperCase()} limit order and market-selling...`);
      await cancelOrder(s.orderId);

      // Fetch actual on-chain balance — partial fills reduce this below s.shares
      const actualShares = await getTokenBalance(s.tokenId);
      const sellShares = actualShares !== null ? actualShares : s.shares;

      if (sellShares < 0.001) {
        logger.warn(
          `MM: ${side.toUpperCase()} balance is 0 — already fully sold via partial fills`,
        );
        s.fillPrice = config.mmSellPrice; // assume sold at target
        s.filled = true;
        continue;
      }

      logger.warn(
        `MM: ${side.toUpperCase()} actual balance: ${sellShares.toFixed(3)} shares (original: ${s.shares})`,
      );

      const result = await marketSell(s.tokenId, sellShares, tickSize, negRisk);
      s.fillPrice = result.fillPrice;
      s.filled = true;
      // PnL uses actual sold amount (not original pos.shares)
      const pnl = (s.fillPrice - s.entryPrice) * sellShares;
      logger.warn(
        `MM: ${side.toUpperCase()} cut @ $${s.fillPrice.toFixed(3)} | sold ${sellShares.toFixed(3)} sh | P&L $${pnl.toFixed(2)}`,
      );

      if (!result.success) {
        logger.warn(
          `MM: ${side.toUpperCase()} market-sell did not fill — ${result.reason || 'unknown'}`,
        );
      }
    }
  }

  pos.status = 'done';

  // Optional recovery buy (enabled via MM_RECOVERY_BUY=true)
  await attemptRecoveryBuy(pos);
}

// ── Recovery buy ──────────────────────────────────────────────────────────────

/**
 * After a cut-loss, optionally take a directional bet on the dominant side.
 *
 * Criteria (all must pass):
 *   1. MM_RECOVERY_BUY=true in .env
 *   2. One side's price is above MM_RECOVERY_THRESHOLD (default 70%)
 *   3. That price is stable or rising over a 10-second sample (1 fetch/second)
 *   4. Wallet balance is sufficient for the recovery size
 */
async function attemptRecoveryBuy(pos) {
  if (!config.mmRecoveryBuy) return;

  const { tickSize, negRisk } = pos;
  const label = pos.question.substring(0, 40);
  const recoverySize = config.mmRecoverySize > 0 ? config.mmRecoverySize : config.mmTradeSize;
  const client = getClient();

  logger.info(`MM recovery: monitoring prices for 10s | ${label}`);

  // ── Sample both sides once per second for 10 seconds ─────────
  const samples = { yes: [], no: [] };

  for (let i = 0; i < 10; i++) {
    for (const [key, tokenId] of [
      ['yes', pos.yes.tokenId],
      ['no', pos.no.tokenId],
    ]) {
      try {
        const mp = await client.getMidpoint(tokenId);
        const price = parseFloat(mp?.mid ?? mp ?? '0') || 0;
        samples[key].push(price);
      } catch {
        /* skip */
      }
    }
    if (i < 9) await sleep(1000);
  }

  // ── Determine eligible side ───────────────────────────────────
  // Need: last price ≥ threshold AND last price ≥ first price (not declining)
  let candidate = null;
  for (const [key, tokenId] of [
    ['yes', pos.yes.tokenId],
    ['no', pos.no.tokenId],
  ]) {
    const arr = samples[key];
    if (arr.length < 2) continue;

    const firstPrice = arr[0];
    const lastPrice = arr[arr.length - 1];

    if (lastPrice >= config.mmRecoveryThreshold && lastPrice >= firstPrice) {
      candidate = { side: key.toUpperCase(), tokenId, price: lastPrice };
      break;
    }
  }

  if (!candidate) {
    logger.info(
      `MM recovery: no eligible side — need price ≥ ${config.mmRecoveryThreshold} and rising/stable`,
    );
    return;
  }

  // ── Balance check ─────────────────────────────────────────────
  if (!config.dryRun) {
    const balance = await getUsdcBalance();
    if (balance < recoverySize) {
      logger.warn(
        `MM recovery: insufficient balance $${balance.toFixed(2)} < $${recoverySize} needed`,
      );
      return;
    }
  }

  logger.trade(
    `MM recovery${config.dryRun ? '[SIM]' : ''}: buying ${candidate.side} @ $${candidate.price.toFixed(3)} | size $${recoverySize}`,
  );

  // ── Market buy ────────────────────────────────────────────────
  let entryPrice = candidate.price;
  let filledShares = recoverySize / entryPrice; // default estimate

  if (config.dryRun) {
    logger.money(
      `MM recovery[SIM]: bought ${filledShares.toFixed(3)} ${candidate.side} @ $${entryPrice.toFixed(3)}`,
    );
  } else {
    try {
      const res = await client.createAndPostMarketOrder(
        { tokenID: candidate.tokenId, side: Side.BUY, amount: recoverySize, price: 0.99 },
        { tickSize, negRisk },
        OrderType.FOK,
      );
      if (!res?.success) {
        logger.warn(`MM recovery: order not filled — ${extractOrderFailureReason(res)}`);
        return;
      }
      entryPrice = parseFloat(res.price || String(candidate.price));
      filledShares = parseFloat(res.takingAmount || String(recoverySize / entryPrice));
      logger.money(
        `MM recovery: FILLED ${candidate.side} ${filledShares.toFixed(3)} sh @ $${entryPrice.toFixed(3)} | potential payout $${filledShares.toFixed(2)}`,
      );
    } catch (err) {
      logger.error(`MM recovery: buy error — ${extractOrderFailureReason(err)}`);
      return;
    }
  }

  // ── Monitor for 30s — cut loss if price worsens ───────────────
  logger.info(
    `MM recovery: holding ${candidate.side} — will cut if price < $${entryPrice.toFixed(3)} after 30s`,
  );
  await sleep(30_000);

  // Skip second CL if market is already closed or about to close (< 5s left)
  const msLeft = new Date(pos.endTime).getTime() - Date.now();
  if (msLeft < 5_000) {
    logger.info(`MM recovery: market closing — skipping 2nd CL, letting position resolve`);
    return;
  }

  // Check current price
  let currentPrice = entryPrice;
  try {
    const mp = await client.getMidpoint(candidate.tokenId);
    currentPrice = parseFloat(mp?.mid ?? mp ?? String(entryPrice)) || entryPrice;
  } catch {
    /* use entryPrice as fallback */
  }

  if (currentPrice >= entryPrice) {
    logger.success(
      `MM recovery: price holding $${currentPrice.toFixed(3)} ≥ entry $${entryPrice.toFixed(3)} — keeping position`,
    );
    return;
  }

  // Price has worsened — cut loss
  const priceDrop = (((entryPrice - currentPrice) / entryPrice) * 100).toFixed(1);
  logger.warn(
    `MM recovery: price dropped $${entryPrice.toFixed(3)} → $${currentPrice.toFixed(3)} (-${priceDrop}%) — cutting loss`,
  );

  if (config.dryRun) {
    const simPnl = (currentPrice - entryPrice) * filledShares;
    logger.warn(
      `MM recovery[SIM]: 2nd CL @ $${currentPrice.toFixed(3)} | P&L $${simPnl.toFixed(2)}`,
    );
    return;
  }

  try {
    const sellRes = await client.createAndPostMarketOrder(
      { tokenID: candidate.tokenId, side: Side.SELL, amount: filledShares, price: 0.01 },
      { tickSize, negRisk },
      OrderType.FOK,
    );
    if (sellRes?.success) {
      const sellPrice = parseFloat(sellRes.price || String(currentPrice));
      const pnl = (sellPrice - entryPrice) * filledShares;
      logger.warn(`MM recovery: 2nd CL sold @ $${sellPrice.toFixed(3)} | P&L $${pnl.toFixed(2)}`);
    } else {
      logger.warn(
        `MM recovery: 2nd CL sell failed — ${extractOrderFailureReason(sellRes)} — position will resolve at close`,
      );
    }
  } catch (err) {
    logger.error(`MM recovery: 2nd CL sell error — ${extractOrderFailureReason(err)}`);
  }
}

function calcPnl(pos) {
  const yesPnl = pos.yes.filled ? (pos.yes.fillPrice - pos.yes.entryPrice) * pos.yes.shares : 0;
  const noPnl = pos.no.filled ? (pos.no.fillPrice - pos.no.entryPrice) * pos.no.shares : 0;
  return yesPnl + noPnl;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function executeMMStrategy(market) {
  const { asset, conditionId, question, endTime, yesTokenId, noTokenId, negRisk, tickSize } =
    market;
  const tag = asset ? `[${asset.toUpperCase()}]` : '';
  const label = question.substring(0, 40);
  const sim = config.dryRun ? '[SIM] ' : '';

  logger.info(`MM${tag}: ${sim}entering — ${label}`);

  // ── Balance check ───────────────────────────────────────────
  const totalNeeded = config.mmTradeSize * 2; // $10 total → 10 YES + 10 NO
  if (!config.dryRun) {
    const balance = await getUsdcBalance();
    if (balance < totalNeeded) {
      logger.error(`MM${tag}: insufficient balance $${balance.toFixed(2)} (need $${totalNeeded})`);
      return;
    }
  }

  // ── Split USDC into YES+NO via CTF splitPosition ────────────
  // Deposit mmTradeSize*2 USDC → get mmTradeSize*2 YES + mmTradeSize*2 NO tokens
  // Entry price is exactly $0.50 per token on both sides (no spread, no slippage)
  logger.trade(`MM${tag}: ${sim}splitPosition $${totalNeeded} USDC → YES + NO @ $0.50`);
  let entryMethod = 'split';
  let yesShares;
  let noShares;
  let yesEntryPrice = 0.5;
  let noEntryPrice = 0.5;

  try {
    const splitShares = await splitPosition(conditionId, totalNeeded, negRisk);
    yesShares = splitShares;
    noShares = splitShares;
    logger.info(`MM${tag}: split done — ${splitShares} YES + ${splitShares} NO @ $0.50`);
  } catch (err) {
    logger.warn(`MM${tag}: splitPosition failed — ${err.message}`);

    if (!config.mmSplitFallback) {
      logger.error(`MM${tag}: split fallback is disabled (set MM_SPLIT_FALLBACK=true to enable)`);
      return;
    }

    logger.warn(
      `MM${tag}: falling back to CLOB dual market-buy entry (merge cut-loss disabled for this position)...`,
    );

    const [yesBuy, noBuy] = await Promise.all([
      placeMarketBuy(yesTokenId, config.mmTradeSize, tickSize, negRisk),
      placeMarketBuy(noTokenId, config.mmTradeSize, tickSize, negRisk),
    ]);

    if (!yesBuy.success || !noBuy.success) {
      const yesReason = yesBuy.reason ? `YES ${yesBuy.reason}` : null;
      const noReason = noBuy.reason ? `NO ${noBuy.reason}` : null;
      const detail = [yesReason, noReason].filter(Boolean).join(' | ');
      logger.error(`MM${tag}: fallback market-buy entry failed${detail ? ` (${detail})` : ''}`);
      return;
    }

    entryMethod = 'clob';
    yesShares = yesBuy.shares;
    noShares = noBuy.shares;
    yesEntryPrice = yesBuy.fillPrice;
    noEntryPrice = noBuy.fillPrice;

    logger.money(
      `MM${tag}: fallback entry filled — YES ${yesShares.toFixed(3)} @ $${yesEntryPrice.toFixed(3)} | NO ${noShares.toFixed(3)} @ $${noEntryPrice.toFixed(3)}`,
    );
  }

  // ── Place limit sells ───────────────────────────────────────
  logger.info(`MM${tag}: ${sim}placing limit sells @ $${config.mmSellPrice}`);
  const yesSell = await placeLimitSell(
    yesTokenId,
    yesShares,
    config.mmSellPrice,
    tickSize,
    negRisk,
  );
  const noSell = await placeLimitSell(noTokenId, noShares, config.mmSellPrice, tickSize, negRisk);

  if (!yesSell.success || !noSell.success) {
    const yesReason = yesSell.reason ? `YES ${yesSell.reason}` : null;
    const noReason = noSell.reason ? `NO ${noSell.reason}` : null;
    const detail = [yesReason, noReason].filter(Boolean).join(' | ');
    logger.error(
      `MM${tag}: failed to place limit sells — cutting immediately${detail ? ` (${detail})` : ''}`,
    );
  }

  // ── Build position object ───────────────────────────────────
  const pos = {
    asset: asset || 'btc',
    conditionId,
    question,
    endTime,
    tickSize,
    negRisk,
    entryMethod,
    status: 'monitoring',
    enteredAt: new Date().toISOString(),
    yes: {
      tokenId: yesTokenId,
      shares: yesShares,
      entryPrice: yesEntryPrice,
      entryCost: config.mmTradeSize, // $5 per side
      orderId: yesSell.orderId,
      filled: !yesSell.success, // mark as needing cut if sell failed
      fillPrice: null,
    },
    no: {
      tokenId: noTokenId,
      shares: noShares,
      entryPrice: noEntryPrice,
      entryCost: config.mmTradeSize,
      orderId: noSell.orderId,
      filled: !noSell.success,
      fillPrice: null,
    },
  };

  activePositions.set(conditionId, pos);

  // ── Monitor (runs until done/cut/expired) ───────────────────
  await monitorAndManage(pos);

  activePositions.delete(conditionId);
}
