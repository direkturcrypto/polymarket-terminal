import { ethers } from 'ethers';
import config from '../config/index.js';
import { getPolygonProvider } from './client.js';
import { execSafeCall, CTF_ADDRESS, USDC_ADDRESS } from './ctf.js';
import { getOpenPositions, removePosition } from './position.js';
import { recordSimResult } from '../utils/simStats.js';
import logger from '../utils/logger.js';
import { proxyFetch } from '../utils/proxy.js';

// CTF ABI (minimal — read-only calls only; writes go through execSafeCall)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 tokenId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

/**
 * Check if a market has been resolved via Gamma API
 */
async function checkMarketResolution(conditionId) {
    try {
        const url = `${config.gammaHost}/markets?condition_id=${conditionId}`;
        const response = await proxyFetch(url);
        if (!response.ok) return null;

        const markets = await response.json();
        if (!markets || markets.length === 0) return null;

        const market = markets[0];
        return {
            resolved: market.closed || market.resolved || false,
            active: market.active,
            question: market.question,
        };
    } catch (err) {
        logger.error('Failed to check market resolution:', err.message);
        return null;
    }
}

/**
 * Check on-chain payout fractions for a condition
 * Returns: { resolved: bool, payouts: [yes_fraction, no_fraction] }
 */
async function checkOnChainPayout(conditionId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

        const denominator = await ctf.payoutDenominator(conditionId);
        if (denominator.isZero()) return { resolved: false, payouts: [] };

        const payouts = [];
        for (let i = 0; i < 2; i++) {
            const numerator = await ctf.payoutNumerators(conditionId, i);
            payouts.push(numerator.toNumber() / denominator.toNumber());
        }

        return { resolved: true, payouts };
    } catch {
        return { resolved: false, payouts: [] };
    }
}

/**
 * Redeem winning position on-chain via the Gnosis Safe proxy wallet.
 * Uses execSafeCall (same as MM bot) so:
 *   - tx is signed by the EOA but executed FROM the proxy wallet
 *   - Polygon 30 Gwei minimum tip is enforced
 *   - automatic retry on transient errors
 */
async function redeemPosition(conditionId) {
    try {
        const ctfIface = new ethers.utils.Interface(CTF_ABI);
        const data = ctfIface.encodeFunctionData('redeemPositions', [
            USDC_ADDRESS,
            ethers.constants.HashZero,
            conditionId,
            [1, 2],
        ]);

        const label = conditionId.slice(0, 12) + '...';
        logger.info(`Redeeming position: ${label}`);
        const receipt = await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${label}`);
        const txHash = receipt.transactionHash;
        logger.success(`Redeemed in block ${receipt.blockNumber} | tx: ${txHash}`);
        return true;
    } catch (err) {
        logger.error(`Failed to redeem: ${err.message}`);
        return false;
    }
}

/**
 * Simulate redemption: determine win/loss and record stats
 */
async function simulateRedeem(position) {
    // Need on-chain payout to know who actually won
    const onChain = await checkOnChainPayout(position.conditionId);

    if (!onChain.resolved) {
        logger.info(`[SIM] Market resolved via API but payout not on-chain yet: ${position.market}`);
        return false; // check again next interval
    }

    // outcome index: YES = 0, NO = 1
    const outcomeStr = (position.outcome || 'yes').toLowerCase();
    const outcomeIdx = outcomeStr === 'yes' ? 0 : 1;
    const payoutFraction = onChain.payouts[outcomeIdx] ?? 0;

    // In Polymarket, winning shares redeem at $1 each
    const returned = payoutFraction * position.shares;
    const pnl = returned - position.totalCost;

    if (payoutFraction > 0) {
        logger.money(
            `[SIM] WIN! "${position.market}" | ${position.outcome} won` +
            ` | +$${pnl.toFixed(2)} (+${((pnl / position.totalCost) * 100).toFixed(1)}%)`,
        );
        recordSimResult(position, 'WIN', pnl, returned);
    } else {
        logger.error(
            `[SIM] LOSS: "${position.market}" | ${position.outcome} lost` +
            ` | -$${position.totalCost.toFixed(2)} (-100%)`,
        );
        recordSimResult(position, 'LOSS', pnl, returned);
    }

    removePosition(position.conditionId);
    return true;
}

/**
 * Check all open positions for resolved markets and redeem/simulate
 */
export async function checkAndRedeemPositions() {
    const positions = getOpenPositions();
    if (positions.length === 0) return;

    logger.info(`Checking ${positions.length} position(s) for resolution...`);

    for (const position of positions) {
        try {
            // 1. Quick check via Gamma API (low cost)
            const resolution = await checkMarketResolution(position.conditionId);
            const apiResolved = resolution?.resolved;

            if (!apiResolved) continue; // Not resolved yet — check again next interval

            logger.info(`Market resolved via API: ${position.market}`);

            // 2. ALWAYS verify on-chain payout before calling redeemPositions.
            //    Gamma API can report "resolved" before payoutDenominator is written
            //    on-chain. Calling redeemPositions with payoutDenominator == 0 causes
            //    the contract to revert → gas estimation failure.
            const onChain = await checkOnChainPayout(position.conditionId);
            if (!onChain.resolved) {
                logger.info(`On-chain payout not set yet for ${position.market} — will retry next interval`);
                continue;
            }

            // 3. Simulate or execute real redeem
            if (config.dryRun) {
                await simulateRedeem(position);
            } else {
                const success = await redeemPosition(position.conditionId);
                if (success) {
                    removePosition(position.conditionId);
                    logger.money(`Redeemed: ${position.market} → USDC recovered`);
                } else {
                    logger.warn(`Redeem failed for ${position.market}, will retry next interval — continuing to next position...`);
                }
            }
        } catch (err) {
            logger.error(`Error checking ${position.market}:`, err.message);
            logger.info(`Continuing to next position...`);
        }
    }
}
