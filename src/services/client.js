import { AssetType, ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import config from '../config/index.js';
import logger from '../utils/logger.js';

let clobClient = null;
let signer = null;
let orderMakerAddress = null;

function resolveFunderAddress(signatureType, signerAddress, proxyWallet) {
  if (signatureType === 0) {
    return undefined;
  }

  return proxyWallet || signerAddress;
}

function describeClobError(error) {
  const payloadMessage = error?.response?.data?.error || error?.response?.data?.message;
  if (typeof payloadMessage === 'string' && payloadMessage.trim().length > 0) {
    return payloadMessage;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'unknown error';
}

function isPositiveAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function signatureTypeName(signatureType) {
  if (signatureType === 0) return 'EOA';
  if (signatureType === 1) return 'POLY_PROXY';
  if (signatureType === 2) return 'POLY_GNOSIS_SAFE';
  return 'UNKNOWN';
}

function formatUsdcValue(value) {
  if (value === undefined || value === null) {
    return 'n/a';
  }

  const raw = String(value).trim();
  if (!raw) {
    return '0';
  }

  if (!/^-?\d+$/.test(raw)) {
    return raw;
  }

  try {
    const negative = raw.startsWith('-');
    const unsigned = BigInt(negative ? raw.slice(1) : raw);
    const unit = 1_000_000n;
    const whole = unsigned / unit;
    const fractional = unsigned % unit;
    const fractionalText = fractional.toString().padStart(6, '0').replace(/0+$/, '');
    const formatted =
      fractionalText.length > 0 ? `${whole.toString()}.${fractionalText}` : whole.toString();
    return negative ? `-${formatted}` : formatted;
  } catch {
    return raw;
  }
}

function buildCollateralSnapshot(raw) {
  return {
    balanceRaw: raw.balance,
    allowanceRaw: raw.allowance,
    balanceFormatted: formatUsdcValue(raw.balance),
    allowanceFormatted: formatUsdcValue(raw.allowance),
  };
}

/**
 * Initialize the Polymarket CLOB client
 * Auto-derives API credentials if not provided in .env
 */
export async function initClient() {
  logger.info('Initializing Polymarket CLOB client...');

  signer = new Wallet(config.privateKey);
  logger.info(`EOA (signer)  : ${signer.address}`);
  logger.info(`Proxy wallet  : ${config.proxyWallet}`);
  logger.info(
    `Signature type: ${config.polySignatureType} (${signatureTypeName(config.polySignatureType)})`,
  );

  const funderAddress = resolveFunderAddress(
    config.polySignatureType,
    signer.address,
    config.proxyWallet,
  );
  orderMakerAddress = funderAddress ?? signer.address;
  const useServerTime = true;

  if (
    config.polySignatureType === 0 &&
    config.proxyWallet &&
    config.proxyWallet.toLowerCase() !== signer.address.toLowerCase()
  ) {
    logger.warn('Signature type 0 uses signer wallet as maker; proxy wallet is ignored');
  }

  logger.info(`Order maker    : ${orderMakerAddress}`);

  if (config.polySignatureType !== 0 && !funderAddress) {
    throw new Error('Proxy/funder wallet is required for non-EOA signature types');
  }

  // Step 1: Create temp client to derive API credentials
  let apiCreds;
  if (config.clobApiKey && config.clobApiSecret && config.clobApiPassphrase) {
    apiCreds = {
      key: config.clobApiKey,
      secret: config.clobApiSecret,
      passphrase: config.clobApiPassphrase,
    };
    logger.info('Using API credentials from .env');
  } else {
    const tempClient = new ClobClient(
      config.clobHost,
      config.chainId,
      signer,
      undefined,
      config.polySignatureType,
      funderAddress,
      undefined,
      useServerTime,
    );
    apiCreds = await tempClient.createOrDeriveApiKey();
    logger.info('API credentials derived successfully');
  }

  // Step 2: Initialize full trading client
  // proxyWallet = funder address (where USDC.e is held)
  clobClient = new ClobClient(
    config.clobHost,
    config.chainId,
    signer,
    apiCreds,
    config.polySignatureType,
    funderAddress,
    undefined,
    useServerTime,
  );

  try {
    await clobClient.getApiKeys();
    logger.success('CLOB auth preflight passed');
  } catch (error) {
    throw new Error(
      `CLOB auth preflight failed: ${describeClobError(error)}. Check POLY_SIGNATURE_TYPE and wallet pairing.`,
    );
  }

  try {
    let collateral = await clobClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    if (isPositiveAmount(collateral.balance) && !isPositiveAmount(collateral.allowance)) {
      logger.warn('USDC allowance is zero — attempting collateral allowance update');
      await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      logger.success('USDC collateral allowance update submitted');
      collateral = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    }

    const snapshot = buildCollateralSnapshot(collateral);
    logger.info(
      `CLOB collateral status: wallet=${orderMakerAddress} balance=${snapshot.balanceFormatted} USDC allowance=${snapshot.allowanceFormatted} USDC`,
    );
  } catch (error) {
    logger.warn(`Could not verify/update collateral allowance: ${describeClobError(error)}`);
  }

  logger.success('CLOB client initialized');
  return clobClient;
}

/**
 * Get the initialized CLOB client
 */
export function getClient() {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClient() first.');
  }
  return clobClient;
}

export function getTradingContext() {
  return {
    signerAddress: signer?.address ?? null,
    proxyWallet: config.proxyWallet ?? null,
    signatureType: config.polySignatureType,
    orderMakerAddress: orderMakerAddress ?? null,
  };
}

export async function getCollateralStatus() {
  if (!clobClient) {
    return null;
  }

  const collateral = await clobClient.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL,
  });

  return buildCollateralSnapshot(collateral);
}

/**
 * Get the signer wallet
 */
export function getSigner() {
  if (!signer) {
    throw new Error('Signer not initialized. Call initClient() first.');
  }
  return signer;
}

/**
 * Get a working Polygon provider using RPC from config
 */
export async function getPolygonProvider() {
  const { ethers } = await import('ethers');
  const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
  return provider;
}

/**
 * Get USDC.e balance of the proxy wallet on Polygon
 */
export async function getUsdcBalance() {
  const { ethers } = await import('ethers');
  const provider = await getPolygonProvider();
  const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon
  const abi = ['function balanceOf(address) view returns (uint256)'];
  const usdc = new ethers.Contract(usdcAddress, abi, provider);
  const walletAddress =
    resolveFunderAddress(config.polySignatureType, signer?.address, config.proxyWallet) ??
    signer?.address ??
    config.proxyWallet;

  if (!walletAddress) {
    throw new Error('No wallet configured for USDC balance check');
  }

  const balance = await usdc.balanceOf(walletAddress);
  return parseFloat(ethers.utils.formatUnits(balance, 6));
}
