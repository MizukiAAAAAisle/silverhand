import { useMemo } from "react";
import { useWorkspaces, useChannelsAcrossWorkspaces } from "@/features/workspaces/hooks";
import { isMemberChannel } from "@/features/channels/membership";
import {
  buildChannelFilterOptions,
  type ChannelFilterCandidate,
  type ChannelOption,
  type WorkspaceOption,
} from "@/features/task-shell/components/task-filter-bar";
import { isAgentSpace, type WorkspaceOwnership } from "@/features/workspaces/workspace-ownership";

/**
 * Shared filter-option source for BOTH task surfaces — the global Tasks
 * section (`TasksSection`) and the per-conversation Tasks tab
 * (`ChannelTasksTab`). They are the same product concept (a task
 * board filtered by workspace + channel); the only thing that used to differ
 * was the candidate scope — the global section spanned every workspace while the
 * per-conversation tab was limited to its own. That divergence is the bug shiki
 * flagged (#task:1165: the global dropdown listed DM channels, the
 * per-conversation one didn't). Single-
 * sourcing the option set here is the fix; the per-conversation tab just passes a
 * `defaultConversationId` to pre-focus a channel.
 *
 * This yields both the WORKSPACE options (the upstream cascade axis — people-owned
 * workspaces AND agent spaces, each carrying its `owner_agent_id` for the canonical
 * WorkspaceIcon) and the CHANNEL options (each tagged with its owning
 * `workspaceId` so the workspace→channel cascade can scope + clear them,
 * #task:1387).
 *
 * The channel picker is a CHANNEL picker, not an agent picker (shiki
 * #task:1165): the filter value is a single channel id
 * (`place.conversation_id === channelId`), so every row's primary label is the
 * channel TITLE and the SUBTITLE carries the source — the workspace name for a
 * regular channel, the agent's name for an agent-space channel. That's why an
 * agent with multiple channels in its space (e.g. `Mentions` + `Onboarding`)
 * shows as distinct rows that no longer collide on a single label. Rows are
 * still GROUPED by data source (`group: 'workspace' | 'agent_space'`) for the
 * section split, which READS "Agent Spaces" (#task:2044).
 */
export interface TaskFilterOptions {
  /** Upstream cascade axis — people-owned workspaces and agent spaces, sorted by name. */
  workspaceOptions: WorkspaceOption[];
  channelOptions: ChannelOption[];
}

/** Minimal conversation shape the candidate mapper reads. */
interface MappableChannel {
  id: string;
  title: string;
  archived_at: number | null;
}

/**
 * Map ONE workspace's conversation list to channel-filter candidates. Pure
 * so the label/subtitle rule is unit-testable without a query client.
 *
 * Primary label = the channel title (always). Subtitle = the source: the
 * workspace name for a people-owned workspace's channel, the agent's name for an
 * agent-space channel. Each candidate carries `workspaceId` so the workspace→channel
 * cascade can scope and clear channel options (#task:1387). Because the filter value is
 * a channel id, an agent whose space holds several channels surfaces as several
 * rows — distinct by their channel titles, all sharing the agent-name subtitle —
 * instead of N identical rows (the bug shiki flagged in #task:1165).
 */
export function workspaceChannelCandidates(
  workspace: { id: string; name: string } & WorkspaceOwnership,
  channels: MappableChannel[],
): ChannelFilterCandidate[] {
  // The container's own name on either side of the split (#task:2066 retired the
  // agent space's `dm-` prefix, so there is no shape to normalise).
  const sublabel = workspace.name;
  const fromAgentSpace = isAgentSpace(workspace);
  return channels.map((conv) => ({
    id: conv.id,
    workspaceId: workspace.id,
    title: conv.title,
    archived_at: conv.archived_at,
    fromAgentSpace,
    sublabel,
  }));
}

export function useTaskFilterOptions(): TaskFilterOptions {
  const { data: workspaces = [] } = useWorkspaces();
  const channelLists = useChannelsAcrossWorkspaces(
    useMemo(() => workspaces.map((w) => w.id), [workspaces]),
  );

  // Workspace filter offers BOTH people-owned workspaces and agent spaces — the
  // upstream cascade axis (shiki #task:1387 review: match the message-search
  // workspace filter, which lists them too). Each option carries `owner_agent_id`
  // so the dropdown can render the canonical WorkspaceIcon (serif "W" when it is
  // null, the owning agent's avatar otherwise). The cascade matches
  // on `task.place.workspace_id`, so an agent space filters exactly like any other
  // workspace.
  const workspaceOptions = useMemo<WorkspaceOption[]>(
    () =>
      workspaces
        .map((w) => ({
          id: w.id,
          label: w.name,
          owner_agent_id: w.owner_agent_id,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [workspaces],
  );

  const channelOptions = useMemo<ChannelOption[]>(() => {
    // Eligibility (skip archived, dedup, derive the
    // data-source group) is single-sourced in buildChannelFilterOptions;
    // this hook owns only the scope (every member workspace's active
    // channels) and the ordering. Per-workspace label/subtitle mapping is
    // the pure `workspaceChannelCandidates`.
    const candidates: ChannelFilterCandidate[] = workspaces.flatMap((w, i) =>
      workspaceChannelCandidates(
        { id: w.id, name: w.name, owner_agent_id: w.owner_agent_id },
        // Member-scoped aggregate: the discovery union now mixes in
        // active PUBLIC channels the viewer hasn't joined. The Tasks channel
        // filter is a member projection (v1 aggregates stay member-only), so
        // exclude non-members — `isMemberChannel` admits only authoritative
        // `is_member === true`.
        (channelLists[i]?.data ?? []).filter(isMemberChannel),
      ),
    );
    // Group by data source — Workspaces section first, then Agent Spaces — and
    // alphabetical within each group. Tie-break on subtitle so the channels in
    // one agent's space keep a stable order.
    return buildChannelFilterOptions(candidates).sort((a, b) => {
      if (a.group !== b.group) return a.group === "workspace" ? -1 : 1;
      if (a.label !== b.label) return a.label.localeCompare(b.label);
      return (a.sublabel ?? "").localeCompare(b.sublabel ?? "");
    });
  }, [workspaces, channelLists]);

  return { workspaceOptions, channelOptions };
}
