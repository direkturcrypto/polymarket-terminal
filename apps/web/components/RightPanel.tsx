'use client';

import type { Alert, LogEntry } from '@polymarket/shared';
import { useState } from 'react';

import type { BotStatusMap } from '../lib/types';

type TabId = 'bots' | 'logs' | 'alerts';

interface RightPanelProps {
  bots: BotStatusMap;
  logs: LogEntry[];
  alerts: Alert[];
}

function StatusPill({ state }: { state: string }) {
  return <span className={`statusPill is-${state}`}>{state}</span>;
}

export function RightPanel({ bots, logs, alerts }: RightPanelProps) {
  const [tab, setTab] = useState<TabId>('bots');

  return (
    <aside className="panel rightPanel" aria-label="Runtime context panel">
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
              <p>Updated: {new Date(bot.updatedAt).toLocaleTimeString()}</p>
              {bot.lastError ? <p className="errorText">{bot.lastError}</p> : null}
            </article>
          ))}
        </div>
      ) : null}

      {tab === 'logs' ? (
        <div className="rightPanelBody logList">
          {logs.length === 0 ? <p>No logs yet.</p> : null}
          {logs
            .slice(-120)
            .reverse()
            .map((log) => (
              <article key={log.id} className={`logRow is-${log.level}`}>
                <div>
                  <span>{log.bot ?? 'system'}</span>
                  <time>{new Date(log.timestamp).toLocaleTimeString()}</time>
                </div>
                <p>{log.message}</p>
              </article>
            ))}
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
                  <time>{new Date(alert.timestamp).toLocaleTimeString()}</time>
                </div>
                <p>{alert.message}</p>
              </article>
            ))}
        </div>
      ) : null}
    </aside>
  );
}
