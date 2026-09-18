import { useEffect, useMemo, useState } from "react";
import { Brain, ChevronDown, ChevronUp, Hourglass, Layers, Loader2 } from "lucide-react";
import type { AgentDto, AgentRunState } from "@silverhand/shared";
import { AgentAvatar } from "@/components/agent-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useAgentRunStates } from "@/features/channels/hooks";
import { useAgents } from "@/features/agent-shell/hooks/hooks";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useNav } from "@/router";
import { focusAgentSideSection } from "@/features/agent-shell/components/agent-view";

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
  starting: "Starting…",
  thinking: "Thinking…",
  tool_running: "Thinking…",
  waiting: "Waiting…",
};

const ACTIVITY_SNIPPET_KIND_LABEL: Record<
  NonNullable<AgentRunState["activitySnippetKind"]>,
  string
> = {
  thinking: "Thinking",
  text: "Writing",
  api_response: "Notice",
};

export function activitySnippetKindLabel(
  kind: AgentRunState["activitySnippetKind"],
): string | null {
  return kind ? ACTIVITY_SNIPPET_KIND_LABEL[kind] : null;
}

/**
 * Main-status priority for the collapsed line's subject and for sorting
 * the expanded list. Lower rank = more "foreground". A running tool is
 * the most concrete signal; compaction is a notable transient; thinking
 * / starting are the quiet states. Same rank ties break on most-recent
 * activity (see `pickOrder`).
 */
function statusRank(state: AgentRunState): number {
  if (state.status === "tool_running") return 0;
  if (state.compacting) return 1;
  if (state.status === "thinking") return 2;
  if (state.status === "waiting") return 3;
  if (state.status === "starting") return 4;
  return 5;
}

function pickOrder(a: AgentRunState, b: AgentRunState): number {
  const r = statusRank(a) - statusRank(b);
  if (r !== 0) return r;
  return b.lastActivityAt - a.lastActivityAt; // newer first
}

/**
 * Active run-states for the bubble: non-terminal (drop `idle` / `failed`),
 * optionally restricted to an agent allow-list (the thread follower filter,
 * item 4), then sorted by main-status priority and recency. Pure — exported
 * for tests.
 *
 * `restrictToAgentIds` semantics: `null`/`undefined` = no restriction; a
 * list (even empty) restricts to exactly those agent ids, so an empty list
 * legitimately yields nothing (a thread with no follower agents).
 */
export function selectActiveRunStates(
  runStates: readonly AgentRunState[],
  restrictToAgentIds?: readonly string[] | null,
): AgentRunState[] {
  const restrictSet = restrictToAgentIds ? new Set(restrictToAgentIds) : null;
  return runStates
    .filter((s) => s.status !== "idle" && s.status !== "failed")
    .filter((s) => !restrictSet || restrictSet.has(s.agentId))
    .sort(pickOrder);
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
  if (state.status !== "tool_running") return null;
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
  return agent ? `@${agent.display_name?.trim() || agent.name}` : "@agent";
}

// ── Component ────────────────────────────────────────────────────────────

