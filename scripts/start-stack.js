import { spawn } from 'node:child_process';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';

const processSpecs =
  mode === 'start'
    ? [
        {
          name: 'api',
          command: 'npm run api:start',
        },
        {
          name: 'web',
          command: 'npm run start -w @polymarket/web',
        },
      ]
    : [
        {
          name: 'api',
          command: 'npm run api:dev',
        },
        {
          name: 'web',
          command: 'npm run dev -w @polymarket/web',
        },
      ];

const children = processSpecs.map((spec) => {
  const child = spawn(spec.command, {
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });

  return {
    ...spec,
    child,
  };
});

let shuttingDown = false;
let forcedExitCode = 0;

function stopChildren(exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  forcedExitCode = exitCode;

  for (const { child } of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
  }, 1500);

  setTimeout(() => {
    process.exit(forcedExitCode);
  }, 1800);
}

for (const { name, child } of children) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const safeCode = code ?? 1;
    console.error(`${name} exited (code=${safeCode}, signal=${signal ?? 'null'}). Stopping stack.`);
    stopChildren(safeCode === 0 ? 0 : safeCode);
  });

  child.on('error', (error) => {
    if (shuttingDown) {
      return;
    }

    console.error(`${name} failed to start:`, error);
    stopChildren(1);
  });
}

process.on('SIGINT', () => {
  stopChildren(0);
});

process.on('SIGTERM', () => {
  stopChildren(0);
});
