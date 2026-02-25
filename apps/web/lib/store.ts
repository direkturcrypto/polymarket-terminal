import type { Alert, LogEntry, StreamEvent } from '@polymarket/shared';
import { create } from 'zustand';

import {
  getAudit,
  getAlerts,
  getBotStatus,
  getConfig,
  getHealth,
  getLogs,
  getMetrics,
  resetKillSwitch,
  restartBot,
  startBot,
  stopBot,
  triggerKillSwitch,
} from './api';
import { COMMAND_HELP, parseCommand, type ParsedCommand } from './commands';
import type {
  AppSnapshot,
  BotStatusMap,
  ChatMessage,
  LogBotFilter,
  SessionEntry,
  ThemeName,
  ToolCallEntry,
} from './types';
import { createId, nowIso, trimToSingleLine } from './utils';

const STORAGE_KEY = 'polymarket-web-ui-state-v1';
const MAX_LOGS = 300;
const MAX_ALERTS = 100;
const INITIAL_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const INITIAL_SESSION_ID = 'session_initial';
const INITIAL_MESSAGE_ID = 'message_initial_assistant';
const WELCOME_MESSAGE =
  'Welcome to the hybrid control shell. Type `/help` to see operator commands for bot control and diagnostics.';
const CLEAR_CONFIRMATION_MESSAGE =
  'Operational assistant cleared for this session. Type `/help` to start a new run.';

interface AppStore {
  sessions: SessionEntry[];
  currentSessionId: string;
  searchQuery: string;
  connectionState: 'connecting' | 'connected' | 'disconnected';
  theme: ThemeName;
  commandPaletteOpen: boolean;
  rightPanelOpen: boolean;
  logBotFilter: LogBotFilter;
  logs: LogEntry[];
  alerts: Alert[];
  bots: BotStatusMap;

  hydrateFromStorage: () => void;
  setTheme: (theme: ThemeName) => void;
  setSearchQuery: (value: string) => void;
  setConnectionState: (state: 'connecting' | 'connected' | 'disconnected') => void;
  setCommandPaletteOpen: (value: boolean) => void;
  setLogBotFilter: (value: LogBotFilter) => void;
  toggleRightPanel: () => void;

  createSession: () => void;
  selectSession: (sessionId: string) => void;
  togglePinSession: (sessionId: string) => void;
  toggleArchiveSession: (sessionId: string) => void;

  submitPrompt: (input: string) => Promise<void>;
  clearCurrentSession: () => void;
  toggleToolExpanded: (messageId: string, toolId: string) => void;
  ingestStreamEvent: (event: StreamEvent) => void;
}

function initialBotState(bot: 'copy' | 'mm' | 'sniper') {
  return {
    bot,
    mode: 'dry' as const,
    state: 'idle' as const,
    updatedAt: INITIAL_TIMESTAMP,
    lastError: null,
  };
}

function createAssistantMessage(id: string, createdAt: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    createdAt,
  };
}

function createSessionEntry(sessionId: string, messageId: string, createdAt: string): SessionEntry {
  return {
    id: sessionId,
    title: 'New Session',
    pinned: false,
    archived: false,
    createdAt,
    updatedAt: createdAt,
    messages: [createAssistantMessage(messageId, createdAt, WELCOME_MESSAGE)],
  };
}

function createInitialSession(): SessionEntry {
  return createSessionEntry(INITIAL_SESSION_ID, INITIAL_MESSAGE_ID, INITIAL_TIMESTAMP);
}

function createRuntimeSession(): SessionEntry {
  const createdAt = nowIso();

  return createSessionEntry(createId('session'), createId('message'), createdAt);
}

function updateSessionById(
  sessions: SessionEntry[],
  sessionId: string,
  updater: (session: SessionEntry) => SessionEntry,
): SessionEntry[] {
  return sessions.map((session) => (session.id === sessionId ? updater(session) : session));
}

function updateMessageById(
  sessions: SessionEntry[],
  sessionId: string,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): SessionEntry[] {
  return updateSessionById(sessions, sessionId, (session) => ({
    ...session,
    updatedAt: nowIso(),
    messages: session.messages.map((message) =>
      message.id === messageId ? updater(message) : message,
    ),
  }));
}

function withCurrentSession(state: AppStore): SessionEntry {
  const current = state.sessions.find((session) => session.id === state.currentSessionId);
  return current ?? state.sessions[0];
}

