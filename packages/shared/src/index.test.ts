import { describe, expect, it } from 'vitest';

import {
  AuditEventSchema,
  ConfigPatchSchema,
  RuntimeConfigSchema,
  StreamEventSchema,
} from './index';

const now = '2026-02-24T12:00:00.000Z';

describe('StreamEventSchema', () => {
  it('accepts a bot_state event', () => {
    const parsed = StreamEventSchema.parse({
      topic: 'bot_state',
      ts: now,
      payload: {
        bot: 'copy',
        mode: 'dry',
        state: 'running',
        updatedAt: now,
      },
    });

    expect(parsed.topic).toBe('bot_state');
    if (parsed.topic !== 'bot_state') {
      throw new Error('Expected bot_state topic');
    }
    expect(parsed.payload.state).toBe('running');
  });

  it('rejects unknown event topics', () => {
    const result = StreamEventSchema.safeParse({
      topic: 'unknown',
      ts: now,
      payload: {},
    });

    expect(result.success).toBe(false);
  });
});

describe('RuntimeConfigSchema', () => {
  it('accepts a full runtime config shape', () => {
    const parsed = RuntimeConfigSchema.parse({
      connection: {
        proxyWallet: '0xproxywallet',
        polygonRpcUrl: 'https://polygon-rpc.com',
      },
      copy: {
        traderAddress: '0xtraderwallet',
        sizeMode: 'balance',
        sizePercent: 10,
        minTradeSize: 1,
        maxPositionSize: 10,
        autoSellEnabled: true,
        autoSellProfitPercent: 10,
        sellMode: 'market',
        redeemIntervalSeconds: 60,
        dryRun: true,
      },
      mm: {
        assets: ['btc'],
        duration: '5m',
        tradeSize: 5,
        sellPrice: 0.6,
        cutLossTimeSeconds: 60,
        marketKeyword: 'Bitcoin Up or Down',
        entryWindowSeconds: 45,
        pollIntervalSeconds: 10,
        recoveryBuyEnabled: false,
        recoveryThreshold: 0.7,
        recoverySize: 0,
        dryRun: true,
      },
      sniper: {
        assets: ['eth', 'sol', 'xrp'],
        price: 0.01,
        shares: 5,
        dryRun: true,
      },
      risk: {
        maxOrderSizeUsd: 25,
        maxExposureUsd: 250,
        killSwitchArmed: false,
        alertOnError: true,
      },
      secrets: {
        hasPrivateKey: true,
        hasClobApiKey: false,
        hasClobApiSecret: false,
        hasClobApiPassphrase: false,
      },
    });

    expect(parsed.mm.duration).toBe('5m');
    expect(parsed.sniper.assets).toHaveLength(3);
  });

  it('supports partial config updates', () => {
    const parsed = ConfigPatchSchema.parse({
      mm: {
        tradeSize: 7.5,
      },
      secrets: {
        privateKey: '0xnewkey',
      },
    });

    expect(parsed.mm?.tradeSize).toBe(7.5);
    expect(parsed.secrets?.privateKey).toBe('0xnewkey');
  });
});

describe('AuditEventSchema', () => {
  it('accepts bot lifecycle actions', () => {
    const parsed = AuditEventSchema.parse({
      id: 'evt-1',
      timestamp: now,
      action: 'bot_restart',
      source: 'api',
      bot: 'sniper',
      metadata: {
        mode: 'dry',
      },
    });

    expect(parsed.action).toBe('bot_restart');
    expect(parsed.bot).toBe('sniper');
  });

  it('accepts kill switch action', () => {
    const parsed = AuditEventSchema.parse({
      id: 'evt-3',
      timestamp: now,
      action: 'kill_switch',
      source: 'api',
    });

    expect(parsed.action).toBe('kill_switch');
  });

  it('accepts kill switch reset action', () => {
    const parsed = AuditEventSchema.parse({
      id: 'evt-4',
      timestamp: now,
      action: 'kill_switch_reset',
      source: 'api',
    });

    expect(parsed.action).toBe('kill_switch_reset');
  });

  it('rejects unknown actions', () => {
    const result = AuditEventSchema.safeParse({
      id: 'evt-2',
      timestamp: now,
      action: 'unknown_action',
      source: 'api',
    });

    expect(result.success).toBe(false);
  });
});
