export type BotControllerState = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

export interface BotControllerStatus {
  state: BotControllerState;
  updatedAt: string;
  lastError?: string;
}

export type Unsubscribe = () => void;

export interface BotController<TConfig, TEvent = unknown> {
  start(config: TConfig): Promise<void>;
  stop(): Promise<void>;
  status(): BotControllerStatus;
  subscribe(listener: (event: TEvent) => void): Unsubscribe;
}

export interface ProcessBotControllerOptions {
  botId: string;
  scriptPath: string;
  cwd?: string;
}

export interface ProcessBotControllerStartConfig {
  env?: NodeJS.ProcessEnv;
}

export type ProcessBotControllerEvent =
  | {
      type: 'state';
      status: BotControllerStatus;
    }
  | {
      type: 'log';
      channel: 'stdout' | 'stderr';
      message: string;
      timestamp: string;
    };
