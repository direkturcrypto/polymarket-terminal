import type { ToolCallEntry } from '../lib/types';

interface ToolCardProps {
  tool: ToolCallEntry;
  onToggleExpanded: () => void;
}

export function ToolCard({ tool, onToggleExpanded }: ToolCardProps) {
  return (
    <article className={`toolCard is-${tool.status}`}>
      <button type="button" className="toolCardHeader" onClick={onToggleExpanded}>
        <span className="toolTitle">{tool.title}</span>
        <span className="toolStatus">{tool.status}</span>
      </button>

      {tool.description ? <p className="toolDescription">{tool.description}</p> : null}

      {tool.expanded && tool.rawOutput ? (
        <pre className="toolRawOutput">
          <code>{tool.rawOutput}</code>
        </pre>
      ) : null}
    </article>
  );
}
