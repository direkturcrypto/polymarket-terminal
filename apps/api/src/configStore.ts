import {
  ConfigPatchSchema,
  RuntimeConfigSchema,
  type BotId,
  type BotMode,
  type ConfigPatch,
  type RuntimeConfig,
} from '@polymarket/shared';
import path from 'node:path';

import { atomicWriteJson, ensureDirectory, readJsonFile } from './fileStore.js';

interface SecretValues {
  privateKey?: string;
  clobApiKey?: string;
  clobApiSecret?: string;
  clobApiPassphrase?: string;
}

interface ConfigStoreOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
}

interface PersistedConfig {
  connection: RuntimeConfig['connection'];
  copy: RuntimeConfig['copy'];
  mm: RuntimeConfig['mm'];
  sniper: RuntimeConfig['sniper'];
  risk: RuntimeConfig['risk'];
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return raw === 'true';
}

function parseAssetList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) {
    return fallback;
  }

  return raw
    .split(',')
    .map((asset) => asset.trim().toLowerCase())
    .filter(Boolean);
}

function cloneRuntimeConfig(value: RuntimeConfig): RuntimeConfig {
  return {
    connection: { ...value.connection },
    copy: { ...value.copy },
    mm: { ...value.mm, assets: [...value.mm.assets] },
    sniper: { ...value.sniper, assets: [...value.sniper.assets] },
    risk: { ...value.risk },
    secrets: { ...value.secrets },
  };
}

export class ConfigStore {
  private runtimeConfig: RuntimeConfig;
  private secrets: SecretValues;
  private readonly configFilePath: string;
  private readonly secretsFilePath: string;

  constructor(options: ConfigStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dataDir = options.dataDir ?? path.resolve(process.cwd(), 'data', 'api');

    ensureDirectory(dataDir);
    this.configFilePath = path.resolve(dataDir, 'runtime-config.json');
    this.secretsFilePath = path.resolve(dataDir, 'runtime-secrets.json');

    const persistedSecrets = readJsonFile<SecretValues>(this.secretsFilePath);

    this.secrets = {
      privateKey: persistedSecrets?.privateKey ?? env.PRIVATE_KEY,
      clobApiKey: persistedSecrets?.clobApiKey ?? env.CLOB_API_KEY,
      clobApiSecret: persistedSecrets?.clobApiSecret ?? env.CLOB_API_SECRET,
      clobApiPassphrase: persistedSecrets?.clobApiPassphrase ?? env.CLOB_API_PASSPHRASE,
    };

    const defaults = RuntimeConfigSchema.parse({
      connection: {
        proxyWallet: env.PROXY_WALLET_ADDRESS ?? '',
        polygonRpcUrl: env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com',
      },
      copy: {
        traderAddress: env.TRADER_ADDRESS ?? '',
        sizeMode: env.SIZE_MODE === 'balance' ? 'balance' : 'percentage',
        sizePercent: parseNumber(env.SIZE_PERCENT, 50),
        minTradeSize: parseNumber(env.MIN_TRADE_SIZE, 1),
        maxPositionSize: parseNumber(env.MAX_POSITION_SIZE, 10),
        autoSellEnabled: parseBoolean(env.AUTO_SELL_ENABLED, false),
        autoSellProfitPercent: parseNumber(env.AUTO_SELL_PROFIT_PERCENT, 10),
        sellMode: env.SELL_MODE === 'limit' ? 'limit' : 'market',
        redeemIntervalSeconds: parseInteger(env.REDEEM_INTERVAL, 60),
        dryRun: parseBoolean(env.DRY_RUN, false),
      },
      mm: {
        assets: parseAssetList(env.MM_ASSETS, ['btc']),
        duration: env.MM_DURATION === '15m' ? '15m' : '5m',
        tradeSize: parseNumber(env.MM_TRADE_SIZE, 5),
        sellPrice: parseNumber(env.MM_SELL_PRICE, 0.6),
        cutLossTimeSeconds: parseInteger(env.MM_CUT_LOSS_TIME, 60),
        marketKeyword: env.MM_MARKET_KEYWORD ?? 'Bitcoin Up or Down',
        entryWindowSeconds: parseInteger(env.MM_ENTRY_WINDOW, 45),
        pollIntervalSeconds: parseInteger(env.MM_POLL_INTERVAL, 10),
        recoveryBuyEnabled: parseBoolean(env.MM_RECOVERY_BUY, false),
        recoveryThreshold: parseNumber(env.MM_RECOVERY_THRESHOLD, 0.7),
        recoverySize: parseNumber(env.MM_RECOVERY_SIZE, 0),
        dryRun: parseBoolean(env.DRY_RUN, false),
      },
      sniper: {
        assets: parseAssetList(env.SNIPER_ASSETS, ['eth', 'sol', 'xrp']),
        price: parseNumber(env.SNIPER_PRICE, 0.01),
        shares: parseNumber(env.SNIPER_SHARES, 5),
        dryRun: parseBoolean(env.DRY_RUN, false),
      },
      risk: {
        maxOrderSizeUsd: parseNumber(env.RISK_MAX_ORDER_SIZE_USD, 50),
        maxExposureUsd: parseNumber(env.RISK_MAX_EXPOSURE_USD, 500),
        killSwitchArmed: parseBoolean(env.RISK_KILL_SWITCH_ARMED, false),
        alertOnError: parseBoolean(env.RISK_ALERT_ON_ERROR, true),
      },
      secrets: {
        hasPrivateKey: Boolean(this.secrets.privateKey),
        hasClobApiKey: Boolean(this.secrets.clobApiKey),
        hasClobApiSecret: Boolean(this.secrets.clobApiSecret),
        hasClobApiPassphrase: Boolean(this.secrets.clobApiPassphrase),
      },
    });

    const persistedConfig = readJsonFile<PersistedConfig>(this.configFilePath);

    this.runtimeConfig = RuntimeConfigSchema.parse({
      ...defaults,
      connection: persistedConfig?.connection ?? defaults.connection,
      copy: persistedConfig?.copy ?? defaults.copy,
      mm: persistedConfig?.mm ?? defaults.mm,
      sniper: persistedConfig?.sniper ?? defaults.sniper,
      risk: persistedConfig?.risk ?? defaults.risk,
      secrets: {
        hasPrivateKey: Boolean(this.secrets.privateKey),
        hasClobApiKey: Boolean(this.secrets.clobApiKey),
        hasClobApiSecret: Boolean(this.secrets.clobApiSecret),
        hasClobApiPassphrase: Boolean(this.secrets.clobApiPassphrase),
      },
    });

    this.persist();
  }

