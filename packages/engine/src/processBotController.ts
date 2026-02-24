import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';

import type {
  BotController,
  BotControllerStatus,
  ProcessBotControllerEvent,
  ProcessBotControllerOptions,
  ProcessBotControllerStartConfig,
  Unsubscribe,
} from './types.js';

const STOP_TIMEOUT_MS = 7_000;

export class ProcessBotController implements BotController<
  ProcessBotControllerStartConfig,
  ProcessBotControllerEvent
> {
  private readonly options: ProcessBotControllerOptions;
  private readonly emitter = new EventEmitter();
  private process: ChildProcess | null = null;
  private statusSnapshot: BotControllerStatus = {
    state: 'idle',
    updatedAt: new Date().toISOString(),
  };
  private stoppingRequested = false;

  constructor(options: ProcessBotControllerOptions) {
    this.options = options;
    this.emitter.setMaxListeners(100);
  }

  async start(config: ProcessBotControllerStartConfig): Promise<void> {
    if (this.process) {
      throw new Error(`${this.options.botId} is already running`);
    }

    this.stoppingRequested = false;
    this.updateStatus('starting');

    const child = spawn(process.execPath, [this.options.scriptPath], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...config.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process = child;

    if (!child.stdout || !child.stderr) {
      this.process = null;
      this.updateStatus('error', `${this.options.botId} process stream setup failed`);
      throw new Error(`${this.options.botId} process stream setup failed`);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      this.emitLog('stdout', chunk);
    });

    child.stderr.on('data', (chunk: string) => {
      this.emitLog('stderr', chunk);
    });

    child.once('spawn', () => {
      this.updateStatus('running');
    });

    child.once('error', (error: Error) => {
      this.updateStatus('error', error.message);
    });

    child.once('exit', (code, signal) => {
      const isFailure = !this.stoppingRequested && code !== 0;
      const failureReason = isFailure
        ? `${this.options.botId} exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`
        : undefined;

      this.process = null;
      this.stoppingRequested = false;

      if (isFailure) {
        this.updateStatus('error', failureReason);
        return;
      }

      this.updateStatus('idle');
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.stoppingRequested = true;
    this.updateStatus('stopping');

    const child = this.process;

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const timeout = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, STOP_TIMEOUT_MS);

      child.once('exit', () => {
        clearTimeout(timeout);
        finish();
      });

      if (!child.killed) {
        child.kill('SIGTERM');
      }
    });
  }

  status(): BotControllerStatus {
    return { ...this.statusSnapshot };
  }

  subscribe(listener: (event: ProcessBotControllerEvent) => void): Unsubscribe {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  private emitLog(channel: 'stdout' | 'stderr', chunk: string): void {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    for (const message of lines) {
      this.emitter.emit('event', {
        type: 'log',
        channel,
        message,
        timestamp: new Date().toISOString(),
      } satisfies ProcessBotControllerEvent);
    }
  }

  private updateStatus(state: BotControllerStatus['state'], lastError?: string): void {
    this.statusSnapshot = {
      state,
      updatedAt: new Date().toISOString(),
      lastError,
    };

    this.emitter.emit('event', {
      type: 'state',
      status: this.status(),
    } satisfies ProcessBotControllerEvent);
  }
}
