import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { createApiServer } from './server.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, '../../..');

dotenv.config({ path: path.resolve(workspaceRoot, '.env') });
dotenv.config({ path: path.resolve(workspaceRoot, '.env.local'), override: true });

const port = Number(process.env.API_PORT ?? 18789);
const host = process.env.API_HOST ?? '127.0.0.1';

const app = await createApiServer({ workspaceRoot });

const shutdown = async () => {
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ host, port });
  app.log.info(`API listening on http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