  getRuntimeConfig(): RuntimeConfig {
    return cloneRuntimeConfig(this.runtimeConfig);
  }

  updateRuntimeConfig(input: unknown): RuntimeConfig {
    const patch = ConfigPatchSchema.parse(input);

    const merged = RuntimeConfigSchema.parse({
      ...this.runtimeConfig,
      connection: {
        ...this.runtimeConfig.connection,
        ...(patch.connection ?? {}),
      },
      copy: {
        ...this.runtimeConfig.copy,
        ...(patch.copy ?? {}),
      },
      mm: {
        ...this.runtimeConfig.mm,
        ...(patch.mm ?? {}),
      },
      sniper: {
        ...this.runtimeConfig.sniper,
        ...(patch.sniper ?? {}),
      },
      risk: {
        ...this.runtimeConfig.risk,
        ...(patch.risk ?? {}),
      },
      secrets: {
        ...this.runtimeConfig.secrets,
      },
    });

    this.applySecretsPatch(patch);

    merged.secrets = {
      hasPrivateKey: Boolean(this.secrets.privateKey),
      hasClobApiKey: Boolean(this.secrets.clobApiKey),
      hasClobApiSecret: Boolean(this.secrets.clobApiSecret),
      hasClobApiPassphrase: Boolean(this.secrets.clobApiPassphrase),
    };

    this.runtimeConfig = merged;
    this.persist();
    return this.getRuntimeConfig();
  }

  resolveMode(bot: BotId, explicitMode?: BotMode): BotMode {
    if (explicitMode) {
      return explicitMode;
    }

    const isDry =
      bot === 'copy'
        ? this.runtimeConfig.copy.dryRun
        : bot === 'mm'
          ? this.runtimeConfig.mm.dryRun
          : this.runtimeConfig.sniper.dryRun;

    return isDry ? 'dry' : 'live';
  }

