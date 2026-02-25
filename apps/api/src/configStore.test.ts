import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { atomicWriteJson } from './fileStore.js';
import { ConfigStore } from './configStore.js';

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'polymarket-api-config-'));
  tempDirectories.push(tempDirectory);
  return tempDirectory;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const current = tempDirectories.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe('ConfigStore persistence', () => {
  it('persists runtime config and secret values to disk', () => {
    const dataDir = createTempDirectory();

    const initialStore = new ConfigStore({
      dataDir,
      env: {
        ...process.env,
        POLYGON_RPC_URL: 'https://polygon-rpc.com',
      },
    });

    initialStore.updateRuntimeConfig({
      connection: {
        proxyWallet: '0xpersisted',
      },
      mm: {
        tradeSize: 12.5,
      },
      risk: {
        killSwitchArmed: true,
      },
      secrets: {
        privateKey: '0x-super-secret-private-key',
      },
    });

    const reloadedStore = new ConfigStore({
      dataDir,
      env: {
        ...process.env,
        POLYGON_RPC_URL: 'https://polygon-rpc.com',
      },
    });

    const runtimeConfig = reloadedStore.getRuntimeConfig();

    expect(runtimeConfig.connection.proxyWallet).toBe('0xpersisted');
    expect(runtimeConfig.mm.tradeSize).toBe(12.5);
    expect(runtimeConfig.risk.killSwitchArmed).toBe(true);
    expect(runtimeConfig.secrets.hasPrivateKey).toBe(true);
    expect(reloadedStore.toEnv('live').PRIVATE_KEY).toBe('0x-super-secret-private-key');
  });

  it('never exposes secret values in runtime config responses', () => {
    const dataDir = createTempDirectory();
    const store = new ConfigStore({
      dataDir,
      env: {
        ...process.env,
        POLYGON_RPC_URL: 'https://polygon-rpc.com',
      },
    });

    store.updateRuntimeConfig({
      secrets: {
        clobApiSecret: 'top-secret',
      },
    });

    const runtimeConfig = store.getRuntimeConfig() as Record<string, unknown>;
    const secrets = runtimeConfig.secrets as Record<string, unknown>;

    expect(secrets.hasClobApiSecret).toBe(true);
    expect(secrets).not.toHaveProperty('clobApiSecret');
  });

  it('validates required bot start inputs before launch', () => {
    const dataDir = createTempDirectory();
    const store = new ConfigStore({
      dataDir,
      env: {
        ...process.env,
        POLYGON_RPC_URL: 'https://polygon-rpc.com',
        PRIVATE_KEY: '',
        PROXY_WALLET_ADDRESS: '',
      },
    });

    expect(() => store.validateBotStart('mm')).toThrow('Cannot start mm');

    store.updateRuntimeConfig({
      connection: {
        proxyWallet: '0xproxy',
      },
      secrets: {
        privateKey: '0xprivatekey',
      },
    });

    expect(() => store.validateBotStart('mm')).not.toThrow();
  });

  it('falls back to .env values when persisted values are blank', () => {
    const dataDir = createTempDirectory();

    atomicWriteJson(path.resolve(dataDir, 'runtime-config.json'), {
      connection: {
        proxyWallet: '',
        polygonRpcUrl: 'https://polygon-rpc.com',
      },
      copy: {
        traderAddress: '',
      },
    });

    atomicWriteJson(path.resolve(dataDir, 'runtime-secrets.json'), {
      privateKey: '',
    });

    const store = new ConfigStore({
      dataDir,
      env: {
        ...process.env,
        PRIVATE_KEY: '0xfromenv',
        PROXY_WALLET_ADDRESS: '0xproxyfromenv',
        TRADER_ADDRESS: '0xtraderfromenv',
        POLYGON_RPC_URL: 'https://polygon-rpc.com',
      },
    });

    const config = store.getRuntimeConfig();
    expect(config.connection.proxyWallet).toBe('0xproxyfromenv');
    expect(config.copy.traderAddress).toBe('0xtraderfromenv');
    expect(store.toEnv('dry').PRIVATE_KEY).toBe('0xfromenv');
  });
});
