import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AgentDto, AgentRunState } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';

// ── Time helpers ─────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

/** Returns elapsed milliseconds since `epochMs`, updating every second. */
function useLiveMs(epochMs: number): number {
  const [delta, setDelta] = useState(() => Date.now() - epochMs);
  useEffect(() => {
    const id = setInterval(() => setDelta(Date.now() - epochMs), 1000);
    return () => clearInterval(id);
  }, [epochMs]);
  return delta;
}

// ── Status label ─────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  starting: '正在启动…',
  thinking: '正在思考…',
  tool_running: '正在思考…',
  // idle / failed are terminal; should not reach here.
};

// ── Component ────────────────────────────────────────────────────────────

interface AgentActivityBubbleProps {
  state: AgentRunState;
  /** Resolved from agentsById — may be absent if the agent list hasn't
   *  loaded yet (renders a generic placeholder in that case). */
  agent: AgentDto | undefined;
}

/**
 * A compact two-row activity indicator rendered below the message list
 * while an agent is running (status = `starting | thinking | tool_running`).
 *
 * Row 1 — Progress line:
 *   spinner + latest `activitySnippet`, falling back to the status label
 *   when no text is available.
 *
 * Row 2 — Tool calls (hidden when `toolCallCounts` is empty/absent):
 *   `3 Read  5 Write` — per-tool invocation counts for the current run.
 */
export function AgentActivityBubble({
  state,
  agent,
}: AgentActivityBubbleProps): JSX.Element {
  const elapsedMs = useLiveMs(state.startedAt);

  const runtime = agent?.runtime ?? 'claude';
  const displayName = agent
    ? `@${agent.display_name?.trim() || agent.name}`
    : '@agent';

  // Row 1 text: prefer activitySnippet, fall back to status label.
  const progressText =
    state.activitySnippet || STATUS_LABEL[state.status] || state.status;

  const toolCallEntries = Object.entries(state.toolCallCounts ?? {});

  return (
    <div className="flex items-start gap-2 px-4 py-1 text-xs text-text-muted">
      {/* Avatar — aligns with row 1 */}
      <div className="mt-0.5 shrink-0">
        <AgentAvatar runtime={runtime} size={16} />
      </div>

      <div className="min-w-0 flex-1">
        {/* Row 1: progress */}
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-medium text-accent">{displayName}</span>

          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="truncate">{progressText}</span>

          <span className="ml-auto shrink-0 tabular-nums text-text-muted/50">
            {formatMs(elapsedMs)}
          </span>
        </div>

        {/* Row 2: all per-tool counts for the current run. */}
        {toolCallEntries.length > 0 ? (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-text-muted/60">
            {toolCallEntries.map(([name, count]) => (
              // Outer span keyed by name — stable position in the list.
              // Inner span keyed by count — remounts on each increment,
              // triggering the tool-badge-bump entrance animation without
              // disrupting React's reconciliation of the surrounding row.
              <span key={name} className="inline-block">
                <span
                  key={count}
                  className="tool-badge-bump min-w-0 max-w-full rounded bg-bg-elevated px-1 py-px font-mono text-[10px]"
                >
                  <span className="tabular-nums">{count}</span>{' '}
                  {name}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