  toEnv(mode: BotMode): NodeJS.ProcessEnv {
    const copy = this.runtimeConfig.copy;
    const mm = this.runtimeConfig.mm;
    const sniper = this.runtimeConfig.sniper;

    return {
      ...process.env,
      PRIVATE_KEY: this.secrets.privateKey ?? '',
      PROXY_WALLET_ADDRESS: this.runtimeConfig.connection.proxyWallet,
      POLYGON_RPC_URL: this.runtimeConfig.connection.polygonRpcUrl,
      CLOB_API_KEY: this.secrets.clobApiKey ?? '',
      CLOB_API_SECRET: this.secrets.clobApiSecret ?? '',
      CLOB_API_PASSPHRASE: this.secrets.clobApiPassphrase ?? '',
      TRADER_ADDRESS: copy.traderAddress,
      SIZE_MODE: copy.sizeMode,
      SIZE_PERCENT: String(copy.sizePercent),
      MIN_TRADE_SIZE: String(copy.minTradeSize),
      MAX_POSITION_SIZE: String(copy.maxPositionSize),
      AUTO_SELL_ENABLED: String(copy.autoSellEnabled),
      AUTO_SELL_PROFIT_PERCENT: String(copy.autoSellProfitPercent),
      SELL_MODE: copy.sellMode,
      REDEEM_INTERVAL: String(copy.redeemIntervalSeconds),
      MM_ASSETS: mm.assets.join(','),
      MM_DURATION: mm.duration,
      MM_TRADE_SIZE: String(mm.tradeSize),
      MM_SELL_PRICE: String(mm.sellPrice),
      MM_CUT_LOSS_TIME: String(mm.cutLossTimeSeconds),
      MM_MARKET_KEYWORD: mm.marketKeyword,
      MM_ENTRY_WINDOW: String(mm.entryWindowSeconds),
      MM_POLL_INTERVAL: String(mm.pollIntervalSeconds),
      MM_RECOVERY_BUY: String(mm.recoveryBuyEnabled),
      MM_RECOVERY_THRESHOLD: String(mm.recoveryThreshold),
      MM_RECOVERY_SIZE: String(mm.recoverySize),
      SNIPER_ASSETS: sniper.assets.join(','),
      SNIPER_PRICE: String(sniper.price),
      SNIPER_SHARES: String(sniper.shares),
      RISK_MAX_ORDER_SIZE_USD: String(this.runtimeConfig.risk.maxOrderSizeUsd),
      RISK_MAX_EXPOSURE_USD: String(this.runtimeConfig.risk.maxExposureUsd),
      RISK_KILL_SWITCH_ARMED: String(this.runtimeConfig.risk.killSwitchArmed),
      RISK_ALERT_ON_ERROR: String(this.runtimeConfig.risk.alertOnError),
      DRY_RUN: mode === 'dry' ? 'true' : 'false',
    };
  }

  private applySecretsPatch(patch: ConfigPatch): void {
    if (!patch.secrets) {
      return;
    }

    if (patch.secrets.privateKey !== undefined) {
      this.secrets.privateKey = patch.secrets.privateKey;
    }
    if (patch.secrets.clobApiKey !== undefined) {
      this.secrets.clobApiKey = patch.secrets.clobApiKey;
    }
    if (patch.secrets.clobApiSecret !== undefined) {
      this.secrets.clobApiSecret = patch.secrets.clobApiSecret;
    }
    if (patch.secrets.clobApiPassphrase !== undefined) {
      this.secrets.clobApiPassphrase = patch.secrets.clobApiPassphrase;
    }
  }

  private persist(): void {
    const configForFile: PersistedConfig = {
      connection: { ...this.runtimeConfig.connection },
      copy: { ...this.runtimeConfig.copy },
      mm: { ...this.runtimeConfig.mm, assets: [...this.runtimeConfig.mm.assets] },
      sniper: { ...this.runtimeConfig.sniper, assets: [...this.runtimeConfig.sniper.assets] },
      risk: { ...this.runtimeConfig.risk },
    };

    atomicWriteJson(this.configFilePath, configForFile);
    atomicWriteJson(this.secretsFilePath, this.secrets);
  }
}
