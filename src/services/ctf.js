/**
 * ctf.js
 * Helpers for interacting with Polymarket's ConditionalTokens (CTF) contract
 * directly from the Gnosis Safe proxy wallet.
 *
 * Key operations:
 *   splitPosition   — deposit USDC → receive equal YES+NO tokens at $0.50 each
 *   mergePositions  — return equal YES+NO tokens → recover USDC (cut-loss with no slippage)
 */

import { ethers } from 'ethers';
import config from '../config/index.js';
import { getSigner, getPolygonProvider } from './client.js';
import logger from '../utils/logger.js';
import { proxyFetch } from '../utils/proxy.js';

// ── Contract addresses (Polygon mainnet) ──────────────────────────────────────

export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
export const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e
export const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
export const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// ── ABIs (minimal) ────────────────────────────────────────────────────────────

const SAFE_ABI = [
    'function nonce() view returns (uint256)',
    'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
];

// Minimum shares per side (Polymarket allows fractional; we enforce 2.5 as practical floor)
export const MIN_SHARES_PER_SIDE = 2.5;

const CTF_ABI = [
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

const ERC1155_ABI = [
    'function isApprovedForAll(address account, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
];

// ── Error helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Convert a raw ethers.js / RPC error into a short, human-readable message.
 * Strips the lengthy internal stack info that ethers appends.
 */
function parseOnchainError(err) {
    const msg = err?.message || String(err);
    const reason = err?.reason || err?.error?.reason || '';

    if (msg.includes('insufficient funds') || msg.includes('insufficient balance'))
        return 'Insufficient MATIC balance for gas fees';
    if (msg.includes('nonce too low') || msg.includes('nonce has already been used'))
        return 'Transaction nonce conflict (nonce already used)';
    if (msg.includes('replacement transaction underpriced'))
        return 'Gas price too low to replace previous transaction';
    if (msg.includes('gas tip cap') && msg.includes('minimum needed'))
        return 'Priority fee below Polygon minimum (25 Gwei)';
    if (msg.includes('UNPREDICTABLE_GAS_LIMIT'))
        return 'Gas estimation failed — transaction will likely revert';
    if (msg.includes('execution reverted') || err?.code === 'CALL_EXCEPTION')
        return reason ? `Transaction reverted: ${reason}` : 'Transaction reverted by smart contract';
    if (msg.includes('timeout') || msg.includes('TIMEOUT'))
        return 'RPC request timed out';
    if (msg.includes('SERVER_ERROR') || msg.includes('Internal Server Error'))
        return 'RPC server error';
    if (msg.includes('NETWORK_ERROR') || msg.includes('network changed'))
        return 'Network connection lost';
    if (msg.includes('ECONNREFUSED') || msg.includes('connection refused'))
        return 'Cannot connect to Polygon RPC';
    if (msg.includes('header not found'))
        return 'RPC node not synced — please retry';

    // Fallback: extract the first sentence before ethers noise
    const first = msg.split('\n')[0].split('(')[0].trim();
    return first.length > 120 ? first.slice(0, 120) + '…' : (first || 'Unknown error');
}

// ── Safe transaction executor ─────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY = 3000; // ms

// Gnosis Safe nonces are sequential — concurrent calls would read the same nonce
// and cause "nonce too low" for all but the first. This queue ensures every on-chain
// tx waits for the previous one to fully confirm before starting.
let _txQueue = Promise.resolve();

/**
 * Execute an arbitrary call through the Gnosis Safe proxy wallet.
 * Calls are serialized via an internal queue so nonces never collide.
 * Retries up to MAX_RETRIES times on transient errors.
 */
export function execSafeCall(to, data, description = '') {
    // Enqueue: this call will only start after the previous one resolves/rejects
    const result = _txQueue.then(() => _doExecSafeCall(to, data, description));
    // Don't let a failure poison the queue for subsequent calls
    _txQueue = result.catch(() => { });
    return result;
}

async function _doExecSafeCall(to, data, description = '') {
    if (description) logger.info(`MM: exec safe tx — ${description}`);

    let lastErr;
    // Track gas price multiplier for replacement transactions
    let gasMultiplier = 1;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const provider = await getPolygonProvider();
            const wallet = getSigner().connect(provider);
            const safe = new ethers.Contract(config.proxyWallet, SAFE_ABI, wallet);

            const nonce = await safe.nonce();

            // Get the Safe's typed transaction hash
            const txHash = await safe.getTransactionHash(
                to,
                0,                                    // value (ETH)
                data,
                0,                                    // operation: CALL
                0,                                    // safeTxGas
                0,                                    // baseGas
                0,                                    // gasPrice
                ethers.constants.AddressZero,         // gasToken
                ethers.constants.AddressZero,         // refundReceiver
                nonce,
            );

            // Sign the raw hash with the EOA signing key (no EIP-191 prefix)
            // Gnosis Safe v1.3.0 treats plain ECDSA signatures (v=27/28) on the tx hash directly
            const signingKey = new ethers.utils.SigningKey(config.privateKey);
            const rawSig = signingKey.signDigest(txHash);
            const signature = ethers.utils.joinSignature(rawSig);

            // Polygon requires maxPriorityFeePerGas ≥ 25 Gwei.
            // Some RPC nodes (e.g. lava.build) return a stale low estimate, so we enforce a floor.
            const feeData = await provider.getFeeData();

            // Increase gas price on retry to replace pending transaction
            // Multiplier: 1x → 2x → 4x on subsequent attempts
            const MIN_TIP = ethers.utils.parseUnits('30', 'gwei').mul(Math.ceil(gasMultiplier));
            const gasTip = feeData.maxPriorityFeePerGas?.mul(Math.ceil(gasMultiplier)).gt(MIN_TIP)
                ? feeData.maxPriorityFeePerGas.mul(Math.ceil(gasMultiplier))
                : MIN_TIP;
            const gasFeeCap = (feeData.maxFeePerGas ?? ethers.utils.parseUnits('500', 'gwei'))
                .mul(Math.ceil(gasMultiplier * 1.5));

            const tx = await safe.execTransaction(
                to, 0, data, 0, 0, 0, 0,
                ethers.constants.AddressZero,
                ethers.constants.AddressZero,
                signature,
                { maxPriorityFeePerGas: gasTip, maxFeePerGas: gasFeeCap },
            );

            const receipt = await tx.wait();
            return receipt;

        } catch (err) {
            lastErr = err;
            const friendly = parseOnchainError(err);

            if (attempt < MAX_RETRIES) {
                // Increase gas multiplier for replacement transaction
                if (err?.message?.includes('replacement transaction underpriced') ||
                    err?.message?.includes('Gas price too low to replace')) {
                    gasMultiplier *= 2;
                    logger.warn(`MM: transaction failed (attempt ${attempt}/${MAX_RETRIES}): ${friendly} — increasing gas ${gasMultiplier}x and retrying...`);
                } else {
                    logger.warn(`MM: transaction failed (attempt ${attempt}/${MAX_RETRIES}): ${friendly} — retrying in ${RETRY_DELAY / 1000}s...`);
                }
                await sleep(RETRY_DELAY);
            }
        }
    }

    // All retries exhausted — throw a clean, human-readable error
    throw new Error(parseOnchainError(lastErr));
}

