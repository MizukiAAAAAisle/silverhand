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
  /** The tool to surface on the collapsed line — the live current tool
   *  (`state.detail`, set on each tool_call) when running, else the
   *  highest-count tool as a fallback. */
  name: string;
  /** That ONE tool's own count — NOT the sum across tools. Summing under
   *  a single tool's name reads as "shell ×everything", which is wrong. */
  count: number;
}

/**
 * Pick the single tool to show on the collapsed line and its own count.
 * Prefers the live current tool (`detail`); falls back to the dominant
 * tool by count. Never sums distinct tools under one name — the full
 * per-tool breakdown lives in the expanded rows.
 */
function currentToolSummary(state: AgentRunState): ToolSummary | null {
  if (state.status !== 'tool_running') return null;
  const counts = state.toolCallCounts ?? {};
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  let name = state.detail?.trim() || null;
  if (!name || !(name in counts)) {
    // Fall back to the dominant tool when `detail` is absent / not yet
    // reflected in the counts map.
    if (entries.length === 0) return name ? { name, count: 0 } : null;
    let max = entries[0]![1];
    name = entries[0]![0];
    for (const [n, c] of entries) {
      if (c > max) {
        max = c;
        name = n;
      }
    }
  }
  return { name, count: counts[name] ?? 0 };
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
  // Main-status priority: a running tool wins over compaction for the
  // badge slot. Show the live tool with ITS OWN count, never a grand
  // total summed across distinct tools.
  const tool = currentToolSummary(subject);
  const showCompaction = subject.compacting && !tool;
  const badge = tool
    ? tool.count > 1
      ? `${tool.name} ×${tool.count}`
      : tool.name
    : showCompaction
      ? subject.compactionStale
        ? 'Compacting · 慢'
        : 'Compacting'
      : null;
  const snippet =
    subject.activitySnippet || STATUS_LABEL[subject.status] || subject.status;
  const extra = active.length - 1;
  const StatusIcon = showCompaction
    ? subject.compactionStale
      ? AlertTriangle
      : Layers
    : Loader2;

  return (
    <div
      data-composer-activity=""
      className="border-b border-border-subtle bg-bg-floating"
    >
      {expanded ? (
        // Expanded: a slim GENERIC header (collapse control only — no
        // per-agent info, so it never duplicates the first detail row) plus
        // one row per running agent. Header icon and row avatars share the
        // same 12px left inset as the collapsed line.
        <>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-expanded
            aria-label="收起运行详情"
            className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover/50"
          >
            <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
            <span className="font-medium text-text-secondary">
              运行中{active.length > 1 ? ` · ${active.length} 个 agent` : ''}
            </span>
            <span className="min-w-0 flex-1" />
            <ChevronUp className="size-3 shrink-0 text-text-muted/60" />
          </button>
          <div className="flex flex-col gap-0.5 px-1 pb-1.5">
            {active.map(state => (
              <ActivityDetailRow
                key={state.runId}
                state={state}
                agent={agentsById.get(state.agentId)}
                avatarObjectUrl={agentAvatarUrls.get(state.agentId) ?? null}
              />
            ))}
          </div>
        </>
      ) : (
        // Resting line — fixed slots + one elastic, truncating middle.
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          aria-label={`${subjectName} 运行中 — 展开运行详情`}
          title={`${subjectName}: ${snippet}`}
          className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-xs text-text-secondary transition-colors hover:bg-bg-hover/50"
        >
          <span className="shrink-0">
            <AgentAvatar
              runtime={subjectAgent?.runtime ?? 'claude'}
              size={16}
              avatarObjectUrl={agentAvatarUrls.get(subject.agentId) ?? null}
              alt={subjectAgent?.display_name || subjectAgent?.name}
            />
          </span>
          <StatusIcon
            className={
              'size-3 shrink-0 ' +
              (showCompaction
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
          <ChevronDown className="size-3 shrink-0 text-text-muted/60" />
        </button>
      )}
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
