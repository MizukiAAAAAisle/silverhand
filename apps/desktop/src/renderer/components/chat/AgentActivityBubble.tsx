import { useEffect, useState } from 'react';
import { AlertTriangle, Layers, Loader2 } from 'lucide-react';
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
  starting: 'Starting…',
  thinking: 'Thinking…',
  tool_running: 'Thinking…',
  // idle / failed are terminal; should not reach here.
};

// ── Component ────────────────────────────────────────────────────────────

interface AgentActivityStripProps {
  states: AgentRunState[];
  /** Resolved from agentsById — may be absent if the agent list hasn't
   *  loaded yet (renders a generic placeholder in that case). */
  agentsById: Map<string, AgentDto>;
  anchorMessageId: string | null;
  onJumpToAnchor: () => void;
}

/**
 * Live channel-level activity strip rendered above the composer. It is
 * outside the message scroller so "who is running now" remains visible
 * while the user reads earlier history.
 */
export function AgentActivityStrip({
  states,
  agentsById,
  anchorMessageId,
  onJumpToAnchor,
}: AgentActivityStripProps): JSX.Element {
  if (states.length === 0) return <></>;

  return (
    <div className="shrink-0 border-t border-border-subtle/60 bg-bg-chat px-4 py-2">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-1">
        {states.map(state => (
          <AgentActivityRow
            key={state.runId}
            state={state}
            agent={agentsById.get(state.agentId)}
            anchorMessageId={anchorMessageId}
            onJumpToAnchor={onJumpToAnchor}
          />
        ))}
      </div>
    </div>
  );
}

function AgentActivityRow({
  state,
  agent,
  anchorMessageId,
  onJumpToAnchor,
}: {
  state: AgentRunState;
  agent: AgentDto | undefined;
  anchorMessageId: string | null;
  onJumpToAnchor: () => void;
}): JSX.Element {
  const elapsedMs = useLiveMs(state.startedAt);
  const compactionElapsedMs = useLiveMs(state.compactingSince ?? state.startedAt);

  const runtime = agent?.runtime ?? 'claude';
  const displayName = agent
    ? `@${agent.display_name?.trim() || agent.name}`
    : '@agent';

  // Row 1 text: prefer activitySnippet, fall back to status label.
  const progressText =
    state.activitySnippet || STATUS_LABEL[state.status] || state.status;

  const toolCallEntries = Object.entries(state.toolCallCounts ?? {}).filter(
    ([, count]) => count > 0,
  );
  const compactionText = state.compactionStale
    ? 'Compaction is taking unusually long'
    : 'Compacting…';
  const CompactionIcon = state.compactionStale ? AlertTriangle : Layers;
  const canJump = anchorMessageId !== null;

  return (
    <button
      type="button"
      disabled={!canJump}
      onClick={onJumpToAnchor}
      aria-label={
        canJump
          ? `${displayName} activity, jump to latest user message`
          : `${displayName} activity`
      }
      title={
        canJump
          ? `${displayName}: ${progressText} · jump to latest user message`
          : `${displayName}: ${progressText}`
      }
      className={
        'group flex w-full min-w-0 items-start gap-2 rounded-[6px] border border-transparent px-2 py-1 text-left text-xs text-text-muted transition-colors ' +
        (canJump
          ? 'hover:bg-bg-hover/60 hover:text-text-primary'
          : 'cursor-default')
      }
    >
      <span className="pt-0.5">
        <AgentAvatar runtime={runtime} size={16} />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex min-w-0 items-center gap-1.5 leading-5">
          <span className="shrink-0 font-medium text-accent">{displayName}</span>
          <Loader2 className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 flex-1 truncate text-text-secondary">
            {progressText}
          </span>
          <span className="shrink-0 tabular-nums text-text-muted/50">
            {formatMs(elapsedMs)}
          </span>
        </span>
        {state.compacting ? (
          <span
            className={
              'flex min-w-0 items-center gap-1.5 leading-5 ' +
              (state.compactionStale ? 'text-warning' : 'text-text-muted')
            }
          >
            <CompactionIcon className="size-3 shrink-0" />
            <span className="truncate">{compactionText}</span>
            <span className="shrink-0 tabular-nums text-current/70">
              {formatMs(compactionElapsedMs)}
            </span>
          </span>
        ) : null}
        {toolCallEntries.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {toolCallEntries.map(([toolName, count]) => (
              <span
                key={`${toolName}:${count}`}
                className="tool-badge-bump rounded border border-border-subtle/70 px-1.5 py-px font-mono text-[10px] leading-4 text-text-muted"
              >
                <span className="ml-1 text-text-muted/70">{count} </span>
                {toolName}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
}
