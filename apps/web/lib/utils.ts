export function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function trimToSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
