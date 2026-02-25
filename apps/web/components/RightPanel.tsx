'use client';

import type { Alert, LogEntry } from '@polymarket/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { BotStatusMap, LogBotFilter } from '../lib/types';
import { formatUtcTime } from '../lib/utils';

type TabId = 'bots' | 'logs' | 'alerts';
type LogFilter = 'all' | 'debug' | 'info' | 'warn' | 'error' | 'success';

interface RightPanelProps {
  bots: BotStatusMap;
  logs: LogEntry[];
  alerts: Alert[];
  connectionState: 'connecting' | 'connected' | 'disconnected';
  logBotFilter: LogBotFilter;
  onLogBotFilterChange: (value: LogBotFilter) => void;
}

const LOG_SOURCE_OPTIONS: Array<{ value: LogBotFilter; label: string }> = [
  { value: 'all', label: 'All Sources' },
  { value: 'api', label: 'API' },
  { value: 'copy', label: 'Copy' },
  { value: 'mm', label: 'MM' },
  { value: 'sniper', label: 'Sniper' },
];

function StatusPill({ state }: { state: string }) {
  return <span className={`statusPill is-${state}`}>{state}</span>;
}

export function RightPanel({
  bots,
  logs,
  alerts,
  connectionState,
  logBotFilter,
  onLogBotFilterChange,
}: RightPanelProps) {
  const [tab, setTab] = useState<TabId>('logs');
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [logQuery, setLogQuery] = useState('');
  const [followLogs, setFollowLogs] = useState(true);
  const logViewportRef = useRef<HTMLDivElement | null>(null);

  const visibleLogs = useMemo(() => {
    const normalizedQuery = logQuery.trim().toLowerCase();

    return logs
      .filter((entry) => {
        const source = entry.bot ?? 'api';

        if (logBotFilter !== 'all' && source !== logBotFilter) {
          return false;
        }

        if (logFilter !== 'all' && entry.level !== logFilter) {
          return false;
        }

        if (!normalizedQuery) {
          return true;
        }

        return `${source} ${entry.level} ${entry.message}`.toLowerCase().includes(normalizedQuery);
      })
      .slice(-350)
      .reverse();
  }, [logs, logBotFilter, logFilter, logQuery]);

  useEffect(() => {
    if (!followLogs || tab !== 'logs') {
      return;
    }

    const viewport = logViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = 0;
  }, [visibleLogs, followLogs, tab]);

  useEffect(() => {
    setTab('logs');
  }, [logBotFilter]);

  return (
    <aside className="rightPanel" aria-label="Runtime context panel">
      <div className="rightPanelTabs" role="tablist" aria-label="Panel sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'bots'}
          onClick={() => setTab('bots')}
        >
          Bots
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'logs'}
          onClick={() => setTab('logs')}
        >
          Logs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'alerts'}
          onClick={() => setTab('alerts')}
        >
          Alerts
        </button>
      </div>

      {tab === 'bots' ? (
        <div className="rightPanelBody">
          {Object.values(bots).map((bot) => (
            <article key={bot.bot} className="botRow">
              <header>
                <h3>{bot.bot.toUpperCase()}</h3>
                <StatusPill state={bot.state} />
              </header>
              <p>
                Mode: <strong>{bot.mode}</strong>
              </p>
              <p>Updated: {formatUtcTime(bot.updatedAt)}</p>
              {bot.lastError ? <p className="errorText">{bot.lastError}</p> : null}
            </article>
          ))}
        </div>
      ) : null}

      {tab === 'logs' ? (
        <div className="rightPanelBody logConsoleWrap">
          <div className="logToolbar">
            <input
              value={logQuery}
              onChange={(event) => setLogQuery(event.target.value)}
              placeholder="Search logs"
              aria-label="Search logs"
            />

            <select
              value={logBotFilter}
              onChange={(event) => onLogBotFilterChange(event.target.value as LogBotFilter)}
              aria-label="Filter logs by bot"
            >
              {LOG_SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              value={logFilter}
              onChange={(event) => setLogFilter(event.target.value as LogFilter)}
              aria-label="Filter logs by level"
            >
              <option value="all">All</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>

            <button type="button" onClick={() => setFollowLogs((value) => !value)}>
              {followLogs ? 'Follow On' : 'Follow Off'}
            </button>
          </div>

          <div className="logConsole" ref={logViewportRef}>
            {visibleLogs.length === 0 ? (
              <p className="logEmptyState">
                {connectionState === 'connected'
                  ? logBotFilter === 'all'
                    ? 'Live stream connected. Waiting for logs...'
                    : `Live stream connected. Waiting for ${logBotFilter.toUpperCase()} logs...`
                  : connectionState === 'connecting'
                    ? 'Connecting to live stream...'
                    : 'Live stream disconnected. Retrying...'}
              </p>
            ) : null}

            {visibleLogs.map((log) => (
              <article key={log.id} className={`logLine is-${log.level}`}>
                <div className="logLineMeta">
                  <time>{formatUtcTime(log.timestamp)}</time>
                  <span>{log.bot ?? 'api'}</span>
                </div>
                <p>{log.message}</p>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {tab === 'alerts' ? (
        <div className="rightPanelBody">
          {alerts.length === 0 ? <p>No alerts triggered.</p> : null}
          {alerts
            .slice(-60)
            .reverse()
            .map((alert) => (
              <article key={alert.id} className={`alertRow is-${alert.severity}`}>
                <div>
                  <strong>{alert.code}</strong>
                  <time>{formatUtcTime(alert.timestamp)}</time>
                </div>
                <p>{alert.message}</p>
              </article>
            ))}
        </div>
      ) : null}
    </aside>
  );
}
