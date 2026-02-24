import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditStore } from './auditStore.js';

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'polymarket-api-audit-'));
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

describe('AuditStore', () => {
  it('persists and reloads audit events', () => {
    const dataDir = createTempDirectory();
    const first = new AuditStore({ dataDir });

    first.log({ action: 'config_updated', source: 'api' });
    first.log({ action: 'bot_start', source: 'api', bot: 'copy' });
    first.log({ action: 'bot_stop', source: 'api', bot: 'copy' });

    const second = new AuditStore({ dataDir });
    const events = second.getRecent(2);

    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe('bot_start');
    expect(events[1]?.action).toBe('bot_stop');
  });
});
