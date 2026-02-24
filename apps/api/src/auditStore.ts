import {
  AuditEventSchema,
  type AuditAction,
  type AuditEvent,
  type BotId,
} from '@polymarket/shared';
import path from 'node:path';

import { atomicWriteJson, ensureDirectory, readJsonFile } from './fileStore.js';

const MAX_AUDIT_HISTORY = 10_000;

interface AuditStoreOptions {
  dataDir: string;
}

interface CreateAuditEventInput {
  action: AuditAction;
  source: string;
  bot?: BotId;
  metadata?: Record<string, unknown>;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, MAX_AUDIT_HISTORY));
}

export class AuditStore {
  private readonly auditFilePath: string;
  private readonly events: AuditEvent[];

  constructor(options: AuditStoreOptions) {
    ensureDirectory(options.dataDir);
    this.auditFilePath = path.resolve(options.dataDir, 'audit-events.json');

    const persisted = readJsonFile<unknown[]>(this.auditFilePath) ?? [];
    this.events = persisted.map((value) => AuditEventSchema.parse(value));
  }

  log(input: CreateAuditEventInput): AuditEvent {
    const event = AuditEventSchema.parse({
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      action: input.action,
      source: input.source,
      bot: input.bot,
      metadata: input.metadata,
    });

    this.events.push(event);

    if (this.events.length > MAX_AUDIT_HISTORY) {
      this.events.splice(0, this.events.length - MAX_AUDIT_HISTORY);
    }

    atomicWriteJson(this.auditFilePath, this.events);
    return event;
  }

  getRecent(limit = 200): AuditEvent[] {
    const safeLimit = clampLimit(limit);
    return this.events.slice(-safeLimit);
  }
}