// ── Approval helpers ──────────────────────────────────────────────────────────

/**
 * Ensure the CTF contract can spend USDC from the proxy wallet.
 */
async function ensureUsdcApproval(amountWei) {
    const provider = await getPolygonProvider();
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const allowance = await usdc.allowance(config.proxyWallet, CTF_ADDRESS);
    if (allowance.gte(amountWei)) return;

    const iface = new ethers.utils.Interface(ERC20_ABI);
    const data = iface.encodeFunctionData('approve', [CTF_ADDRESS, ethers.constants.MaxUint256]);
    await execSafeCall(USDC_ADDRESS, data, 'approve USDC → CTF');
    logger.success('MM: USDC approved to CTF contract');
}

/**
 * Ensure the CTF exchange is an approved ERC1155 operator (needed for limit sell orders).
 * This is a one-time per-wallet setup.
 */
export async function ensureExchangeApproval(negRisk = false) {
    const exchange = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE;
    const provider = await getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, provider);

    const approved = await ctf.isApprovedForAll(config.proxyWallet, exchange);
    if (approved) return;

    const iface = new ethers.utils.Interface(ERC1155_ABI);
    const data = iface.encodeFunctionData('setApprovalForAll', [exchange, true]);
    await execSafeCall(CTF_ADDRESS, data, 'setApprovalForAll → CTF Exchange');
    logger.success(`MM: CTF exchange approved as ERC1155 operator`);
}

