import type { SessionEntry } from '../lib/types';

interface SidebarProps {
  sessions: SessionEntry[];
  currentSessionId: string;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
  onToggleArchive: (sessionId: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

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
        <span>Control Plane</span>
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