function serializeResult(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

async function executeCommand(command: ParsedCommand): Promise<unknown> {
  switch (command.kind) {
    case 'help':
      return { help: COMMAND_HELP };
    case 'health':
      return getHealth();
    case 'config':
      return getConfig();
    case 'metrics':
      return getMetrics();
    case 'logs':
      return getLogs(50);
    case 'alerts':
      return getAlerts(50);
    case 'audit':
      return getAudit(50);
    case 'kill':
      return triggerKillSwitch();
    case 'kill_reset':
      return resetKillSwitch();
    case 'status':
      return getBotStatus(command.bot);
    case 'start':
      return startBot(command.bot, command.mode);
    case 'stop':
      return stopBot(command.bot);
    case 'restart':
      return restartBot(command.bot, command.mode);
    default:
      return { help: COMMAND_HELP };
  }
}

function commandTitle(command: ParsedCommand): string {
  switch (command.kind) {
    case 'help':
      return 'Read command reference';
    case 'health':
      return 'GET /api/v1/health';
    case 'config':
      return 'GET /api/v1/config';
    case 'metrics':
      return 'GET /api/v1/metrics';
    case 'logs':
      return 'GET /api/v1/logs';
    case 'alerts':
      return 'GET /api/v1/alerts';
    case 'audit':
      return 'GET /api/v1/audit';
    case 'kill':
      return 'POST /api/v1/bots/kill-switch';
    case 'kill_reset':
      return 'POST /api/v1/bots/kill-switch/reset';
    case 'status':
      return `GET /api/v1/bots/${command.bot}/status`;
    case 'start':
      return `POST /api/v1/bots/${command.bot}/start`;
    case 'stop':
      return `POST /api/v1/bots/${command.bot}/stop`;
    case 'restart':
      return `POST /api/v1/bots/${command.bot}/restart`;
    default:
      return 'Run command';
  }
}

function commandSuccessText(command: ParsedCommand, payload: unknown): string {
  if (command.kind === 'help') {
    return `Available commands:\n${COMMAND_HELP}`;
  }

  const headline = `Command completed: \`${commandTitle(command)}\``;
  const summary = trimToSingleLine(serializeResult(payload)).slice(0, 420);
  return `${headline}\n\n${summary}`;
}

function commandErrorText(command: ParsedCommand, message: string): string {
  return `Command failed: \`${commandTitle(command)}\`\n\n${message}`;
}

function guessSessionTitle(messages: ChatMessage[]): string {
  const userMessage = messages.find((message) => message.role === 'user');
  if (!userMessage) {
    return 'New Session';
  }

  const candidate = userMessage.content.replace(/^\//, '').trim();
  if (!candidate) {
    return 'New Session';
  }

  return candidate.length > 36 ? `${candidate.slice(0, 36)}...` : candidate;
}

function persistSnapshot(value: AppSnapshot): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function readSnapshot(): AppSnapshot | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AppSnapshot;
  } catch {
    return null;
  }
}

function streamMessageContent(
  set: (updater: (state: AppStore) => Partial<AppStore>) => void,
  sessionId: string,
  messageId: string,
  content: string,
): void {
  let cursor = 0;
  const chunkSize = 10;

  const timer = window.setInterval(() => {
    cursor += chunkSize;
    const isDone = cursor >= content.length;
    const nextValue = content.slice(0, Math.min(cursor, content.length));

    set((state) => ({
      sessions: updateMessageById(state.sessions, sessionId, messageId, (message) => ({
        ...message,
        content: nextValue,
        streaming: !isDone,
      })),
    }));

    if (isDone) {
      window.clearInterval(timer);
    }
  }, 16);
}

