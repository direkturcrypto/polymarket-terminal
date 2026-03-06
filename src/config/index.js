import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Wallet
  privateKey: process.env.PRIVATE_KEY,         // EOA private key (for signing only)
  proxyWallet: process.env.PROXY_WALLET_ADDRESS, // Polymarket proxy wallet (deposit USDC here)

  // Polymarket API (optional, auto-derived if empty)
  clobApiKey: process.env.CLOB_API_KEY || '',
  clobApiSecret: process.env.CLOB_API_SECRET || '',
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || '',

  // Polymarket endpoints
  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
  dataHost: 'https://data-api.polymarket.com',
  chainId: 137,

  // Polygon RPC
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',

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

  // Skip buy if market closes within this many seconds (default 5 minutes)
  minMarketTimeLeft: parseInt(process.env.MIN_MARKET_TIME_LEFT || '300', 10),

  // Seconds to wait for a GTC limit order to fill when FAK finds no liquidity
  // (happens when copying trades into "next market" before sellers arrive)
  gtcFallbackTimeout: parseInt(process.env.GTC_FALLBACK_TIMEOUT || '60', 10),

  // ── Market Maker ──────────────────────────────────────────────
  mmAssets: (process.env.MM_ASSETS || 'btc')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  mmDuration: process.env.MM_DURATION || '5m',  // '5m' or '15m'
  mmTradeSize: parseFloat(process.env.MM_TRADE_SIZE || '5'),    // USDC per side
  mmSellPrice: parseFloat(process.env.MM_SELL_PRICE || '0.60'), // limit sell target
  mmCutLossTime: parseInt(process.env.MM_CUT_LOSS_TIME || '60', 10), // seconds before close
  mmMarketKeyword: process.env.MM_MARKET_KEYWORD || 'Bitcoin Up or Down',
  mmEntryWindow: parseInt(process.env.MM_ENTRY_WINDOW || '45', 10), // max secs after open
  mmPollInterval: parseInt(process.env.MM_POLL_INTERVAL || '10', 10) * 1000,
  mmAdaptiveCL: process.env.MM_ADAPTIVE_CL !== 'false',           // true = adaptive, false = legacy immediate market-sell
  mmAdaptiveMinCombined: parseFloat(process.env.MM_ADAPTIVE_MIN_COMBINED || '1.20'), // min combined sell (both legs) to qualify for limit
  mmAdaptiveMonitorSec: parseInt(process.env.MM_ADAPTIVE_MONITOR_SEC || '5', 10),

  // ── Recovery Buy (after cut-loss) ─────────────────────────────
  // When enabled: after cutting loss, monitor prices for 10s and
  // market-buy the dominant side if it's above threshold and rising/stable.
  mmRecoveryBuy: process.env.MM_RECOVERY_BUY === 'true',
  mmRecoveryThreshold: parseFloat(process.env.MM_RECOVERY_THRESHOLD || '0.70'), // min price to qualify
  mmRecoverySize: parseFloat(process.env.MM_RECOVERY_SIZE || '0'),    // 0 = use mmTradeSize

  // ── Orderbook Sniper ───────────────────────────────────────────
  // 3-tier strategy: places GTC limit BUY orders at 3c, 2c, and 1c
  // Tier 1 (3c): smallest size | Tier 2 (2c): medium size | Tier 3 (1c): largest size
  // Min 5 shares per tier, total = SNIPER_MAX_SHARES_PER_SIDE
  sniperAssets: (process.env.SNIPER_ASSETS || 'eth,sol,xrp')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  sniperTierPrices: [
    parseFloat(process.env.SNIPER_TIER1_PRICE || '0.03'), // high price, small size
    parseFloat(process.env.SNIPER_TIER2_PRICE || '0.02'), // mid price, medium size
    parseFloat(process.env.SNIPER_TIER3_PRICE || '0.01'), // low price, large size
  ],
  sniperMaxShares: parseFloat(process.env.SNIPER_MAX_SHARES || '15'), // max total per side
  sniperMinSharesPerTier: 5, // minimum shares for each tier

  // ── Sniper Schedule (UTC+8) ────────────────────────────────────
  // Per-asset session windows. Format: SNIPER_SCHEDULE_{ASSET}=HH:MM-HH:MM,HH:MM-HH:MM
  // Assets without a schedule are always active.
  sniperSchedule: (() => {
    const schedule = {};
    const prefix = 'SNIPER_SCHEDULE_';
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix) && value) {
        const asset = key.slice(prefix.length).toLowerCase();
        schedule[asset] = value;
      }
    }
    return schedule;
  })(),

  // ── Market Maker v2 (Buy Low, Sell High) ──────────────────────
  // Places limit BUY on UP+DOWN at low price, sells at higher price when filled.
  // No splitPosition — pure orderbook strategy.
  makerAssets: (process.env.MAKER_ASSETS || 'btc')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  makerDurations: (process.env.MAKER_DURATION || '5m')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  makerBuyPrice: parseFloat(process.env.MAKER_BUY_PRICE || '0.02'),
  makerSellPrice: parseFloat(process.env.MAKER_SELL_PRICE || '0.03'),
  makerTradeSize: parseFloat(process.env.MAKER_TRADE_SIZE || '50'),    // shares per side
  makerSimBalance: parseFloat(process.env.MAKER_SIM_BALANCE || '50'), // starting sim balance
  makerPollInterval: parseInt(process.env.MAKER_POLL_INTERVAL || '10', 10) * 1000,
  makerMonitorMs: parseInt(process.env.MAKER_MONITOR_MS || '2000', 10), // how fast to poll order status

  // ── Proxy (Polymarket API only, NOT Polygon RPC) ──────────────
  // Supports HTTP/HTTPS. Example: http://user:pass@host:port
  proxyUrl: process.env.PROXY_URL || '',
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
}

// Validation for maker bot (buy low, sell high)
export function validateMakerConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.makerBuyPrice <= 0 || config.makerBuyPrice >= 1)
    throw new Error('MAKER_BUY_PRICE must be between 0 and 1');
  if (config.makerSellPrice <= config.makerBuyPrice)
    throw new Error('MAKER_SELL_PRICE must be greater than MAKER_BUY_PRICE');
  if (config.makerTradeSize < 5)
    throw new Error('MAKER_TRADE_SIZE must be >= 5 (Polymarket minimum order size)');
}

export default config;
