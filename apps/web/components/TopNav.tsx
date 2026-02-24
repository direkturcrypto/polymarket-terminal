import type { ThemeName } from '../lib/types';

interface TopNavProps {
  connectionState: 'connecting' | 'connected' | 'disconnected';
  theme: ThemeName;
  rightPanelOpen: boolean;
  onThemeChange: (theme: ThemeName) => void;
  onToggleRightPanel: () => void;
  onOpenCommandPalette: () => void;
  onToggleMobileSidebar: () => void;
}

export function TopNav(props: TopNavProps) {
  const stateLabel =
    props.connectionState === 'connected'
      ? 'API Connected'
      : props.connectionState === 'connecting'
        ? 'Reconnecting'
        : 'Disconnected';

  return (
    <header className="topnav">
      <button
        className="menuToggle"
        type="button"
        aria-label="Toggle navigation"
        onClick={props.onToggleMobileSidebar}
      >
        Menu
      </button>

      <div className="headlineWrap">
        <h1>Hybrid Console</h1>
        <span className="modeBadge">Live Ops Shell</span>
      </div>

      <div className="topnavActions">
        <button type="button" className="shortcutButton" onClick={props.onOpenCommandPalette}>
          Cmd/Ctrl+K
        </button>

        <select
          className="themeSelect"
          value={props.theme}
          onChange={(event) => props.onThemeChange(event.target.value as ThemeName)}
          aria-label="Theme"
        >
          <option value="dark">Dark</option>
          <option value="oled">OLED</option>
          <option value="cobalt">Cobalt</option>
        </select>

        <button type="button" className="shortcutButton" onClick={props.onToggleRightPanel}>
          {props.rightPanelOpen ? 'Hide Panel' : 'Show Panel'}
        </button>

        <div className={`connectionState is-${props.connectionState}`}>
          <span className="stateDot" aria-hidden="true" />
          <span>{stateLabel}</span>
        </div>
      </div>
    </header>
  );
}
