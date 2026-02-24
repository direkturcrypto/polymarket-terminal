import type { Alert, BotStatus, LogEntry } from '@polymarket/shared';

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error';

export interface ToolCallEntry {
  id: string;
  title: string;
  status: ToolCallStatus;
  description?: string;
  rawOutput?: string;
  startedAt: string;
  finishedAt?: string;
  expanded: boolean;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  streaming?: boolean;
  toolCalls?: ToolCallEntry[];
}

export interface SessionEntry {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export type ThemeName = 'dark' | 'oled' | 'cobalt';

export type StreamConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface AppSnapshot {
  sessions: SessionEntry[];
  currentSessionId: string;
  theme: ThemeName;
}

export interface BotStatusMap {
  copy: BotStatus;
  mm: BotStatus;
  sniper: BotStatus;
}

export interface LiveDataState {
  connectionState: StreamConnectionState;
  logs: LogEntry[];
  alerts: Alert[];
  bots: BotStatusMap;
}
