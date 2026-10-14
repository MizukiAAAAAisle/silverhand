import type { AgentRunState } from "@silverhand/shared";

/** What the activity line needs to know about an agent. */
export interface ActivityAgent {
  id: string;
  name: string;
  display_name?: string | null;
}

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

/** A run's state in words, without its streamed snippet. */
export function activityStatusLabel(state: AgentRunState): string {
  return STATUS_LABEL[state.status] || state.status;
}

/**
 * Main-status priority for the line's subject and for sorting the expanded
 * list. Lower rank = more "foreground". A running tool is the most concrete
 * signal; compaction is a notable transient; thinking / starting are the quiet
 * states. Same rank ties break on most-recent activity (see `pickOrder`).
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
  return b.lastActivityAt - a.lastActivityAt;
}

/**
 * Active run-states: non-terminal (drop `idle` / `failed`), optionally
 * restricted to an agent allow-list (a thread's follower agents), then sorted
 * by main-status priority and recency.
 *
 * `restrictToAgentIds`: `null`/`undefined` = no restriction; a list (even
 * empty) restricts to exactly those agent ids, so an empty list legitimately
 * yields nothing (a thread with no follower agents).
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

/**
 * The single tool to show on the line and that tool's own count — never a sum
 * across tools, which would read as "shell ×everything". Prefers the live
 * current tool (`detail`); falls back to the dominant tool by count.
 */
function currentToolSummary(state: AgentRunState): { name: string; count: number } | null {
  if (state.status !== "tool_running") return null;
  const counts = state.toolCallCounts ?? {};
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  let name = state.detail?.trim() || null;
  if (!name || !(name in counts)) {
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

export function activityAgentName(agent: ActivityAgent | undefined): string {
  return agent ? `@${agent.display_name?.trim() || agent.name}` : "@agent";
}

/** The resting line: who leads, how many others run, and what it is doing. */
export interface ActivityLine {
  subject: AgentRunState;
  name: string;
  others: number;
  /** The live tool (with its own count) or compaction; null otherwise. */
  badge: string | null;
  compacting: boolean;
  /** The streamed snippet's kind, shown only when no badge holds the slot. */
  snippetKindLabel: string | null;
  /** The state in words, without the snippet. */
  status: string;
  /** The streamed snippet, else the state in words. */
  progress: string;
}

/** The line for `active` (from `selectActiveRunStates`); null while none runs. */
export function activityLineOf(
  active: readonly AgentRunState[],
  agentOf: (id: string) => ActivityAgent | undefined,
): ActivityLine | null {
  const subject = active[0];
  if (!subject) {
    return null;
  }

  const tool = currentToolSummary(subject);
  const compacting = !!subject.compacting && !tool;
  const badge = tool
    ? tool.count > 1
      ? `${tool.name} ×${tool.count}`
      : tool.name
    : compacting
      ? "Compacting"
      : null;
  const status = activityStatusLabel(subject);

  return {
    subject,
    name: activityAgentName(agentOf(subject.agentId)),
    others: active.length - 1,
    badge,
    compacting,
    snippetKindLabel:
      subject.activitySnippet && !badge
        ? activitySnippetKindLabel(subject.activitySnippetKind)
        : null,
    status,
    progress: subject.activitySnippet || status,
  };
}