// ── Core CTF operations ───────────────────────────────────────────────────────

/**
 * Split `amountUsdc` USDC into equal YES+NO conditional tokens via the CTF contract.
 *
 * This gives a flat $0.50 entry on BOTH sides with zero slippage:
 *   e.g. split $10 → 10 YES tokens + 10 NO tokens, each at $0.50 entry cost
 *
 * @param  {string} conditionId  - Market conditionId (bytes32 hex string)
 * @param  {number} amountUsdc   - Total USDC to split (both sides combined)
 * @param  {boolean} negRisk     - Whether the market uses negRisk exchange
 * @returns {number} shares      - Number of tokens per side (= amountUsdc)
 */
export async function splitPosition(conditionId, amountUsdc, negRisk = false) {
    // shares per side = amountUsdc (each token entry price = $0.50, so $10 gives 10 shares each side)
    const shares = amountUsdc;

    // Practical minimum: 2.5 shares per side → minimum $5 total (2 × $2.5)
    if (shares < MIN_SHARES_PER_SIDE) {
        throw new Error(
            `MM_TRADE_SIZE too small: ${shares} shares per side (minimum is ${MIN_SHARES_PER_SIDE}). ` +
            `Set MM_TRADE_SIZE ≥ ${MIN_SHARES_PER_SIDE} in your .env (current value: ${config.mmTradeSize}).`,
        );
    }

    if (config.dryRun) {
        logger.info(`MM[SIM]: split $${amountUsdc} USDC → ${shares} YES + ${shares} NO @ $0.50 each`);
        return shares;
    }

    const amountWei = ethers.utils.parseUnits(amountUsdc.toFixed(6), 6);

    // 1. Ensure USDC is approved to CTF contract
    await ensureUsdcApproval(amountWei);

    // 2. Ensure CTF exchange is approved to move tokens (needed for limit sells)
    await ensureExchangeApproval(negRisk);

    // 3. Call splitPosition on CTF contract
    const ctfIface = new ethers.utils.Interface(CTF_ABI);
    const data = ctfIface.encodeFunctionData('splitPosition', [
        USDC_ADDRESS,
        ethers.constants.HashZero, // parentCollectionId = bytes32(0) for root positions
        conditionId,
        [1, 2],                    // full binary partition: YES=indexSet(1), NO=indexSet(2)
        amountWei,
    ]);

    await execSafeCall(CTF_ADDRESS, data, `splitPosition conditionId=${conditionId.slice(0, 10)}...`);
    logger.success(`MM: split $${amountUsdc} USDC → ${shares} YES + ${shares} NO @ $0.50`);
    return shares;
}

/**
 * Merge equal YES+NO tokens back into USDC via the CTF contract.
 * Used for cut-loss when neither limit sell has been filled — recovers entry cost with no slippage.
 *
 * @param  {string} conditionId   - Market conditionId
 * @param  {number} sharesPerSide - How many tokens to merge (must be equal on both sides)
 * @returns {number} recoveredUsdc - USDC recovered (= sharesPerSide)
 */
export async function mergePositions(conditionId, sharesPerSide) {
    if (config.dryRun) {
        const recovered = sharesPerSide;
        logger.info(`MM[SIM]: merge ${sharesPerSide} YES+NO → $${recovered} USDC recovered`);
        return recovered;
    }

    const amountWei = ethers.utils.parseUnits(sharesPerSide.toFixed(6), 6);

    const ctfIface = new ethers.utils.Interface(CTF_ABI);
    const data = ctfIface.encodeFunctionData('mergePositions', [
        USDC_ADDRESS,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        amountWei,
    ]);

    await execSafeCall(CTF_ADDRESS, data, `mergePositions conditionId=${conditionId.slice(0, 10)}...`);
    logger.success(`MM: merged — recovered $${sharesPerSide} USDC`);
    return sharesPerSide;
}

