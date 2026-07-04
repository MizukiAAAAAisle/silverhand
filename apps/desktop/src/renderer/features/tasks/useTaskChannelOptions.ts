import { useMemo } from 'react';
import {
  useWorkspaces,
  useChannelsAcrossWorkspaces,
} from '@/features/workspaces/hooks';
import { dmWorkspaceLabel, workspaceDisplayName } from '@/lib/workspace-name';
import {
  buildChannelFilterOptions,
  type ChannelFilterCandidate,
  type ChannelOption,
} from '@/components/tasks/TaskFilterBar';

/**
 * Shared channel-filter source for BOTH task surfaces — the global Tasks
 * pane (`TasksSection`) and the floating workspace drawer
 * (`WorkspaceTasksDrawer`). They are the same product concept (a task
 * board filtered by channel); the only thing that used to differ was the
 * candidate scope — the pane spanned every workspace while the drawer was
 * limited to its own. That divergence is the bug shiki flagged (#task:1165:
 * the pane's dropdown listed DM channels, the drawer's didn't). Single-
 * sourcing the option set here is the fix; the drawer just passes a
 * `defaultConversationId` to pre-focus a channel.
 *
 * This is a CHANNEL picker, not an agent picker (shiki #task:1165): the
 * filter value is a single channel id (`task.channel_id === channelId`), so
 * every row's primary label is the channel TITLE and the SUBTITLE carries
 * the source — the workspace name for a regular channel, `@<agent>` for a
 * DM channel. That's why an agent with multiple DM channels (e.g.
 * `Mentions` + `Onboarding`) shows as distinct rows that no longer collide
 * on a single `@agent` label. Rows are still GROUPED by data source
 * (`group: 'workspace' | 'dm'`) for the section split.
 */
export interface TaskChannelOptions {
  channelOptions: ChannelOption[];
  /** Union of every member workspace's scope ids — feeds `useTasks`'
   *  workspace-level SSE subscription so the cross-workspace board
   *  refreshes without polling. */
  workspaceScopeIds: string[];
}

/** Minimal conversation shape the candidate mapper reads. */
interface MappableChannel {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel';
  archived_at: number | null;
}

/**
 * Map ONE workspace's conversation list to channel-filter candidates. Pure
 * so the label/subtitle rule is unit-testable without a query client.
 *
 * Primary label = the channel title (always). Subtitle = the source: the
 * workspace name for a regular channel, `@<agent>` for a DM channel. Because
 * the filter value is a channel id, an agent that owns multiple DM channels
 * surfaces as multiple rows — distinct by their channel titles, all sharing
 * the `@<agent>` subtitle — instead of N identical `@agent` rows (the bug
 * shiki flagged in #task:1165).
 */
export function workspaceChannelCandidates(
  workspace: { name: string; kind: 'regular' | 'dm' },
  channels: MappableChannel[],
): ChannelFilterCandidate[] {
  const isDm = workspace.kind === 'dm';
  const sublabel = isDm
    ? dmWorkspaceLabel(workspace.name)
    : workspaceDisplayName({ name: workspace.name, kind: workspace.kind });
  return channels.map(conv => ({
    id: conv.id,
    title: conv.title,
    kind: conv.kind,
    archived_at: conv.archived_at,
    fromDmWorkspace: isDm,
    sublabel,
  }));
}

export function useTaskChannelOptions(): TaskChannelOptions {
  const { data: workspaces = [] } = useWorkspaces();
  const channelLists = useChannelsAcrossWorkspaces(
    useMemo(() => workspaces.map(w => w.id), [workspaces]),
  );

  const workspaceScopeIds = useMemo(
    () => [...new Set(workspaces.flatMap(w => w.workspace_scope_ids))],
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
        { name: w.name, kind: w.kind },
        channelLists[i]?.data ?? [],
      ),
    );
    // Group by data source — Workspaces section first, then DMs — and
    // alphabetical within each group. Tie-break on subtitle so an agent's
    // multiple DM channels keep a stable order.
    return buildChannelFilterOptions(candidates).sort((a, b) => {
      if (a.group !== b.group) return a.group === 'workspace' ? -1 : 1;
      if (a.label !== b.label) return a.label.localeCompare(b.label);
      return (a.sublabel ?? '').localeCompare(b.sublabel ?? '');
    });
  }, [workspaces, channelLists]);

  return { channelOptions, workspaceScopeIds };
}
