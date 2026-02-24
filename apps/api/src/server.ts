import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import path from 'node:path';
import { z } from 'zod';

import {
  ApiErrorSchema,
  AuditEventSchema,
  BotIdSchema,
  BotModeSchema,
  HealthResponseSchema,
  LogEntrySchema,
  StreamEventSchema,
  type BotId,
  type BotMode,
  type Order,
  type Position,
  type Trade,
} from '@polymarket/shared';

import { BotManager } from './botManager.js';
import { AuditStore } from './auditStore.js';
import { ConfigStore } from './configStore.js';

interface CreateApiServerOptions {
  workspaceRoot: string;
}

const StartStopBodySchema = z
  .object({
    mode: BotModeSchema.optional(),
  })
  .partial();

const LogsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const AlertsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const WS_OPEN = 1;

interface TrackedSocket {
  readyState: number;
  isAlive?: boolean;
  send(data: string): void;
  on(event: 'pong' | 'close', listener: () => void): void;
  ping(): void;
  terminate(): void;
  close(): void;
}

interface BotParam {
  bot?: string;
}

interface StartStopBody {
  mode?: BotMode;
}

interface LogsQuery {
  limit?: number;
}

interface AuditQuery {
  limit?: number;
}

interface AlertsQuery {
  limit?: number;
}

interface LocalTokenHeader {
  'x-local-token'?: string | string[];
}

function normalizeTokenHeader(header: LocalTokenHeader['x-local-token']): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}

function isTrackedSocket(value: unknown): value is TrackedSocket {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<TrackedSocket>;
  return (
    typeof candidate.readyState === 'number' &&
    typeof candidate.send === 'function' &&
    typeof candidate.on === 'function' &&
    typeof candidate.ping === 'function' &&
    typeof candidate.terminate === 'function' &&
    typeof candidate.close === 'function'
  );
}

function asTrackedSocket(value: unknown): TrackedSocket {
  if (isTrackedSocket(value)) {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'socket' in value &&
    isTrackedSocket((value as { socket: unknown }).socket)
  ) {
    return (value as { socket: TrackedSocket }).socket;
  }

  throw new Error('Invalid websocket connection shape');
}

function sendError(reply: FastifyReply, code: number, errorCode: string, message: string): void {
  const payload = ApiErrorSchema.parse({
    code: errorCode,
    message,
  });
  reply.code(code).send(payload);
}

function parseBotId(raw: unknown): BotId {
  return BotIdSchema.parse(raw);
}

function parseStartStopBody(raw: unknown): StartStopBody {
  return StartStopBodySchema.parse(raw ?? {});
}

function parseLogsQuery(raw: unknown): LogsQuery {
  return LogsQuerySchema.parse(raw ?? {});
}

function parseAuditQuery(raw: unknown): AuditQuery {
  return AuditQuerySchema.parse(raw ?? {});
}

function parseAlertsQuery(raw: unknown): AlertsQuery {
  return AlertsQuerySchema.parse(raw ?? {});
}

function sendErrorAndReturn(
  reply: FastifyReply,
  code: number,
  errorCode: string,
  message: string,
): FastifyReply {
  sendError(reply, code, errorCode, message);
  return reply;
}

function getRouteErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function parseBotParam(params: unknown): BotId {
  return parseBotId((params as BotParam).bot);
}

function parseLocalToken(headers: unknown): string | undefined {
  const tokenHeader = (headers as LocalTokenHeader)['x-local-token'];
  return normalizeTokenHeader(tokenHeader);
}

function isSocketOpen(socket: TrackedSocket): boolean {
  return socket.readyState === WS_OPEN;
}

function broadcastToSocket(socket: TrackedSocket, payload: string): void {
  if (!isSocketOpen(socket)) {
    return;
  }

  socket.send(payload);
}

