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
  /** Object-URL map keyed by agent id. Owned by the parent (ChannelView)
   *  so a single batch hook drives every activity row's avatar. */
  agentAvatarUrls?: Map<string, string | null>;
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
  agentAvatarUrls,
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
            avatarObjectUrl={agentAvatarUrls?.get(state.agentId) ?? null}
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
  avatarObjectUrl,
  anchorMessageId,
  onJumpToAnchor,
}: {
  state: AgentRunState;
  agent: AgentDto | undefined;
  avatarObjectUrl: string | null;
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
      aria-disabled={!canJump}
      tabIndex={canJump ? 0 : -1}
      onClick={() => {
        if (canJump) onJumpToAnchor();
      }}
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
        'group flex w-full min-w-0 items-start gap-2 rounded-[var(--control-radius)] border border-transparent px-2 py-1 text-left text-xs text-text-muted transition-colors ' +
        (canJump
          ? 'hover:bg-bg-hover/60 hover:text-text-primary'
          : 'cursor-default')
      }
    >
      <span className="pt-0.5">
        <AgentAvatar
          runtime={runtime}
          size={16}
          avatarObjectUrl={avatarObjectUrl}
          alt={agent?.display_name || agent?.name}
        />
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
