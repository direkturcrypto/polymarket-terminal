import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import config from '../config/index.js';
import logger from '../utils/logger.js';

let clobClient = null;
let signer = null;

/**
 * Initialize the Polymarket CLOB client
 * Auto-derives API credentials if not provided in .env
 */
export async function initClient() {
    logger.info('Initializing Polymarket CLOB client...');

    signer = new Wallet(config.privateKey);
    // Support both ethers v5 and v6: older @polymarket/clob-client expects _signTypedData
    if (typeof signer._signTypedData !== 'function' && typeof signer.signTypedData === 'function') {
        signer._signTypedData = (...args) => signer.signTypedData(...args);
    }
    logger.info(`EOA (signer)  : ${signer.address}`);
    logger.info(`Proxy wallet  : ${config.proxyWallet}`);

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
        const tempClient = new ClobClient(config.clobHost, config.chainId, signer);
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
        2, // Signature type: 2 = POLY_PROXY (EOA signs on behalf of proxy wallet)
        config.proxyWallet, // Funder = proxy wallet (deposit USDC.e here)
    );

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
    const mod = await import('ethers');
    // Support both ethers v5 (namespace export) and v6 (named exports)
    const ethersNS = mod.ethers || mod; // v5: mod.ethers, v6: mod
    const ProviderCtor =
        (ethersNS.providers && ethersNS.providers.JsonRpcProvider) || mod.JsonRpcProvider;
    if (!ProviderCtor) {
        throw new Error('Could not find JsonRpcProvider on ethers module');
    }
    const provider = new ProviderCtor(config.polygonRpcUrl);
    return provider;
}

/**
 * Get USDC.e balance of the proxy wallet on Polygon
 */
export async function getUsdcBalance() {
    const mod = await import('ethers');
    const ethersNS = mod.ethers || mod; // v5: mod.ethers, v6: mod
    const provider = await getPolygonProvider();
    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon
    const abi = ['function balanceOf(address) view returns (uint256)'];
    const ContractCtor = ethersNS.Contract || mod.Contract;
    const formatUnits = (ethersNS.utils && ethersNS.utils.formatUnits) || mod.formatUnits;
    const usdc = new ContractCtor(usdcAddress, abi, provider);
    const balance = await usdc.balanceOf(config.proxyWallet);
    return parseFloat(formatUnits(balance, 6));
}
