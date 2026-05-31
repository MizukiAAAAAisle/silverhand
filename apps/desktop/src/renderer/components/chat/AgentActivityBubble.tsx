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

interface AgentActivityDockProps {
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
 * Live channel-level activity dock. Rendered as an **out-of-flow overlay**
 * pinned to the bottom of the message area (above the composer), so showing
 * / hiding it and its internal growth (tool badges, compaction line, extra
 * agent rows) never change the scroller's viewport height — eliminating the
 * content judder the old in-flow strip caused.
 *
 * Interaction (option 4): a compact pill by default (avatar stack + spinner
 * + label); hover or focus expands it to the full per-agent detail panel;
 * clicking the pill pins it open while reading. The pill stays out of the
 * way; the detail is one glance away. The matching footer spacer in
 * MessageList reserves the resting pill's height so the last message is
 * never occluded; the expanded panel floats up over earlier history (a
 * transient, user-initiated overlap).
 */
export function AgentActivityDock({
  states,
  agentsById,
  agentAvatarUrls,
  anchorMessageId,
  onJumpToAnchor,
}: AgentActivityDockProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  if (states.length === 0) return <></>;
  const open = hovered || pinned;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-2">
      <div
        className={'pointer-events-auto' + (open ? ' w-full max-w-[1200px]' : '')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        {open ? (
          <div className="w-full rounded-[var(--control-radius)] border border-border-subtle/60 bg-bg-chat/95 px-4 py-2 shadow-lg backdrop-blur">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-text-muted/70">
                {states.length} 个 agent 运行中
              </span>
              <button
                type="button"
                onClick={() => setPinned(p => !p)}
                aria-pressed={pinned}
                aria-label={pinned ? '取消固定活动面板' : '固定展开活动面板'}
                className="rounded px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
                title={pinned ? '取消固定' : '固定展开'}
              >
                {pinned ? '取消固定' : '固定'}
              </button>
            </div>
            <div className="flex flex-col gap-1">
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
        ) : (
          <CollapsedPill
            states={states}
            agentsById={agentsById}
            agentAvatarUrls={agentAvatarUrls}
            onClick={() => setPinned(true)}
          />
        )}
      </div>
    </div>
  );
}

/** Resting state of the dock: a small floating pill with an overlapped
 *  avatar stack, a spinner, and a one-line label. Clicking pins the full
 *  panel open. */
function CollapsedPill({
  states,
  agentsById,
  agentAvatarUrls,
  onClick,
}: {
  states: AgentRunState[];
  agentsById: Map<string, AgentDto>;
  agentAvatarUrls?: Map<string, string | null>;
  onClick: () => void;
}): JSX.Element {
  const shown = states.slice(0, 3);
  const extra = states.length - shown.length;
  const only = states.length === 1 ? states[0] : undefined;
  const label = only
    ? (() => {
        const a = agentsById.get(only.agentId);
        return a ? `@${a.display_name?.trim() || a.name}` : '@agent';
      })()
    : `${states.length} 个 agent`;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${states.length} 个 agent 运行中 — 展开活动详情`}
      title="展开运行详情"
      className="flex items-center gap-2 rounded-full border border-border-subtle/60 bg-bg-chat/95 px-3 py-1.5 text-xs text-text-secondary shadow-md backdrop-blur transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
    >
      <span className="flex -space-x-1.5">
        {shown.map(state => {
          const a = agentsById.get(state.agentId);
          return (
            <span key={state.runId} className="rounded-full ring-1 ring-bg-chat">
              <AgentAvatar
                runtime={a?.runtime ?? 'claude'}
                size={16}
                avatarObjectUrl={agentAvatarUrls?.get(state.agentId) ?? null}
                alt={a?.display_name || a?.name}
              />
            </span>
          );
        })}
        {extra > 0 ? (
          <span className="flex size-4 items-center justify-center rounded-full bg-bg-hover text-[9px] text-text-muted ring-1 ring-bg-chat">
            +{extra}
          </span>
        ) : null}
      </span>
      <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
      <span className="max-w-[160px] truncate">{label}</span>
    </button>
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
