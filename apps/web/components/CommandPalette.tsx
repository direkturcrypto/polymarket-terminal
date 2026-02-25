'use client';

import { useEffect, useMemo, useState } from 'react';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onSubmitCommand: (command: string) => void;
  onCreateSession: () => void;
}

const COMMANDS = [
  '/help',
  '/health',
  '/start copy dry',
  '/start mm dry',
  '/start sniper dry',
  '/status copy',
  '/stop copy',
  '/restart mm live',
  '/metrics',
  '/logs',
  '/audit',
  '/kill',
  '/kill-reset',
];

export function CommandPalette({
  open,
  onClose,
  onSubmitCommand,
  onCreateSession,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open]);

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) {
      return COMMANDS;
    }
    return COMMANDS.filter((command) => command.toLowerCase().includes(value));
  }, [query]);

  if (!open) {
    return null;
  }

  return (
    <div className="paletteBackdrop" onClick={onClose} aria-hidden="true">
      <section
        className="palettePanel"
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>Command Palette</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search command"
        />

        <div className="paletteList">
          {filtered.map((command) => (
            <button
              key={command}
              type="button"
              onClick={() => {
                onSubmitCommand(command);
                onClose();
              }}
            >
              {command}
            </button>
          ))}
        </div>

        <footer>
          <button
            type="button"
            onClick={() => {
              onCreateSession();
              onClose();
            }}
          >
            Create session
          </button>
        </footer>
      </section>
    </div>
  );
}
