import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Layers, Loader2 } from 'lucide-react';
import type { AgentDto, AgentRunState } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgentRunStates } from '@/features/channels/hooks';

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

// ── Status model ─────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  starting: 'Starting…',
  thinking: 'Thinking…',
  tool_running: 'Thinking…',
};

/**
 * Main-status priority for the collapsed line's subject and for sorting
 * the expanded list. Lower rank = more "foreground". A running tool is
 * the most concrete signal; compaction is a notable transient; thinking
 * / starting are the quiet states. Same rank ties break on most-recent
 * activity (see `pickOrder`).
 */
function statusRank(state: AgentRunState): number {
  if (state.status === 'tool_running') return 0;
  if (state.compacting) return 1;
  if (state.status === 'thinking') return 2;
  if (state.status === 'starting') return 3;
  return 4;
}

function pickOrder(a: AgentRunState, b: AgentRunState): number {
  const r = statusRank(a) - statusRank(b);
  if (r !== 0) return r;
  return b.lastActivityAt - a.lastActivityAt; // newer first
}

interface ToolSummary {
  /** Highest-count tool name, the badge's primary label. */
  primary: string;
  /** Sum of all tool-call counts this run. */
  total: number;
}

function summarizeTools(state: AgentRunState): ToolSummary | null {
  const entries = Object.entries(state.toolCallCounts ?? {}).filter(
    ([, count]) => count > 0,
  );
  if (entries.length === 0) return null;
  let primary = entries[0]![0];
  let max = entries[0]![1];
  let total = 0;
  for (const [name, count] of entries) {
    total += count;
    if (count > max) {
      max = count;
      primary = name;
    }
  }
  return { primary, total };
}

function displayNameOf(agent: AgentDto | undefined): string {
  return agent ? `@${agent.display_name?.trim() || agent.name}` : '@agent';
}

// ── Component ────────────────────────────────────────────────────────────

interface ComposerActivityHeaderProps {
  conversationId: string;
  routeKind: 'channel' | 'thread';
  /** Reused from the Composer's own batch hooks — no extra fetch. */
  agents: AgentDto[];
  agentAvatarUrls: Map<string, string | null>;
}

/**
 * Variant A — agent run-state folded into the Composer's own top chrome.
 *
 * Renders as the first child of the Composer's bordered shell box, sharing
 * its border (no floating overlay, no shadow, no gap). Reads as "the input
 * area is busy", not a debug HUD. The resting state is exactly ONE line
 * with fixed-width slots and a single elastic, truncating middle slot, so
 * it never wraps and never changes height as the agent moves between tool
 * calls / thinking / compacting. Clicking the line morphs it open in place
 * (the textarea is pushed down — content grows, nothing overlays history).
 *
 * Collapsed subject when several agents run: the highest-priority agent
 * (`statusRank`), ties broken by most-recent activity, with a `+N` chip for
 * the rest. Expanding lists every running agent in the same order.
 */
