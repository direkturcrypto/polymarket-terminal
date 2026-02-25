import type { BotStatusMap, LogBotFilter, SessionEntry } from '../lib/types';

interface SidebarProps {
  bots: BotStatusMap;
  logBotFilter: LogBotFilter;
  sessions: SessionEntry[];
  currentSessionId: string;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSelectLogBot: (value: LogBotFilter) => void;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
  onToggleArchive: (sessionId: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const BOT_MENU_OPTIONS: Array<{ value: LogBotFilter; label: string }> = [
  { value: 'all', label: 'All Logs' },
  { value: 'copy', label: 'Copy' },
  { value: 'mm', label: 'MM' },
  { value: 'sniper', label: 'Sniper' },
];

function filterSessions(sessions: SessionEntry[], query: string): SessionEntry[] {
  if (!query.trim()) {
    return sessions;
  }

  const normalized = query.trim().toLowerCase();
  return sessions.filter((session) => {
    if (session.title.toLowerCase().includes(normalized)) {
      return true;
    }

    const lastMessage = session.messages[session.messages.length - 1]?.content ?? '';
    return lastMessage.toLowerCase().includes(normalized);
  });
}

function summarizeRunningBots(bots: BotStatusMap): string {
  const running = Object.values(bots).filter((bot) => bot.state === 'running').length;
  if (running === 0) {
    return 'idle';
  }

  return `${running} running`;
}

function SessionListSection({
  heading,
  sessions,
  currentSessionId,
  onSelectSession,
  onTogglePin,
  onToggleArchive,
  onCloseMobile,
}: {
  heading: string;
  sessions: SessionEntry[];
  currentSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
  onToggleArchive: (sessionId: string) => void;
  onCloseMobile: () => void;
}) {
  if (sessions.length === 0) {
    return null;
  }

  return (
    <section className="sessionSection" aria-label={heading}>
      <h3>{heading}</h3>
      <ul className="sessionList">
        {sessions.map((session) => {
          const active = session.id === currentSessionId;
          const lastMessage =
            session.messages[session.messages.length - 1]?.content ?? 'No messages yet';
          return (
            <li key={session.id}>
              <button
                className={`sessionItem ${active ? 'isActive' : ''}`}
                type="button"
                onClick={() => {
                  onSelectSession(session.id);
                  onCloseMobile();
                }}
              >
                <span className="sessionTitle">{session.title}</span>
                <span className="sessionPreview">{lastMessage}</span>
              </button>

              <div className="sessionActions">
                <button type="button" onClick={() => onTogglePin(session.id)}>
                  {session.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button type="button" onClick={() => onToggleArchive(session.id)}>
                  {session.archived ? 'Restore' : 'Archive'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Sidebar(props: SidebarProps) {
  const filtered = filterSessions(props.sessions, props.searchQuery);
  const pinned = filtered.filter((session) => session.pinned && !session.archived);
  const active = filtered.filter((session) => !session.pinned && !session.archived);
  const archived = filtered.filter((session) => session.archived);

  return (
    <aside className={`sidebar ${props.mobileOpen ? 'isOpen' : ''}`}>
      <div className="brand">
        <strong>Polymarket</strong>
        <span>Mission Roster</span>
      </div>

      <div className="sidebarActions">
        <button type="button" className="newSessionButton" onClick={props.onCreateSession}>
          New Session
        </button>

        <label className="searchBox">
          <span>Search</span>
          <input
            value={props.searchQuery}
            onChange={(event) => props.onSearchQueryChange(event.target.value)}
            placeholder="Find sessions"
          />
        </label>
      </div>

      <div className="sessionScroll">
        <section className="botMenuSection" aria-label="Bot log filters">
          <h3>Bot Logs</h3>
          <div className="botMenuList">
            {BOT_MENU_OPTIONS.map((option) => {
              const active = option.value === props.logBotFilter;
              const botState =
                option.value === 'all'
                  ? undefined
                  : props.bots[option.value as Exclude<LogBotFilter, 'all' | 'api'>].state;
              const botMode =
                option.value === 'all'
                  ? undefined
                  : props.bots[option.value as Exclude<LogBotFilter, 'all' | 'api'>].mode;
              const meta =
                option.value === 'all'
                  ? summarizeRunningBots(props.bots)
                  : `${botState} · ${botMode}`;

              return (
                <button
                  key={option.value}
                  type="button"
                  className={`botMenuItem ${active ? 'isActive' : ''} ${botState ? `is-${botState}` : ''}`}
                  onClick={() => {
                    props.onSelectLogBot(option.value);
                    props.onCloseMobile();
                  }}
                >
                  <span className="botMenuName">{option.label}</span>
                  <span className="botMenuMeta">{meta}</span>
                </button>
              );
            })}
          </div>
        </section>

        <SessionListSection
          heading="Pinned"
          sessions={pinned}
          currentSessionId={props.currentSessionId}
          onSelectSession={props.onSelectSession}
          onTogglePin={props.onTogglePin}
          onToggleArchive={props.onToggleArchive}
          onCloseMobile={props.onCloseMobile}
        />

        <SessionListSection
          heading="Active"
          sessions={active}
          currentSessionId={props.currentSessionId}
          onSelectSession={props.onSelectSession}
          onTogglePin={props.onTogglePin}
          onToggleArchive={props.onToggleArchive}
          onCloseMobile={props.onCloseMobile}
        />

        <SessionListSection
          heading="Archived"
          sessions={archived}
          currentSessionId={props.currentSessionId}
          onSelectSession={props.onSelectSession}
          onTogglePin={props.onTogglePin}
          onToggleArchive={props.onToggleArchive}
          onCloseMobile={props.onCloseMobile}
        />
      </div>
    </aside>
  );
}
