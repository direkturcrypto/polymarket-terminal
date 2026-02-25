import type {
  Alert,
  AuditEvent,
  BotId,
  BotMode,
  BotStatus,
  LogEntry,
  RuntimeConfig,
} from '@polymarket/shared';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:18789';

export function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;
}

export function getApiWsUrl(): string {
  const base = getApiBaseUrl();
  if (base.startsWith('https://')) {
    return `wss://${base.slice('https://'.length)}`;
  }
  if (base.startsWith('http://')) {
    return `ws://${base.slice('http://'.length)}`;
  }
  if (base.startsWith('ws://') || base.startsWith('wss://')) {
    return base;
  }
  return `ws://${base}`;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
}

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string; code?: string };
    if (payload.message) {
      return payload.message;
    }
    if (payload.code) {
      return payload.code;
    }
  } catch {
    // no-op
  }

  return `${response.status} ${response.statusText}`;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = joinUrl(getApiBaseUrl(), path);

  const localToken = process.env.NEXT_PUBLIC_LOCAL_API_TOKEN;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(localToken ? { 'x-local-token': localToken } : {}),
    ...(init.headers ?? {}),
  };

  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new ApiRequestError(response.status, message);
  }

  return (await response.json()) as T;
}

export function getHealth(): Promise<{
  status: 'ok' | 'degraded';
  timestamp: string;
  uptimeSeconds: number;
  bots: BotStatus[];
}> {
  return apiRequest('/api/v1/health');
}

export function getConfig(): Promise<RuntimeConfig> {
  return apiRequest('/api/v1/config');
}

export function startBot(bot: BotId, mode?: BotMode): Promise<BotStatus> {
  return apiRequest(`/api/v1/bots/${bot}/start`, {
    method: 'POST',
    body: JSON.stringify(mode ? { mode } : {}),
  });
}

export function stopBot(bot: BotId): Promise<BotStatus> {
  return apiRequest(`/api/v1/bots/${bot}/stop`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function restartBot(bot: BotId, mode?: BotMode): Promise<BotStatus> {
  return apiRequest(`/api/v1/bots/${bot}/restart`, {
    method: 'POST',
    body: JSON.stringify(mode ? { mode } : {}),
  });
}

export function getBotStatus(bot: BotId): Promise<BotStatus> {
  return apiRequest(`/api/v1/bots/${bot}/status`);
}

export function getMetrics(): Promise<unknown> {
  return apiRequest('/api/v1/metrics');
}

export function getLogs(limit = 200): Promise<{ logs: LogEntry[] }> {
  return apiRequest(`/api/v1/logs?limit=${limit}`);
}

export function getAlerts(limit = 200): Promise<{ alerts: Alert[] }> {
  return apiRequest(`/api/v1/alerts?limit=${limit}`);
}

export function getAudit(limit = 200): Promise<{ events: AuditEvent[] }> {
  return apiRequest(`/api/v1/audit?limit=${limit}`);
}

export function triggerKillSwitch(): Promise<{ bots: BotStatus[] }> {
  return apiRequest('/api/v1/bots/kill-switch', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function resetKillSwitch(): Promise<{ risk: { killSwitchArmed: boolean } }> {
  return apiRequest('/api/v1/bots/kill-switch/reset', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