export const useAppStore = create<AppStore>((set, get) => {
  const initialSession = createInitialSession();

  const save = (sessions: SessionEntry[], currentSessionId: string, theme: ThemeName) => {
    persistSnapshot({
      sessions,
      currentSessionId,
      theme,
    });
  };

  return {
    sessions: [initialSession],
    currentSessionId: initialSession.id,
    searchQuery: '',
    connectionState: 'connecting',
    theme: 'dark',
    commandPaletteOpen: false,
    rightPanelOpen: true,
    logBotFilter: 'all',
    logs: [],
    alerts: [],
    bots: {
      copy: initialBotState('copy'),
      mm: initialBotState('mm'),
      sniper: initialBotState('sniper'),
    },

    hydrateFromStorage: () => {
      const snapshot = readSnapshot();
      if (!snapshot || snapshot.sessions.length === 0) {
        return;
      }

      set(() => ({
        sessions: snapshot.sessions,
        currentSessionId: snapshot.currentSessionId,
        theme: snapshot.theme,
      }));
    },

    setTheme: (theme) => {
      set((state) => {
        save(state.sessions, state.currentSessionId, theme);
        return { theme };
      });
    },

    setSearchQuery: (value) => {
      set(() => ({ searchQuery: value }));
    },

    setConnectionState: (state) => {
      set(() => ({ connectionState: state }));
    },

    setCommandPaletteOpen: (value) => {
      set(() => ({ commandPaletteOpen: value }));
    },

    setLogBotFilter: (value) => {
      set(() => ({ logBotFilter: value }));
    },

    toggleRightPanel: () => {
      set((state) => ({ rightPanelOpen: !state.rightPanelOpen }));
    },

    createSession: () => {
      set((state) => {
        const session = createRuntimeSession();
        const sessions = [session, ...state.sessions];
        save(sessions, session.id, state.theme);
        return {
          sessions,
          currentSessionId: session.id,
        };
      });
    },

    selectSession: (sessionId) => {
      set((state) => {
        save(state.sessions, sessionId, state.theme);
        return {
          currentSessionId: sessionId,
          commandPaletteOpen: false,
        };
      });
    },

    togglePinSession: (sessionId) => {
      set((state) => {
        const sessions = updateSessionById(state.sessions, sessionId, (session) => ({
          ...session,
          pinned: !session.pinned,
          updatedAt: nowIso(),
        }));
        save(sessions, state.currentSessionId, state.theme);
        return { sessions };
      });
    },

    toggleArchiveSession: (sessionId) => {
      set((state) => {
        const sessions = updateSessionById(state.sessions, sessionId, (session) => ({
          ...session,
          archived: !session.archived,
          updatedAt: nowIso(),
        }));
        save(sessions, state.currentSessionId, state.theme);
        return { sessions };
      });
    },

    submitPrompt: async (input) => {
      const text = input.trim();
      if (!text) {
        return;
      }

      const state = get();
      const session = withCurrentSession(state);
      const command = parseCommand(text);
      const now = nowIso();

      const userMessage: ChatMessage = {
        id: createId('message'),
        role: 'user',
        content: text,
        createdAt: now,
      };

      const assistantMessageId = createId('message');
      const toolCallId = createId('tool');

      const toolCalls: ToolCallEntry[] | undefined = command
        ? [
            {
              id: toolCallId,
              title: commandTitle(command),
              status: 'pending',
              startedAt: now,
              expanded: false,
            },
          ]
        : undefined;

      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        streaming: true,
        createdAt: now,
        toolCalls,
      };

      set((prev) => {
        const sessions = updateSessionById(prev.sessions, session.id, (entry) => {
          const messages = [...entry.messages, userMessage, assistantMessage];
          return {
            ...entry,
            title: guessSessionTitle(messages),
            updatedAt: nowIso(),
            messages,
          };
        });

        save(sessions, prev.currentSessionId, prev.theme);
        return { sessions };
      });

      if (!command) {
        streamMessageContent(
          set,
          session.id,
          assistantMessageId,
          'I can run operator commands only in this phase. Use `/help` for supported actions.',
        );
        return;
      }

      set((prev) => ({
        sessions: updateMessageById(prev.sessions, session.id, assistantMessageId, (message) => ({
          ...message,
          toolCalls:
            message.toolCalls?.map((tool) =>
              tool.id === toolCallId
                ? {
                    ...tool,
                    status: 'running',
                  }
                : tool,
            ) ?? [],
        })),
      }));

      try {
        const payload = await executeCommand(command);
        const rawOutput = serializeResult(payload);

        set((prev) => ({
          sessions: updateMessageById(prev.sessions, session.id, assistantMessageId, (message) => ({
            ...message,
            toolCalls:
              message.toolCalls?.map((tool) =>
                tool.id === toolCallId
                  ? {
                      ...tool,
                      status: 'success',
                      finishedAt: nowIso(),
                      rawOutput,
                    }
                  : tool,
              ) ?? [],
          })),
        }));

        streamMessageContent(
          set,
          session.id,
          assistantMessageId,
          commandSuccessText(command, payload),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        set((prev) => ({
          sessions: updateMessageById(prev.sessions, session.id, assistantMessageId, (entry) => ({
            ...entry,
            toolCalls:
              entry.toolCalls?.map((tool) =>
                tool.id === toolCallId
                  ? {
                      ...tool,
                      status: 'error',
                      finishedAt: nowIso(),
                      rawOutput: message,
                    }
                  : tool,
              ) ?? [],
          })),
        }));

        streamMessageContent(
          set,
          session.id,
          assistantMessageId,
          commandErrorText(command, message),
        );
      }
    },

    clearCurrentSession: () => {
      set((state) => {
        const timestamp = nowIso();
        const sessions = updateSessionById(state.sessions, state.currentSessionId, (session) => ({
          ...session,
          updatedAt: timestamp,
          messages: [
            createAssistantMessage(createId('message'), timestamp, CLEAR_CONFIRMATION_MESSAGE),
          ],
        }));

        save(sessions, state.currentSessionId, state.theme);
        return { sessions };
      });
    },

    toggleToolExpanded: (messageId, toolId) => {
      set((state) => ({
        sessions: updateMessageById(
          state.sessions,
          state.currentSessionId,
          messageId,
          (message) => ({
            ...message,
            toolCalls:
              message.toolCalls?.map((tool) =>
                tool.id === toolId
                  ? {
                      ...tool,
                      expanded: !tool.expanded,
                    }
                  : tool,
              ) ?? [],
          }),
        ),
      }));
    },

    ingestStreamEvent: (event) => {
      if (event.topic === 'bot_state') {
        set((state) => ({
          bots: {
            ...state.bots,
            [event.payload.bot]: event.payload,
          },
        }));
        return;
      }

      if (event.topic === 'log') {
        set((state) => {
          const logs = [...state.logs, event.payload].slice(-MAX_LOGS);
          return { logs };
        });
        return;
      }

      if (event.topic === 'alert') {
        set((state) => {
          const alerts = [...state.alerts, event.payload].slice(-MAX_ALERTS);
          return { alerts };
        });
      }
    },
  };
});