function sendBotStateSnapshot(socket: TrackedSocket, botManager: BotManager): void {
  for (const status of botManager.getAllBotStatuses()) {
    const payload = JSON.stringify(
      StreamEventSchema.parse({
        topic: 'bot_state',
        ts: new Date().toISOString(),
        payload: status,
      }),
    );
    broadcastToSocket(socket, payload);
  }
}

function pruneDeadSocket(socketClients: Set<TrackedSocket>, socket: TrackedSocket): void {
  socketClients.delete(socket);
  socket.terminate();
}

function setupSocketHeartbeat(socketClients: Set<TrackedSocket>): NodeJS.Timeout {
  return setInterval(() => {
    for (const socket of socketClients) {
      if (socket.isAlive === false) {
        pruneDeadSocket(socketClients, socket);
        continue;
      }

      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
}

function closeSocketClients(socketClients: Set<TrackedSocket>): void {
  for (const socket of socketClients) {
    socket.close();
  }
  socketClients.clear();
}

function handleSocketConnection(socket: TrackedSocket, socketClients: Set<TrackedSocket>): void {
  socket.isAlive = true;
  socketClients.add(socket);

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('close', () => {
    socketClients.delete(socket);
  });
}

export async function createApiServer(options: CreateApiServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  const dataDirectory = path.resolve(options.workspaceRoot, 'data', 'api');
  const configStore = new ConfigStore({ dataDir: dataDirectory });
  const auditStore = new AuditStore({ dataDir: dataDirectory });
  const botManager = new BotManager(configStore, options.workspaceRoot, auditStore);

  const socketClients = new Set<TrackedSocket>();

  const unsubscribe = botManager.subscribe((event) => {
    const payload = JSON.stringify(StreamEventSchema.parse(event));
    for (const client of socketClients) {
      broadcastToSocket(client, payload);
    }
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const allowed =
        /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin) ||
        /^https:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);

      callback(null, allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-local-token'],
    credentials: true,
  });

  await app.register(websocket);

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url === '/api/v1/health') {
      return;
    }

    const requiredToken = process.env.LOCAL_API_TOKEN;
    if (!requiredToken) {
      return;
    }

    const token = parseLocalToken(request.headers);

    if (token !== requiredToken) {
      return sendErrorAndReturn(reply, 401, 'UNAUTHORIZED', 'Missing or invalid local API token');
    }
  });

  app.get('/api/v1/health', async () => {
    const bots = botManager.getAllBotStatuses();
    const isDegraded = bots.some((bot) => bot.state === 'error');

    return HealthResponseSchema.parse({
      status: isDegraded ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      bots,
    });
  });

  app.get('/api/v1/config', async () => {
    return configStore.getRuntimeConfig();
  });

  app.put('/api/v1/config', async (request, reply) => {
    try {
      const nextConfig = configStore.updateRuntimeConfig(request.body);
      auditStore.log({
        action: 'config_updated',
        source: 'api',
        metadata: {
          keys: Object.keys((request.body as Record<string, unknown>) ?? {}),
        },
      });
      return nextConfig;
    } catch (error) {
      return sendErrorAndReturn(
        reply,
        400,
        'INVALID_CONFIG',
        getRouteErrorMessage(error, 'Invalid config patch'),
      );
    }
  });

  app.get('/api/v1/bots/:bot/status', async (request, reply) => {
    try {
      const bot = parseBotParam(request.params);
      return botManager.getBotStatus(bot);
    } catch (error) {
      return sendErrorAndReturn(
        reply,
        400,
        'INVALID_BOT',
        getRouteErrorMessage(error, 'Invalid bot'),
      );
    }
  });

  app.post('/api/v1/bots/:bot/start', async (request, reply) => {
    try {
      const bot = parseBotParam(request.params);
      const parsedBody = parseStartStopBody(request.body);
      const mode = parsedBody.mode;
      return await botManager.start(bot, mode);
    } catch (error) {
      return sendErrorAndReturn(
        reply,
        400,
        'BOT_START_FAILED',
        getRouteErrorMessage(error, 'Failed to start bot'),
      );
    }
  });

  app.post('/api/v1/bots/:bot/stop', async (request, reply) => {
    try {
      const bot = parseBotParam(request.params);
      return await botManager.stop(bot);
    } catch (error) {
      return sendErrorAndReturn(
        reply,
        400,
        'BOT_STOP_FAILED',
        getRouteErrorMessage(error, 'Failed to stop bot'),
      );
    }
  });

  app.post('/api/v1/bots/:bot/restart', async (request, reply) => {
    try {
      const bot = parseBotParam(request.params);
      const parsedBody = parseStartStopBody(request.body);
      const mode = parsedBody.mode;
      return await botManager.restart(bot, mode);
    } catch (error) {
      return sendErrorAndReturn(
        reply,
        400,
        'BOT_RESTART_FAILED',
        getRouteErrorMessage(error, 'Failed to restart bot'),
      );
    }
  });

  app.get('/api/v1/logs', async (request, reply) => {
    try {
      const parsed = parseLogsQuery(request.query);
      return {
        logs: botManager.getLogs(parsed.limit ?? 200).map((entry) => LogEntrySchema.parse(entry)),
      };
    } catch (error) {
      return sendErrorAndReturn(
        reply,
        400,
        'INVALID_LOG_QUERY',
        getRouteErrorMessage(error, 'Invalid logs query'),
      );
    }
  });

  app.get('/api/v1/alerts', async (request, reply) => {
    try {
      const parsed = parseAlertsQuery(request.query);
      return {
        alerts: botManager.getAlerts(parsed.limit ?? 200),
      };
    } catch (error) {
      return sendErrorAndReturn(
        reply,
        400,
        'INVALID_ALERT_QUERY',
        getRouteErrorMessage(error, 'Invalid alerts query'),
      );
    }
  });

  app.post('/api/v1/bots/kill-switch', async () => {
    configStore.updateRuntimeConfig({
      risk: {
        killSwitchArmed: true,
      },
    });

    await botManager.stopAll();

    auditStore.log({
      action: 'kill_switch',
      source: 'api',
    });

    return {
      bots: botManager.getAllBotStatuses(),
    };
  });

  app.post('/api/v1/bots/kill-switch/reset', async () => {
    const config = configStore.updateRuntimeConfig({
      risk: {
        killSwitchArmed: false,
      },
    });

    auditStore.log({
      action: 'kill_switch_reset',
      source: 'api',
    });

    return {
      risk: config.risk,
    };
  });

  app.get('/api/v1/positions', async () => ({
    positions: [] as Position[],
  }));

  app.get('/api/v1/orders', async () => ({
    orders: [] as Order[],
  }));

  app.get('/api/v1/trades', async () => ({
    trades: [] as Trade[],
  }));

  app.get('/api/v1/markets', async () => ({
    markets: [],
  }));

  app.get('/api/v1/audit', async (request, reply) => {
    try {
      const parsed = parseAuditQuery(request.query);
      return {
        events: auditStore
          .getRecent(parsed.limit ?? 200)
          .map((event) => AuditEventSchema.parse(event)),
      };
    } catch (error) {
      return sendErrorAndReturn(
        reply,
        400,
        'INVALID_AUDIT_QUERY',
        getRouteErrorMessage(error, 'Invalid audit query'),
      );
    }
  });

  app.get('/api/v1/metrics', async () => {
    return {
      timestamp: new Date().toISOString(),
      memory: process.memoryUsage(),
      uptimeSeconds: process.uptime(),
      bots: botManager.getAllBotStatuses(),
    };
  });

  app.get('/api/v1/stream', { websocket: true }, (connection) => {
    try {
      const socket = asTrackedSocket(connection);
      handleSocketConnection(socket, socketClients);
      sendBotStateSnapshot(socket, botManager);
    } catch (error) {
      app.log.error(error);
    }
  });

  const heartbeat = setupSocketHeartbeat(socketClients);

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    unsubscribe();
    closeSocketClients(socketClients);
    await botManager.stopAll();
  });

  return app;
}
