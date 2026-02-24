import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createApiServer } from './server.js';

const tempDirectories: string[] = [];

function createTempWorkspaceRoot(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'polymarket-api-server-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const current = tempDirectories.pop();
    if (current) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

describe('API server', () => {
  it('supports health/config and kill switch guard flow', async () => {
    const workspaceRoot = createTempWorkspaceRoot();
    const app = await createApiServer({ workspaceRoot });

    try {
      const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(health.statusCode).toBe(200);

      const config = await app.inject({ method: 'GET', url: '/api/v1/config' });
      expect(config.statusCode).toBe(200);

      const killSwitch = await app.inject({
        method: 'POST',
        url: '/api/v1/bots/kill-switch',
        payload: {},
      });
      expect(killSwitch.statusCode).toBe(200);

      const blockedStart = await app.inject({
        method: 'POST',
        url: '/api/v1/bots/copy/start',
        payload: {},
      });
      expect(blockedStart.statusCode).toBe(400);

      const reset = await app.inject({
        method: 'POST',
        url: '/api/v1/bots/kill-switch/reset',
        payload: {},
      });
      expect(reset.statusCode).toBe(200);

      const tightenRisk = await app.inject({
        method: 'PUT',
        url: '/api/v1/config',
        payload: {
          risk: {
            maxOrderSizeUsd: 0.5,
          },
        },
      });
      expect(tightenRisk.statusCode).toBe(200);

      const blockedByRisk = await app.inject({
        method: 'POST',
        url: '/api/v1/bots/copy/start',
        payload: {},
      });
      expect(blockedByRisk.statusCode).toBe(400);

      const audit = await app.inject({ method: 'GET', url: '/api/v1/audit' });
      expect(audit.statusCode).toBe(200);

      const payload = audit.json() as { events: Array<{ action: string }> };
      expect(payload.events.some((event) => event.action === 'kill_switch')).toBe(true);
      expect(payload.events.some((event) => event.action === 'kill_switch_reset')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
