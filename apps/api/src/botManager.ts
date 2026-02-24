import { EventEmitter } from 'node:events';
import path from 'node:path';

import { ProcessBotController, type ProcessBotControllerEvent } from '@polymarket/engine';
import {
  AlertSchema,
  BotStatusSchema,
  LogEntrySchema,
  StreamEventSchema,
  type Alert,
  type BotId,
  type BotMode,
  type BotStatus,
  type LogEntry,
  type StreamEvent,
} from '@polymarket/shared';

import type { ConfigStore } from './configStore.js';
import type { AuditStore } from './auditStore.js';

const MAX_LOG_HISTORY = 1_000;
const MAX_ALERT_HISTORY = 500;

type BotControllers = Record<BotId, ProcessBotController>;

function buildScriptPath(workspaceRoot: string, bot: BotId): string {
  const fileName = bot === 'copy' ? 'index.js' : `${bot}.js`;
  return path.resolve(workspaceRoot, 'src', fileName);
}

export class BotManager {
  private readonly configStore: ConfigStore;
  private readonly auditStore?: AuditStore;
  private readonly controllers: BotControllers;
  private readonly streamEmitter = new EventEmitter();

  private readonly botModes: Record<BotId, BotMode>;
  private readonly botStatuses: Record<BotId, BotStatus>;
  private readonly logs: LogEntry[] = [];
  private readonly alerts: Alert[] = [];

  constructor(configStore: ConfigStore, workspaceRoot: string, auditStore?: AuditStore) {
    this.configStore = configStore;
    this.auditStore = auditStore;

    this.controllers = {
      copy: new ProcessBotController({
        botId: 'copy',
        scriptPath: buildScriptPath(workspaceRoot, 'copy'),
        cwd: workspaceRoot,
      }),
      mm: new ProcessBotController({
        botId: 'mm',
        scriptPath: buildScriptPath(workspaceRoot, 'mm'),
        cwd: workspaceRoot,
      }),
      sniper: new ProcessBotController({
        botId: 'sniper',
        scriptPath: buildScriptPath(workspaceRoot, 'sniper'),
        cwd: workspaceRoot,
      }),
    };

    this.botModes = {
      copy: this.configStore.resolveMode('copy'),
      mm: this.configStore.resolveMode('mm'),
      sniper: this.configStore.resolveMode('sniper'),
    };

    this.botStatuses = {
      copy: this.createBotStatus('copy', this.controllers.copy.status()),
      mm: this.createBotStatus('mm', this.controllers.mm.status()),
      sniper: this.createBotStatus('sniper', this.controllers.sniper.status()),
    };

    this.bindControllerEvents('copy');
    this.bindControllerEvents('mm');
    this.bindControllerEvents('sniper');
  }

  async start(bot: BotId, explicitMode?: BotMode): Promise<BotStatus> {
    const mode = this.configStore.resolveMode(bot, explicitMode);
    this.assertStartAllowed(bot, mode);
    this.botModes[bot] = mode;
    await this.controllers[bot].start({
      env: this.configStore.toEnv(mode),
    });

    this.auditStore?.log({
      action: 'bot_start',
      source: 'api',
      bot,
      metadata: { mode },
    });

    return this.getBotStatus(bot);
  }

  async stop(bot: BotId): Promise<BotStatus> {
    await this.controllers[bot].stop();

    this.auditStore?.log({
      action: 'bot_stop',
      source: 'api',
      bot,
    });

    return this.getBotStatus(bot);
  }

  async restart(bot: BotId, explicitMode?: BotMode): Promise<BotStatus> {
    const mode = this.configStore.resolveMode(bot, explicitMode);
    this.assertStartAllowed(bot, mode);
    this.botModes[bot] = mode;

    await this.controllers[bot].stop();
    await this.controllers[bot].start({
      env: this.configStore.toEnv(mode),
    });

    this.auditStore?.log({
      action: 'bot_restart',
      source: 'api',
      bot,
      metadata: { mode },
    });

    return this.getBotStatus(bot);
  }

  getBotStatus(bot: BotId): BotStatus {
    const snapshot = this.controllers[bot].status();
    const next = this.createBotStatus(bot, snapshot);
    this.botStatuses[bot] = next;
    return next;
  }

  getAllBotStatuses(): BotStatus[] {
    return [this.getBotStatus('copy'), this.getBotStatus('mm'), this.getBotStatus('sniper')];
  }

