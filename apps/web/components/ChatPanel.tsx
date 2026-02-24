'use client';

import { useMemo, useState, type RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import type { SessionEntry } from '../lib/types';
import { ToolCard } from './ToolCard';

interface ChatPanelProps {
  session: SessionEntry;
  onSubmitPrompt: (value: string) => Promise<void>;
  onToggleToolExpanded: (messageId: string, toolId: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return `${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

export function ChatPanel({
  session,
  onSubmitPrompt,
  onToggleToolExpanded,
  inputRef,
}: ChatPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = inputValue.trim().length > 0 && !submitting;

  const sortedMessages = useMemo(() => session.messages, [session.messages]);

  const submit = async () => {
    const value = inputValue.trim();
    if (!value || submitting) {
      return;
    }

    setSubmitting(true);
    try {
      await onSubmitPrompt(value);
      setInputValue('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel chatPanel" aria-label="Assistant chat">
      <header className="chatHeader">
        <h2>Operator Assistant</h2>
        <p>Command mode enabled. Use `/help` to list runtime actions.</p>
      </header>

      <div className="chatTranscript" role="log" aria-live="polite">
        {sortedMessages.map((message) => (
          <article key={message.id} className={`chatMessage is-${message.role}`}>
            <div className="chatMeta">
              <span>{message.role}</span>
              <time>{formatTime(message.createdAt)}</time>
            </div>

            <div className="chatBubble">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {message.content || (message.streaming ? '...' : '')}
              </ReactMarkdown>
            </div>

            {message.toolCalls?.length ? (
              <div className="toolList">
                {message.toolCalls.map((tool) => (
                  <ToolCard
                    key={tool.id}
                    tool={tool}
                    onToggleExpanded={() => onToggleToolExpanded(message.id, tool.id)}
                  />
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>

      <form
        className="chatComposer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder="Type /start copy dry or /health"
          rows={3}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />

        <div className="composerFooter">
          <span>Ctrl/Cmd+Enter to send</span>
          <button type="submit" disabled={!canSubmit}>
            {submitting ? 'Running...' : 'Send'}
          </button>
        </div>
      </form>
    </section>
  );
}
