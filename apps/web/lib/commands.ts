import type { BotId, BotMode } from '@polymarket/shared';

type BotCommandKind = 'start' | 'stop' | 'restart' | 'status';

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'health' }
  | { kind: 'config' }
  | { kind: 'metrics' }
  | { kind: 'audit' }
  | { kind: 'logs' }
  | { kind: 'alerts' }
  | { kind: 'kill' }
  | { kind: 'kill_reset' }
  | { kind: BotCommandKind; bot: BotId; mode?: BotMode };

function parseBot(value: string | undefined): BotId | undefined {
  if (value === 'copy' || value === 'mm' || value === 'sniper') {
    return value;
  }
  return undefined;
}

function parseMode(value: string | undefined): BotMode | undefined {
  if (value === 'dry' || value === 'live') {
    return value;
  }
  return undefined;
}

export function parseCommand(input: string): ParsedCommand | null {
  const value = input.trim();
  if (!value.startsWith('/')) {
    return null;
  }

  const parts = value
    .slice(1)
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  const [root, arg1, arg2] = parts;

  if (!root || root === 'help') {
    return { kind: 'help' };
  }

  if (root === 'health') {
    return { kind: 'health' };
  }

  if (root === 'config') {
    return { kind: 'config' };
  }

  if (root === 'metrics') {
    return { kind: 'metrics' };
  }

  if (root === 'audit') {
    return { kind: 'audit' };
  }

  if (root === 'logs') {
    return { kind: 'logs' };
  }

  if (root === 'alerts') {
    return { kind: 'alerts' };
  }

  if (root === 'kill' || root === 'kill-switch') {
    return { kind: 'kill' };
  }

  if (root === 'kill-reset' || root === 'kill_switch_reset') {
    return { kind: 'kill_reset' };
  }

  if (root === 'start' || root === 'stop' || root === 'restart' || root === 'status') {
    const bot = parseBot(arg1);
    if (!bot) {
      return { kind: 'help' };
    }

    if (root === 'start' || root === 'restart') {
      return {
        kind: root,
        bot,
        mode: parseMode(arg2),
      };
    }

    return {
      kind: root,
      bot,
    };
  }

  return { kind: 'help' };
}

export const COMMAND_HELP = [
  '`/start <copy|mm|sniper> [dry|live]`',
  '`/stop <copy|mm|sniper>`',
  '`/restart <copy|mm|sniper> [dry|live]`',
  '`/status <copy|mm|sniper>`',
  '`/health`',
  '`/config`',
  '`/metrics`',
  '`/logs`',
  '`/alerts`',
  '`/audit`',
  '`/kill`',
  '`/kill-reset`',
].join('\n');
