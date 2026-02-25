export function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function trimToSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function formatUtcTime(value: string, precision: 'minutes' | 'seconds' = 'seconds'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return precision === 'minutes' ? '--:--' : '--:--:--';
  }

  const iso = date.toISOString();
  return precision === 'minutes' ? `${iso.slice(11, 16)}Z` : `${iso.slice(11, 19)}Z`;
}