interface ComposerActivityHeaderProps {
  conversationId: string;
  /** When non-null, only show run-state for these agent ids. Used inside
   *  the ThreadPanel: the run-state stream is channel-scoped (a reply
   *  cluster is not a separate conversation), so without this filter the
   *  bubble would surface agents busy on the main line / other clusters.
   *  Passing the thread's follower agent ids restricts it to participants
   *  of this cluster (item 4). `null`/`undefined` = no restriction. */
  restrictToAgentIds?: readonly string[] | null;
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
  restrictToAgentIds,
}: ComposerActivityHeaderProps): JSX.Element | null {
  const { data: runStates = [] } = useAgentRunStates(conversationId);
  const { data: directoryAgents = [] } = useAgents();
  const [expanded, setExpanded] = useState(false);
  const { openAgentPanel } = useNav();

  const openAgentActivity = (agentId: string): void => {
    focusAgentSideSection(agentId, "activity");
    openAgentPanel(agentId);
  };

  const agentsById = useMemo(() => {
    const m = new Map<string, AgentDto>();
    for (const agent of directoryAgents) m.set(agent.id, agent);
    return m;
  }, [directoryAgents]);

  // Active = non-terminal, optionally restricted to the thread's follower
  // agents (item 4), sorted by main-status priority then recency.
  const active = useMemo(
    () => selectActiveRunStates(runStates, restrictToAgentIds),
    [runStates, restrictToAgentIds],
  );

  // Avatars only for the agents actually shown — not the whole directory.
  const activeAgents = useMemo(() => {
    const ids = new Set(active.map((s) => s.agentId));
    return directoryAgents.filter((a) => ids.has(a.id));
  }, [directoryAgents, active]);
  const agentAvatarUrls = useAgentAvatarObjectUrls(activeAgents);

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
      ? "Compacting"
      : null;
  const snippetKindLabel =
    subject.activitySnippet && !badge
      ? activitySnippetKindLabel(subject.activitySnippetKind)
      : null;
  const SnippetKindIcon =
    subject.activitySnippetKind === "thinking"
      ? Brain
      : subject.activitySnippetKind === "api_response"
        ? Hourglass
        : null;
  const snippet = subject.activitySnippet || STATUS_LABEL[subject.status] || subject.status;
  const extra = active.length - 1;
  const StatusIcon = showCompaction ? Layers : Loader2;

  return (
    <div data-composer-activity="" className="border-b border-border-subtle bg-bg-floating">
      {expanded ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-expanded
            aria-label="Collapse run details"
            className="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-xs text-text-secondary transition-colors hover:bg-bg-elevated/50"
          >
            <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
            <span className="font-medium text-text-secondary">
              Running{active.length > 1 ? ` ${active.length} agents` : ""}
            </span>
            <span className="min-w-0 flex-1" />
            <ChevronUp className="size-3 shrink-0 text-text-muted/60" />
          </button>
          <div className="flex flex-col gap-0.5 px-1 pb-1.5">
            {active.map((state) => (
              <ActivityDetailRow
                key={state.runId}
                state={state}
                agent={agentsById.get(state.agentId)}
                avatarObjectUrl={agentAvatarUrls.get(state.agentId) ?? null}
                onOpenActivity={openAgentActivity}
              />
            ))}
          </div>
        </>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded(true);
            }
          }}
          aria-expanded={false}
          aria-label={`${subjectName} is running — expand run details`}
          title={`${subjectName}: ${snippet}`}
          className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 px-3 text-xs text-text-secondary transition-colors hover:bg-bg-elevated/50"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openAgentActivity(subject.agentId);
            }}
            title={`Open ${subjectName}'s activity`}
            aria-label={`Open ${subjectName}'s activity`}
            className="shrink-0 cursor-pointer focus-outline"
          >
            <AgentAvatar
              runtime={subjectAgent?.runtime ?? "claude"}
              size={AVATAR_PX.xs}
              className="shrink-0"
              avatarObjectUrl={agentAvatarUrls.get(subject.agentId) ?? null}
              alt={subjectAgent?.display_name || subjectAgent?.name}
            />
          </button>
          <StatusIcon
            className={
              "size-3 shrink-0 " + (showCompaction ? "text-text-muted" : "animate-spin text-accent")
            }
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openAgentActivity(subject.agentId);
            }}
            title={`Open ${subjectName}'s activity`}
            className="shrink-0 cursor-pointer font-medium text-accent outline-none focus-visible:underline"
          >
            {subjectName}
          </button>
          {badge ? (
            <span className="shrink-0 rounded border border-border-subtle/70 px-1.5 py-px font-mono text-(length:--text-badge) leading-4 text-text-muted">
              {badge}
            </span>
          ) : null}
          {snippetKindLabel ? (
            <span className="flex shrink-0 items-center gap-1 rounded border border-border-subtle/70 px-1.5 py-px text-(length:--text-badge) leading-4 text-text-muted">
              {SnippetKindIcon ? <SnippetKindIcon className="size-3" /> : null}
              <span>{snippetKindLabel}</span>
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-left text-text-muted">{snippet}</span>
          {extra > 0 ? (
            <span className="shrink-0 rounded-full bg-bg-hover px-1.5 text-(length:--text-badge) leading-4 text-text-muted">
              +{extra}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums text-text-muted/60">
            {formatMs(subjectElapsedMs)}
          </span>
          <ChevronDown className="size-3 shrink-0 text-text-muted/60" />
        </div>
      )}
    </div>
  );
}

function ActivityDetailRow({
  state,
  agent,
  avatarObjectUrl,
  onOpenActivity,
}: {
  state: AgentRunState;
  agent: AgentDto | undefined;
  avatarObjectUrl: string | null;
  onOpenActivity: (agentId: string) => void;
}): JSX.Element {
  const elapsedMs = useLiveMs(state.startedAt);
  const compactionElapsedMs = useLiveMs(state.compactingSince ?? state.startedAt);
  const runtime = agent?.runtime ?? "claude";
  const name = displayNameOf(agent);
  const progressText = state.activitySnippet || STATUS_LABEL[state.status] || state.status;
  const snippetKindLabel = state.activitySnippet
    ? activitySnippetKindLabel(state.activitySnippetKind)
    : null;
  const SnippetKindIcon =
    state.activitySnippetKind === "thinking"
      ? Brain
      : state.activitySnippetKind === "api_response"
        ? Hourglass
        : null;
  const toolEntries = Object.entries(state.toolCallCounts ?? {}).filter(([, count]) => count > 0);
  const compactionText = "Compacting…";
  const CompactionIcon = Layers;

  return (
    <div className="flex w-full min-w-0 items-start gap-2 rounded-(--control-radius) px-2 py-1 text-xs">
      <span className="pt-0.5">
        <button
          type="button"
          onClick={() => onOpenActivity(state.agentId)}
          title={`Open ${name}'s activity`}
          aria-label={`Open ${name}'s activity`}
          className="block shrink-0 cursor-pointer focus-outline"
        >
          <AgentAvatar
            runtime={runtime}
            size={AVATAR_PX.xs}
            avatarObjectUrl={avatarObjectUrl}
            alt={agent?.display_name || agent?.name}
          />
        </button>
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex min-w-0 items-center gap-1.5 leading-5">
          <button
            type="button"
            onClick={() => onOpenActivity(state.agentId)}
            title={`Open ${name}'s activity`}
            className="shrink-0 cursor-pointer font-medium text-accent outline-none focus-visible:underline"
          >
            {name}
          </button>
          <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
          {snippetKindLabel ? (
            <span className="flex shrink-0 items-center gap-1 rounded border border-border-subtle/70 px-1.5 py-px text-(length:--text-badge) leading-4 text-text-muted">
              {SnippetKindIcon ? <SnippetKindIcon className="size-3" /> : null}
              <span>{snippetKindLabel}</span>
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-text-secondary">{progressText}</span>
          <span className="shrink-0 tabular-nums text-text-muted/50">{formatMs(elapsedMs)}</span>
        </span>
        {state.compacting ? (
          <span className="flex min-w-0 items-center gap-1.5 leading-5 text-text-muted">
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
                className="rounded border border-border-subtle/70 px-1.5 py-px font-mono text-(length:--text-badge) leading-4 text-text-muted"
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
