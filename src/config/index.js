import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Wallet
  privateKey: process.env.PRIVATE_KEY, // EOA private key (for signing only)
  proxyWallet: process.env.PROXY_WALLET_ADDRESS, // Polymarket proxy wallet (deposit USDC here)

  // Polymarket API (optional, auto-derived if empty)
  clobApiKey: process.env.CLOB_API_KEY || '',
  clobApiSecret: process.env.CLOB_API_SECRET || '',
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || '',

  // CLOB signature type
  // 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE
  polySignatureType: Number.parseInt(process.env.POLY_SIGNATURE_TYPE || '1', 10),

  // Polymarket endpoints
  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
  dataHost: 'https://data-api.polymarket.com',
  chainId: 137,

  // Polygon RPC
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
  polygonRpcFallbackUrls: (process.env.POLYGON_RPC_FALLBACK_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),

  // Trader to copy
  traderAddress: process.env.TRADER_ADDRESS,

  // Trade sizing
  sizeMode: process.env.SIZE_MODE || 'percentage', // "percentage" | "balance"
  sizePercent: parseFloat(process.env.SIZE_PERCENT || '50'),
  minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE || '1'),
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '10'),

  // Auto sell
  autoSellEnabled: process.env.AUTO_SELL_ENABLED === 'true',
  autoSellProfitPercent: parseFloat(process.env.AUTO_SELL_PROFIT_PERCENT || '10'),

  // Sell mode when copying sell
  sellMode: process.env.SELL_MODE || 'market', // "market" | "limit"

  // Redeem interval (seconds)
  redeemInterval: parseInt(process.env.REDEEM_INTERVAL || '60', 10) * 1000,

  // Dry run
  dryRun: process.env.DRY_RUN === 'true',

  // Retry settings
  maxRetries: 5,
  retryDelay: 3000,

  // ── Market Maker ──────────────────────────────────────────────
  mmAssets: (process.env.MM_ASSETS || 'btc')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  mmDuration: process.env.MM_DURATION || '5m', // '5m' or '15m'
  mmTradeSize: parseFloat(process.env.MM_TRADE_SIZE || '5'), // USDC per side
  mmSellPrice: parseFloat(process.env.MM_SELL_PRICE || '0.60'), // limit sell target
  mmSplitFallback: process.env.MM_SPLIT_FALLBACK !== 'false', // fallback to CLOB dual-buy if splitPosition fails
  mmCutLossTime: parseInt(process.env.MM_CUT_LOSS_TIME || '60', 10), // seconds before close
  mmMarketKeyword: process.env.MM_MARKET_KEYWORD || 'Bitcoin Up or Down',
  mmEntryWindow: parseInt(process.env.MM_ENTRY_WINDOW || '45', 10), // max secs after open
  mmPollInterval: parseInt(process.env.MM_POLL_INTERVAL || '10', 10) * 1000,

  // ── Recovery Buy (after cut-loss) ─────────────────────────────
  // When enabled: after cutting loss, monitor prices for 10s and
  // market-buy the dominant side if it's above threshold and rising/stable.
  mmRecoveryBuy: process.env.MM_RECOVERY_BUY === 'true',
  mmRecoveryThreshold: parseFloat(process.env.MM_RECOVERY_THRESHOLD || '0.70'), // min price to qualify
  mmRecoverySize: parseFloat(process.env.MM_RECOVERY_SIZE || '0'), // 0 = use mmTradeSize

  // ── Orderbook Sniper ───────────────────────────────────────────
  // Places tiny GTC limit BUY orders at a very low price on each side
  // of ETH/SOL/XRP 5-minute markets — catches panic dumps near $0.
  sniperAssets: (process.env.SNIPER_ASSETS || 'eth,sol,xrp')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  sniperPrice: parseFloat(process.env.SNIPER_PRICE || '0.01'), // $ per share
  sniperShares: parseFloat(process.env.SNIPER_SHARES || '5'), // shares per side
  sniperLateEnabled: process.env.SNIPER_LATE_ENABLED === 'true',
  sniperLateDurations: (process.env.SNIPER_LATE_DURATIONS || '5m,15m')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
  sniperLateCloseWindow: parseInt(process.env.SNIPER_LATE_CLOSE_WINDOW || '30', 10),
  sniperLateMinPrice: parseFloat(process.env.SNIPER_LATE_MIN_PRICE || '0.95'),
  sniperLateMaxPrice: parseFloat(process.env.SNIPER_LATE_MAX_PRICE || '0.99'),
};

// Validation for copy-trade bot
export function validateConfig() {
  const required = ['privateKey', 'proxyWallet', 'traderAddress'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (!['percentage', 'balance'].includes(config.sizeMode)) {
    throw new Error(`Invalid SIZE_MODE: ${config.sizeMode}. Use "percentage" or "balance".`);
  }
  if (!['market', 'limit'].includes(config.sellMode)) {
    throw new Error(`Invalid SELL_MODE: ${config.sellMode}. Use "market" or "limit".`);
  }
}

// Validation for market-maker bot
export function validateMMConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.mmTradeSize <= 0) throw new Error('MM_TRADE_SIZE must be > 0');
  if (config.mmSellPrice <= 0 || config.mmSellPrice >= 1)
    throw new Error('MM_SELL_PRICE must be between 0 and 1');

  if (![0, 1, 2].includes(config.polySignatureType)) {
    throw new Error('POLY_SIGNATURE_TYPE must be one of: 0, 1, 2');
  }

  if (config.sniperPrice <= 0 || config.sniperPrice >= 1) {
    throw new Error('SNIPER_PRICE must be between 0 and 1');
  }

  if (config.sniperShares <= 0) {
    throw new Error('SNIPER_SHARES must be > 0');
  }

  if (config.sniperLateCloseWindow <= 0) {
    throw new Error('SNIPER_LATE_CLOSE_WINDOW must be > 0');
  }

  if (
    config.sniperLateMinPrice <= 0 ||
    config.sniperLateMinPrice >= 1 ||
    config.sniperLateMaxPrice <= 0 ||
    config.sniperLateMaxPrice >= 1 ||
    config.sniperLateMinPrice >= config.sniperLateMaxPrice
  ) {
    throw new Error(
      'SNIPER_LATE_MIN_PRICE and SNIPER_LATE_MAX_PRICE must satisfy 0 < min < max < 1',
    );
  }

  if (config.sniperLateEnabled) {
    const invalidDurations = config.sniperLateDurations.filter(
      (duration) => duration !== '5m' && duration !== '15m',
    );

    if (invalidDurations.length > 0) {
      throw new Error(
        `SNIPER_LATE_DURATIONS contains invalid value(s): ${invalidDurations.join(', ')}`,
      );
    }
  }
}

export default config;