/**
 * Cleanup on startup: find any open CTF token positions in the proxy wallet
 * and merge them back to USDC so we start with a clean slate.
 *
 * Strategy:
 *  1. Query Data API for the proxy wallet's open positions
 *  2. For each conditionId found, check on-chain ERC1155 balances for YES and NO tokens
 *  3. If the market is NOT yet resolved (payoutDenominator == 0), merge equal YES+NO back to USDC
 *  4. Cancel any open CLOB orders via the CLOB client
 *
 * @param {import('@polymarket/clob-client').ClobClient} clobClient
 */
export async function cleanupOpenPositions(clobClient) {
    logger.info('MM: scanning for leftover positions to clean up...');

    // ── 1. Cancel all open CLOB orders ──────────────────────────────────────────
    try {
        if (!config.dryRun) {
            const openOrders = await clobClient.getOpenOrders();
            if (Array.isArray(openOrders) && openOrders.length > 0) {
                logger.warn(`MM: cancelling ${openOrders.length} dangling open order(s)...`);
                for (const order of openOrders) {
                    try { await clobClient.cancelOrder({ orderID: order.id ?? order.order_id }); } catch { /* ignore */ }
                }
                logger.success('MM: all open orders cancelled');
            }
        }
    } catch (err) {
        logger.warn('MM: could not fetch open orders:', err.message);
    }

    // ── 2. Query Data API for proxy wallet positions ─────────────────────────────
    let dataPositions = [];
    try {
        const url = `https://data-api.polymarket.com/positions?user=${config.proxyWallet}`;
        const resp = await proxyFetch(url);
        if (resp.ok) dataPositions = await resp.json();
        if (!Array.isArray(dataPositions)) dataPositions = [];
    } catch (err) {
        logger.warn('MM: could not fetch positions from Data API:', err.message);
        return;
    }

    if (dataPositions.length === 0) {
        logger.info('MM: no open positions found — starting clean ✅');
        return;
    }

    logger.warn(`MM: found ${dataPositions.length} open position(s) — attempting to merge back to USDC...`);

    const provider = await getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

    // Group by conditionId
    const byCondition = new Map();
    for (const pos of dataPositions) {
        const cid = pos.conditionId || pos.condition_id;
        const tid = pos.asset || pos.tokenId || pos.token_id;
        if (!cid || !tid) continue;
        if (!byCondition.has(cid)) byCondition.set(cid, []);
        byCondition.get(cid).push({ tokenId: String(tid), size: parseFloat(pos.size || pos.currentValue || '0') });
    }

    let mergedCount = 0;
    for (const [conditionId, tokens] of byCondition) {
        try {
            // Check if market is already resolved (skip if so — redeemer handles those)
            const denominator = await ctf.payoutDenominator(conditionId);
            if (!denominator.isZero()) {
                logger.info(`MM: conditionId ${conditionId.slice(0, 10)}... already resolved — skipping (redeemer will handle)`);
                continue;
            }

            // Check on-chain ERC1155 token balances for each token
            const balances = await Promise.all(
                tokens.map(({ tokenId }) =>
                    ctf.balanceOf(config.proxyWallet, tokenId).then((b) => ({
                        tokenId,
                        shares: parseFloat(ethers.utils.formatUnits(b, 6)),
                        raw: b,
                    }))
                )
            );

            const nonZero = balances.filter((b) => b.shares >= MIN_SHARES_PER_SIDE);
            if (nonZero.length < 2) {
                logger.info(`MM: conditionId ${conditionId.slice(0, 10)}... balance too low to merge — skipping`);
                continue;
            }

            // Use the minimum balance across both sides as the merge amount
            const minShares = Math.min(...nonZero.map((b) => b.shares));
            logger.warn(`MM: merging ${minShares.toFixed(3)} YES+NO → USDC for ${conditionId.slice(0, 10)}...`);

            if (!config.dryRun) {
                await mergePositions(conditionId, minShares);
                mergedCount++;
            } else {
                logger.info(`MM[SIM]: would merge ${minShares.toFixed(3)} shares for ${conditionId.slice(0, 10)}...`);
            }
        } catch (err) {
            logger.error(`MM: failed to clean up ${conditionId.slice(0, 10)}... — ${parseOnchainError(err)}`);
        }
    }

    if (mergedCount > 0) {
        logger.success(`MM: cleanup complete — merged ${mergedCount} position(s) back to USDC ✅`);
    } else {
        logger.info('MM: cleanup done — nothing needed merging ✅');
    }
}

// ── Periodic redeemer ─────────────────────────────────────────────────────────

