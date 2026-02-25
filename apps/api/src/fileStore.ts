import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function ensureDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true });
}

export function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

export function atomicWriteJson(filePath: string, payload: unknown): void {
  const parentDirectory = path.dirname(filePath);
  ensureDirectory(parentDirectory);

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  writeFileSync(tempPath, json, 'utf8');
  renameSync(tempPath, filePath);
}