export function ComposerActivityHeader({
  conversationId,
  routeKind,
  agents,
  agentAvatarUrls,
}: ComposerActivityHeaderProps): JSX.Element | null {
  const { data: runStates = [] } = useAgentRunStates(conversationId, routeKind);
  const [expanded, setExpanded] = useState(false);

  const agentsById = useMemo(() => {
    const m = new Map<string, AgentDto>();
    for (const agent of agents) m.set(agent.id, agent);
    return m;
  }, [agents]);

  // Active = non-terminal, sorted by main-status priority then recency.
  const active = useMemo(
    () =>
      runStates
        .filter(s => s.status !== 'idle' && s.status !== 'failed')
        .sort(pickOrder),
    [runStates],
  );

  const subject = active[0];
  // Hook order is fixed regardless of how many agents run; falls back to a
  // harmless epoch when nothing is active (the component returns null then).
  const subjectElapsedMs = useLiveMs(subject?.startedAt ?? Date.now());

  // Collapse automatically when the herd empties so a later run reopens
  // from the resting line, not a stale expanded panel.
  useEffect(() => {
    if (active.length === 0 && expanded) setExpanded(false);
  }, [active.length, expanded]);

  if (!subject) return null;

  const subjectAgent = agentsById.get(subject.agentId);
  const subjectName = displayNameOf(subjectAgent);
  const tools = summarizeTools(subject);
  const badge = subject.compacting
    ? subject.compactionStale
      ? 'Compacting · 慢'
      : 'Compacting'
    : tools
      ? tools.total > 1
        ? `${tools.primary} ×${tools.total}`
        : tools.primary
      : null;
  const snippet =
    subject.activitySnippet || STATUS_LABEL[subject.status] || subject.status;
  const extra = active.length - 1;
  const StatusIcon = subject.compacting
    ? subject.compactionStale
      ? AlertTriangle
      : Layers
    : Loader2;

  return (
    <div
      data-composer-activity=""
      className="border-b border-border-subtle bg-bg-floating"
    >
      {/* Resting line — fixed slots + one elastic, truncating middle. */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        aria-label={
          expanded ? '收起运行详情' : `${subjectName} 运行中 — 展开运行详情`
        }
        title={`${subjectName}: ${snippet}`}
        className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover/50"
      >
        <StatusIcon
          className={
            'size-3 shrink-0 ' +
            (subject.compacting
              ? subject.compactionStale
                ? 'text-warning'
                : 'text-text-muted'
              : 'animate-spin text-accent')
          }
        />
        <span className="shrink-0 font-medium text-accent">{subjectName}</span>
        {badge ? (
          <span className="shrink-0 rounded border border-border-subtle/70 px-1.5 py-px font-mono text-[10px] leading-4 text-text-muted">
            {badge}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-left text-text-muted">
          {snippet}
        </span>
        {extra > 0 ? (
          <span className="shrink-0 rounded-full bg-bg-hover px-1.5 text-[10px] leading-4 text-text-muted">
            +{extra}
          </span>
        ) : null}
        <span className="shrink-0 tabular-nums text-text-muted/60">
          {formatMs(subjectElapsedMs)}
        </span>
        {expanded ? (
          <ChevronUp className="size-3 shrink-0 text-text-muted/60" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-text-muted/60" />
        )}
      </button>

      {/* In-place detail — one row per running agent, same priority order. */}
      {expanded ? (
        <div className="flex flex-col gap-0.5 px-2 pb-1.5">
          {active.map(state => (
            <ActivityDetailRow
              key={state.runId}
              state={state}
              agent={agentsById.get(state.agentId)}
              avatarObjectUrl={agentAvatarUrls.get(state.agentId) ?? null}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActivityDetailRow({
  state,
  agent,
  avatarObjectUrl,
}: {
  state: AgentRunState;
  agent: AgentDto | undefined;
  avatarObjectUrl: string | null;
}): JSX.Element {
  const elapsedMs = useLiveMs(state.startedAt);
  const compactionElapsedMs = useLiveMs(state.compactingSince ?? state.startedAt);
  const runtime = agent?.runtime ?? 'claude';
  const name = displayNameOf(agent);
  const progressText =
    state.activitySnippet || STATUS_LABEL[state.status] || state.status;
  const toolEntries = Object.entries(state.toolCallCounts ?? {}).filter(
    ([, count]) => count > 0,
  );
  const compactionText = state.compactionStale
    ? 'Compaction is taking unusually long'
    : 'Compacting…';
  const CompactionIcon = state.compactionStale ? AlertTriangle : Layers;

  return (
    <div className="flex w-full min-w-0 items-start gap-2 rounded-[var(--control-radius)] px-2 py-1 text-xs">
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
          <span className="shrink-0 font-medium text-accent">{name}</span>
          <Loader2 className="size-3 shrink-0 animate-spin text-text-muted" />
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
        {toolEntries.length > 0 ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {toolEntries.map(([toolName, count]) => (
              <span
                key={`${toolName}:${count}`}
                className="rounded border border-border-subtle/70 px-1.5 py-px font-mono text-[10px] leading-4 text-text-muted"
              >
                <span className="mr-1 text-text-muted/70">{count}</span>
                {toolName}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}
