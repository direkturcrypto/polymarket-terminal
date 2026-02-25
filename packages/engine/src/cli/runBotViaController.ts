import path from 'node:path';

import { ProcessBotController } from '@polymarket/engine';

type BotId = 'copy' | 'mm' | 'sniper';

const SCRIPT_BY_BOT: Record<BotId, string> = {
  copy: 'src/index.js',
  mm: 'src/mm.js',
  sniper: 'src/sniper.js',
};

function parseBotArg(value: string | undefined): BotId {
  if (value === 'copy' || value === 'mm' || value === 'sniper') {
    return value;
  }

  console.error('Invalid bot id. Expected one of: copy, mm, sniper.');
  process.exit(1);
}

async function main(): Promise<void> {
  const bot = parseBotArg(process.argv[2]);
  const workspaceRoot = process.cwd();
  const controller = new ProcessBotController({
    botId: bot,
    scriptPath: path.resolve(workspaceRoot, SCRIPT_BY_BOT[bot]),
    cwd: workspaceRoot,
  });

  let isStopping = false;
  let startedRunning = false;
  let done = false;

  const runPromise = new Promise<void>((resolve) => {
    const finish = (exitCode: number) => {
      if (done) {
        return;
      }

      done = true;
      process.exitCode = exitCode;
      resolve();
    };

    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'log') {
        if (event.channel === 'stderr') {
          process.stderr.write(`${event.message}\n`);
          return;
        }

        process.stdout.write(`${event.message}\n`);
        return;
      }

      if (event.status.state === 'running') {
        startedRunning = true;
        return;
      }

      if (event.status.state === 'error') {
        const message = event.status.lastError ?? `${bot} failed`;
        console.error(`Failed to run ${bot} bot: ${message}`);
        unsubscribe();
        finish(1);
        return;
      }

      if (event.status.state === 'idle' && (startedRunning || isStopping)) {
        unsubscribe();
        finish(0);
      }
    });

    const gracefulStop = async () => {
      if (isStopping || done) {
        return;
      }

      isStopping = true;

      try {
        await controller.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to stop ${bot} bot cleanly: ${message}`);
        unsubscribe();
        finish(1);
      }
    };

    process.once('SIGINT', () => {
      void gracefulStop();
    });
    process.once('SIGTERM', () => {
      void gracefulStop();
    });

    controller
      .start({
        env: process.env,
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to start ${bot} bot: ${message}`);
        unsubscribe();
        finish(1);
      });
  });

  await runPromise;
}

void main();