  getLogs(limit = 200): LogEntry[] {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LOG_HISTORY));
    return this.logs.slice(-safeLimit);
  }

  getAlerts(limit = 100): Alert[] {
    const safeLimit = Math.max(1, Math.min(limit, MAX_ALERT_HISTORY));
    return this.alerts.slice(-safeLimit);
  }

  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.streamEmitter.on('stream', listener);
    return () => {
      this.streamEmitter.off('stream', listener);
    };
  }

  async stopAll(): Promise<void> {
    await this.controllers.copy.stop();
    await this.controllers.mm.stop();
    await this.controllers.sniper.stop();
  }

  private bindControllerEvents(bot: BotId): void {
    this.controllers[bot].subscribe((event) => {
      this.handleControllerEvent(bot, event);
    });
  }

  private handleControllerEvent(bot: BotId, event: ProcessBotControllerEvent): void {
    if (event.type === 'state') {
      const botStatus = this.createBotStatus(bot, event.status);
      this.botStatuses[bot] = botStatus;

      const streamEvent = StreamEventSchema.parse({
        topic: 'bot_state',
        ts: new Date().toISOString(),
        payload: botStatus,
      });

      this.streamEmitter.emit('stream', streamEvent);

      if (botStatus.state === 'error' && this.configStore.getRuntimeConfig().risk.alertOnError) {
        const alert = AlertSchema.parse({
          id: `${bot}-alert-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          severity: 'critical',
          code: 'BOT_RUNTIME_ERROR',
          message: botStatus.lastError ?? `${bot} transitioned to error state`,
          bot,
          timestamp: new Date().toISOString(),
          acknowledged: false,
        });

        this.alerts.push(alert);
        if (this.alerts.length > MAX_ALERT_HISTORY) {
          this.alerts.splice(0, this.alerts.length - MAX_ALERT_HISTORY);
        }

        this.streamEmitter.emit(
          'stream',
          StreamEventSchema.parse({
            topic: 'alert',
            ts: new Date().toISOString(),
            payload: alert,
          }),
        );
      }

      return;
    }

    const logEntry = LogEntrySchema.parse({
      id: `${bot}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      bot,
      level: event.channel === 'stderr' ? 'error' : 'info',
      message: event.message,
      timestamp: event.timestamp,
    });

    this.logs.push(logEntry);
    if (this.logs.length > MAX_LOG_HISTORY) {
      this.logs.splice(0, this.logs.length - MAX_LOG_HISTORY);
    }

    const streamEvent = StreamEventSchema.parse({
      topic: 'log',
      ts: new Date().toISOString(),
      payload: logEntry,
    });

    this.streamEmitter.emit('stream', streamEvent);
  }

  private createBotStatus(
    bot: BotId,
    status: { state: BotStatus['state']; lastError?: string },
  ): BotStatus {
    return BotStatusSchema.parse({
      bot,
      mode: this.botModes[bot],
      state: status.state,
      updatedAt: new Date().toISOString(),
      lastError: status.lastError ?? null,
    });
  }

  private assertStartAllowed(bot: BotId, mode: BotMode): void {
    const runtimeConfig = this.configStore.getRuntimeConfig();
    const { risk } = runtimeConfig;

    if (risk.killSwitchArmed) {
      throw new Error(`Kill switch is armed. Reset it before starting ${bot} (${mode})`);
    }

    if (bot === 'copy') {
      if (runtimeConfig.copy.minTradeSize > risk.maxOrderSizeUsd) {
        throw new Error('Copy bot blocked by risk guard: MIN_TRADE_SIZE exceeds maxOrderSizeUsd');
      }

      if (runtimeConfig.copy.maxPositionSize > risk.maxExposureUsd) {
        throw new Error('Copy bot blocked by risk guard: MAX_POSITION_SIZE exceeds maxExposureUsd');
      }
    }

    if (bot === 'mm') {
      if (runtimeConfig.mm.tradeSize > risk.maxOrderSizeUsd) {
        throw new Error('MM bot blocked by risk guard: MM_TRADE_SIZE exceeds maxOrderSizeUsd');
      }

      if (runtimeConfig.mm.tradeSize * 2 > risk.maxExposureUsd) {
        throw new Error('MM bot blocked by risk guard: total MM exposure exceeds maxExposureUsd');
      }
    }

    if (bot === 'sniper') {
      const perSideCost = runtimeConfig.sniper.price * runtimeConfig.sniper.shares;
      const perMarketCost = perSideCost * 2;

      if (perSideCost > risk.maxOrderSizeUsd) {
        throw new Error('Sniper bot blocked by risk guard: per-side order exceeds maxOrderSizeUsd');
      }

      if (perMarketCost > risk.maxExposureUsd) {
        throw new Error(
          'Sniper bot blocked by risk guard: per-market exposure exceeds maxExposureUsd',
        );
      }
    }
  }
}
