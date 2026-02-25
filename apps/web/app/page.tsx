'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { ChatPanel } from '../components/ChatPanel';
import { CommandPalette } from '../components/CommandPalette';
import { RightPanel } from '../components/RightPanel';
import { Sidebar } from '../components/Sidebar';
import { TopNav } from '../components/TopNav';
import { getAlerts, getHealth, getLogs } from '../lib/api';
import { createStreamConnection } from '../lib/stream';
import { useAppStore } from '../lib/store';
import { formatUtcTime } from '../lib/utils';

export default function Page() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const sessions = useAppStore((state) => state.sessions);
  const currentSessionId = useAppStore((state) => state.currentSessionId);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const connectionState = useAppStore((state) => state.connectionState);
  const commandPaletteOpen = useAppStore((state) => state.commandPaletteOpen);
  const rightPanelOpen = useAppStore((state) => state.rightPanelOpen);
  const logBotFilter = useAppStore((state) => state.logBotFilter);
  const theme = useAppStore((state) => state.theme);
  const bots = useAppStore((state) => state.bots);
  const logs = useAppStore((state) => state.logs);
  const alerts = useAppStore((state) => state.alerts);

  const hydrateFromStorage = useAppStore((state) => state.hydrateFromStorage);
  const setTheme = useAppStore((state) => state.setTheme);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const setConnectionState = useAppStore((state) => state.setConnectionState);
  const createSession = useAppStore((state) => state.createSession);
  const selectSession = useAppStore((state) => state.selectSession);
  const setLogBotFilter = useAppStore((state) => state.setLogBotFilter);
  const togglePinSession = useAppStore((state) => state.togglePinSession);
  const toggleArchiveSession = useAppStore((state) => state.toggleArchiveSession);
  const submitPrompt = useAppStore((state) => state.submitPrompt);
  const clearCurrentSession = useAppStore((state) => state.clearCurrentSession);
  const toggleToolExpanded = useAppStore((state) => state.toggleToolExpanded);
  const ingestStreamEvent = useAppStore((state) => state.ingestStreamEvent);
  const toggleRightPanel = useAppStore((state) => state.toggleRightPanel);
  const setCommandPaletteOpen = useAppStore((state) => state.setCommandPaletteOpen);

  const currentSession = useMemo(() => {
    return sessions.find((session) => session.id === currentSessionId) ?? sessions[0];
  }, [sessions, currentSessionId]);

  const botList = useMemo(() => Object.values(bots), [bots]);
  const runningBots = useMemo(
    () => botList.filter((bot) => bot.state === 'running').length,
    [botList],
  );
  const errorBots = useMemo(() => botList.filter((bot) => bot.state === 'error').length, [botList]);
  const dryBots = useMemo(() => botList.filter((bot) => bot.mode === 'dry').length, [botList]);

  useEffect(() => {
    hydrateFromStorage();
  }, [hydrateFromStorage]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-dark', 'theme-oled', 'theme-cobalt');
    root.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    const disconnect = createStreamConnection({
      onStateChange: (state) => setConnectionState(state),
      onEvent: (event) => ingestStreamEvent(event),
      onError: (message) => {
        console.error(message);
      },
    });

    return disconnect;
  }, [setConnectionState, ingestStreamEvent]);

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeSnapshot = async () => {
      try {
        const [health, logsResponse, alertsResponse] = await Promise.all([
          getHealth(),
          getLogs(200),
          getAlerts(100),
        ]);

        if (cancelled) {
          return;
        }

        useAppStore.setState((state) => {
          const nextBots = { ...state.bots };

          for (const status of health.bots) {
            nextBots[status.bot] = status;
          }

          return {
            bots: nextBots,
            logs: logsResponse.logs.slice(-300),
            alerts: alertsResponse.alerts.slice(-100),
          };
        });
      } catch (error) {
        console.error('Failed to load initial runtime snapshot', error);
      }
    };

    void loadRuntimeSnapshot();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (!command) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }

      if (key === 'n') {
        event.preventDefault();
        createSession();
      }

      if (key === 'l') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [createSession, setCommandPaletteOpen]);

  if (!currentSession) {
    return null;
  }

  return (
    <div className="shell">
      <div
        className={`sheetBackdrop ${mobileSidebarOpen ? 'isOpen' : ''}`}
        aria-hidden="true"
        onClick={() => setMobileSidebarOpen(false)}
      />

      <Sidebar
        bots={bots}
        logBotFilter={logBotFilter}
        sessions={sessions}
        currentSessionId={currentSession.id}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onSelectLogBot={setLogBotFilter}
        onCreateSession={createSession}
        onSelectSession={selectSession}
        onTogglePin={togglePinSession}
        onToggleArchive={toggleArchiveSession}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      <div className="workspace">
        <TopNav
          connectionState={connectionState}
          theme={theme}
          rightPanelOpen={rightPanelOpen}
          onThemeChange={setTheme}
          onToggleRightPanel={toggleRightPanel}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onToggleMobileSidebar={() => setMobileSidebarOpen((value) => !value)}
        />

        <div className={`contentGrid ${rightPanelOpen ? '' : 'isRightPanelHidden'}`}>
          <main className="mainArea">
            <section className="panel workspacePanel">
              <header className="workspaceHeader">
                <div className="workspaceHeaderLeft">
                  <h2>Bot Control Center</h2>
                </div>

                <div className="summaryStrip" aria-label="Runtime summary">
                  <article className="summaryChip">
                    <span>Running</span>
                    <strong>{runningBots}</strong>
                  </article>
                  <article className="summaryChip">
                    <span>Dry</span>
                    <strong>{dryBots}</strong>
                  </article>
                  <article className={`summaryChip ${errorBots > 0 ? 'isError' : ''}`}>
                    <span>Errors</span>
                    <strong>{errorBots}</strong>
                  </article>
                </div>
              </header>

              <div className="botQuickGrid">
                {botList.map((bot) => (
                  <article key={bot.bot} className={`quickBotCard is-${bot.state}`}>
                    <header>
                      <h3>{bot.bot.toUpperCase()}</h3>
                      <span className="quickBotBadge">{bot.state}</span>
                    </header>
                    <p className="quickBotMeta">
                      Mode <strong>{bot.mode}</strong>
                      {'  ·  '}
                      {formatUtcTime(bot.updatedAt, 'minutes')}
                    </p>
                    <div className="quickBotActions">
                      <button
                        type="button"
                        className="quickActionPrimary"
                        onClick={() => void submitPrompt(`/start ${bot.bot} dry`)}
                      >
                        Dry
                      </button>
                      <button
                        type="button"
                        className="quickActionLive"
                        onClick={() => void submitPrompt(`/start ${bot.bot} live`)}
                      >
                        Live
                      </button>
                      <button
                        type="button"
                        className="quickActionGhost"
                        onClick={() => void submitPrompt(`/stop ${bot.bot}`)}
                      >
                        Stop
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <ChatPanel
              session={currentSession}
              onSubmitPrompt={submitPrompt}
              onClearSession={clearCurrentSession}
              onToggleToolExpanded={toggleToolExpanded}
              inputRef={inputRef}
            />
          </main>

          {rightPanelOpen ? (
            <RightPanel
              bots={bots}
              logs={logs}
              alerts={alerts}
              connectionState={connectionState}
              logBotFilter={logBotFilter}
              onLogBotFilterChange={setLogBotFilter}
            />
          ) : null}
        </div>
      </div>

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onSubmitCommand={(command) => {
          void submitPrompt(command);
        }}
        onCreateSession={createSession}
      />
    </div>
  );
}
