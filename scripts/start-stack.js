import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const portSearchWindow = 30;

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = createServer();

    tester.once('error', () => {
      resolve(false);
    });

    tester.once('listening', () => {
      tester.close(() => {
        resolve(true);
      });
    });

    tester.listen(port, host);
  });
}

async function findAvailablePort(startPort, host = '127.0.0.1') {
  for (let offset = 0; offset <= portSearchWindow; offset += 1) {
    const candidate = startPort + offset;
    if (await isPortFree(candidate, host)) {
      return candidate;
    }
  }

  throw new Error(
    `No free port found from ${startPort} to ${startPort + portSearchWindow} on ${host}`,
  );
}

function runCommand(command, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env,
    });

    child.on('exit', (code) => {
      resolve(code ?? 1);
    });

    child.on('error', () => {
      resolve(1);
    });
  });
}

async function ensureWebBuildIfNeeded() {
  if (mode !== 'start' || process.env.STACK_SKIP_BUILD === 'true') {
    return;
  }

  const buildIdPath = path.resolve(process.cwd(), 'apps', 'web', '.next', 'BUILD_ID');

  try {
    await access(buildIdPath, constants.F_OK);
    return;
  } catch {
    console.log(
      '[stack] no web production build detected. running `npm run build -w @polymarket/web`.',
    );
  }

  const exitCode = await runCommand('npm run build -w @polymarket/web');
  if (exitCode !== 0) {
    throw new Error('Web build failed; cannot continue with stack:start');
  }
}

function killWithTaskkill(pid, force = false) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }

    const args = ['/pid', String(pid), '/T'];
    if (force) {
      args.push('/F');
    }

    const killer = spawn('taskkill', args, {
      stdio: 'ignore',
    });

    killer.on('exit', () => resolve());
    killer.on('error', () => resolve());
  });
}

function terminateChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    child.once('exit', finish);

    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }

    setTimeout(async () => {
      if (settled || child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }

      if (process.platform === 'win32') {
        await killWithTaskkill(child.pid, true);
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }

      finish();
    }, 1800);

    setTimeout(() => {
      finish();
    }, 3000);
  });
}

async function main() {
  await ensureWebBuildIfNeeded();

  const apiHost = process.env.API_HOST ?? '127.0.0.1';
  const webHost = process.env.WEB_HOST ?? '127.0.0.1';

  const requestedApiPort = parsePort(process.env.API_PORT, 18789);
  const requestedWebPort = parsePort(process.env.WEB_PORT ?? process.env.PORT, 3000);

  const apiPort = await findAvailablePort(requestedApiPort, apiHost);
  const webPort = await findAvailablePort(requestedWebPort, webHost);
  const publicApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? `http://${apiHost}:${apiPort}`;
  const publicLocalApiToken =
    process.env.NEXT_PUBLIC_LOCAL_API_TOKEN ?? process.env.LOCAL_API_TOKEN;
  const webPublicEnv = {
    NEXT_PUBLIC_API_BASE_URL: publicApiBaseUrl,
    ...(publicLocalApiToken ? { NEXT_PUBLIC_LOCAL_API_TOKEN: publicLocalApiToken } : {}),
  };

  if (apiPort !== requestedApiPort) {
    console.warn(
      `[stack] API port ${requestedApiPort} is busy, using ${apiPort}. ` +
        `Set API_PORT to override.`,
    );
  }

  if (webPort !== requestedWebPort) {
    console.warn(
      `[stack] Web port ${requestedWebPort} is busy, using ${webPort}. ` +
        `Set WEB_PORT (or PORT) to override.`,
    );
  }

  const specs =
    mode === 'start'
      ? [
          {
            name: 'api',
            command: 'npm run api:start',
            env: {
              API_HOST: apiHost,
              API_PORT: String(apiPort),
            },
          },
          {
            name: 'web',
            command: `npm run start -w @polymarket/web -- --hostname ${webHost} --port ${webPort}`,
            env: {
              PORT: String(webPort),
              HOSTNAME: webHost,
              ...webPublicEnv,
            },
          },
        ]
      : [
          {
            name: 'api',
            command: 'npm run api:dev',
            env: {
              API_HOST: apiHost,
              API_PORT: String(apiPort),
            },
          },
          {
            name: 'web',
            command: `npm run dev -w @polymarket/web -- --hostname ${webHost} --port ${webPort}`,
            env: {
              PORT: String(webPort),
              HOSTNAME: webHost,
              ...webPublicEnv,
            },
          },
        ];

  console.log(
    `[stack] mode=${mode} api=http://${apiHost}:${apiPort} web=http://${webHost}:${webPort}`,
  );

  const children = specs.map((spec) => ({
    ...spec,
    child: spawn(spec.command, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...spec.env,
      },
    }),
  }));

  let shuttingDown = false;
  let forcedExitCode = 0;

  const stopChildren = async (exitCode) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    forcedExitCode = exitCode;

    await Promise.all(children.map(({ child }) => terminateChild(child)));
    process.exit(forcedExitCode);
  };

  for (const { name, child } of children) {
    child.on('exit', (code, signal) => {
      if (shuttingDown) {
        return;
      }

      const safeCode = code ?? 1;
      console.error(
        `${name} exited (code=${safeCode}, signal=${signal ?? 'null'}). Stopping stack.`,
      );
      void stopChildren(safeCode === 0 ? 0 : safeCode);
    });

    child.on('error', (error) => {
      if (shuttingDown) {
        return;
      }

      console.error(`${name} failed to start:`, error);
      void stopChildren(1);
    });
  }

  process.on('SIGINT', () => {
    void stopChildren(0);
  });

  process.on('SIGTERM', () => {
    void stopChildren(0);
  });
}

main().catch((error) => {
  console.error('[stack] failed to initialize:', error);
  process.exit(1);
});