/**
 * Check all positions held by the proxy wallet, find resolved markets,
 * and call redeemPositions via the Safe to collect USDC.
 *
 * Covers recovery buy positions, residual tokens from splits, and anything
 * else that resolved without being sold through the CLOB.
 *
 * Called automatically every redeemInterval seconds from mm.js.
 */
export async function redeemMMPositions() {
    // 1. Query Data API for all positions held by the proxy wallet
    let dataPositions = [];
    try {
        const resp = await proxyFetch(`${config.dataHost}/positions?user=${config.proxyWallet}`);
        if (resp.ok) dataPositions = await resp.json();
        if (!Array.isArray(dataPositions)) dataPositions = [];
    } catch {
        return; // silent — will retry next interval
    }

    if (dataPositions.length === 0) return;

    const provider = await getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const ctfIface = new ethers.utils.Interface(CTF_ABI);

    // Group tokens by conditionId
    const byCondition = new Map();
    for (const pos of dataPositions) {
        const cid = pos.conditionId || pos.condition_id;
        const tid = pos.asset || pos.tokenId || pos.token_id;
        if (!cid || !tid) continue;
        if (!byCondition.has(cid)) byCondition.set(cid, []);
        byCondition.get(cid).push({
            tokenId: String(tid),
            size: parseFloat(pos.size || pos.currentValue || '0'),
        });
    }

    let redeemed = 0;

    for (const [conditionId, tokens] of byCondition) {
        try {
            // Skip unresolved markets
            const denominator = await ctf.payoutDenominator(conditionId);
            if (denominator.isZero()) continue;

            // Check actual on-chain token balances (positions API can lag)
            const balances = await Promise.all(
                tokens.map(({ tokenId }) =>
                    ctf.balanceOf(config.proxyWallet, tokenId)
                        .then((b) => parseFloat(ethers.utils.formatUnits(b, 6)))
                )
            );
            const totalShares = balances.reduce((a, b) => a + b, 0);
            if (totalShares < 0.001) continue; // nothing on-chain to redeem

            // Estimate payout from numerators (for logging only)
            const payoutFractions = await Promise.all(
                [0, 1].map((i) =>
                    ctf.payoutNumerators(conditionId, i)
                        .then((n) => n.toNumber() / denominator.toNumber())
                )
            );
            const expectedUsdc = balances.reduce(
                (sum, shares, i) => sum + shares * (payoutFractions[i] ?? 0), 0
            );

            const label = conditionId.slice(0, 12) + '...';

            if (config.dryRun) {
                logger.money(`MM[SIM] redeem: ${label} — ${totalShares.toFixed(3)} shares → ~$${expectedUsdc.toFixed(2)} USDC`);
                continue;
            }

            logger.info(`MM redeemer: ${label} resolved — ${totalShares.toFixed(3)} shares → ~$${expectedUsdc.toFixed(2)} USDC`);

            // Call redeemPositions through Safe (indexSets [1,2] covers both YES and NO)
            const data = ctfIface.encodeFunctionData('redeemPositions', [
                USDC_ADDRESS,
                ethers.constants.HashZero,
                conditionId,
                [1, 2],
            ]);
            await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${label}`);
            logger.money(`MM redeemer: redeemed ${label} → ~$${expectedUsdc.toFixed(2)} USDC`);
            redeemed++;
        } catch (err) {
            logger.error(`MM redeemer: failed to redeem ${conditionId.slice(0, 12)}... — ${parseOnchainError(err)}`);
        }
    }

    if (redeemed > 0) {
        logger.success(`MM redeemer: collected ${redeemed} resolved position(s)`);
    }
}

// ── Sniper-specific redeemer ──────────────────────────────────────────────────

// Track conditionIds that repeatedly fail to avoid retrying every cycle
const _failedConditions = new Set();

/**
 * Redeem sniper positions via Gnosis Safe.
 * Works exactly like the MM redeemer (redeemMMPositions):
 *   - Redeems ALL resolved positions (both winners and losers)
 *   - Burning loser tokens cleans them from the Data API, keeping cycles fast
 *   - Logs winners separately for profit tracking
 *   - Skips conditionIds that previously reverted on-chain
 */
export async function redeemSniperPositions() {
    // 1. Query Data API for all positions held by the proxy wallet
    let dataPositions = [];
    try {
        const resp = await proxyFetch(`${config.dataHost}/positions?user=${config.proxyWallet}`);
        if (!resp.ok) {
            logger.warn(`SNIPER redeemer: Data API returned ${resp.status} — will retry`);
            return;
        }
        dataPositions = await resp.json();
        if (!Array.isArray(dataPositions)) dataPositions = [];
    } catch (err) {
        logger.warn(`SNIPER redeemer: Data API fetch failed — ${err.message}`);
        return;
    }

    if (dataPositions.length === 0) return;

    const provider = await getPolygonProvider();
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const ctfIface = new ethers.utils.Interface(CTF_ABI);

    // Group tokens by conditionId
    const byCondition = new Map();
    for (const pos of dataPositions) {
        const cid = pos.conditionId || pos.condition_id;
        const tid = pos.asset || pos.tokenId || pos.token_id;
        if (!cid || !tid) continue;
        if (!byCondition.has(cid)) byCondition.set(cid, []);
        byCondition.get(cid).push({
            tokenId: String(tid),
            size: parseFloat(pos.size || pos.currentValue || '0'),
        });
    }

    let redeemed = 0;

    for (const [conditionId, tokens] of byCondition) {
        // Skip conditionIds that previously failed on-chain
        if (_failedConditions.has(conditionId)) continue;

        try {
            // Skip unresolved markets
            const denominator = await ctf.payoutDenominator(conditionId);
            if (denominator.isZero()) continue;

            // Check actual on-chain token balances (positions API can lag)
            const balances = await Promise.all(
                tokens.map(({ tokenId }) =>
                    ctf.balanceOf(config.proxyWallet, tokenId)
                        .then((b) => parseFloat(ethers.utils.formatUnits(b, 6)))
                )
            );
            const totalShares = balances.reduce((a, b) => a + b, 0);
            if (totalShares < 0.001) continue; // nothing on-chain to redeem

            // Estimate payout from numerators (for logging)
            const payoutFractions = await Promise.all(
                [0, 1].map((i) =>
                    ctf.payoutNumerators(conditionId, i)
                        .then((n) => n.toNumber() / denominator.toNumber())
                )
            );
            const expectedUsdc = balances.reduce(
                (sum, shares, i) => sum + shares * (payoutFractions[i] ?? 0), 0
            );

            const label = conditionId.slice(0, 12) + '...';
            const isWin = expectedUsdc >= 0.01;

            if (config.dryRun) {
                if (isWin) {
                    logger.money(`SNIPER[SIM] redeem: ${label} — ${totalShares.toFixed(3)} shares → ~$${expectedUsdc.toFixed(2)} USDC (WIN)`);
                } else {
                    logger.info(`SNIPER[SIM] redeem: ${label} — ${totalShares.toFixed(3)} shares → $0 (loss, burning tokens)`);
                }
                continue;
            }

            logger.info(`SNIPER redeemer: ${label} resolved — ${totalShares.toFixed(3)} shares → ~$${expectedUsdc.toFixed(2)} USDC${isWin ? '' : ' (loss)'}`);

            // Call redeemPositions through Safe — exactly like MM redeemer
            const data = ctfIface.encodeFunctionData('redeemPositions', [
                USDC_ADDRESS,
                ethers.constants.HashZero,
                conditionId,
                [1, 2],
            ]);
            await execSafeCall(CTF_ADDRESS, data, `redeemPositions ${label}`);

            if (isWin) {
                logger.money(`SNIPER redeemer: redeemed ${label} → ~$${expectedUsdc.toFixed(2)} USDC ✅`);
            } else {
                logger.info(`SNIPER redeemer: burned ${label} tokens (loss cleared)`);
            }
            redeemed++;
        } catch (err) {
            const friendly = parseOnchainError(err);
            logger.error(`SNIPER redeemer: failed ${conditionId.slice(0, 12)}... — ${friendly}`);
            // Don't retry this conditionId next cycle — it will keep failing
            _failedConditions.add(conditionId);
            logger.warn(`SNIPER redeemer: skipping ${conditionId.slice(0, 12)}... in future cycles`);
        }
    }

    if (redeemed > 0) {
        logger.success(`SNIPER redeemer: processed ${redeemed} position(s)`);
    }
}
