import { useMemo } from 'react';
import dayjs from 'dayjs';
import { Archive, ArchiveRestore } from 'lucide-react';
import type { ArchivedChannelListItemDto } from '@silverhand/shared';
import { ChannelIcon } from '@/components/ChannelIcon';
import { CollectionItemCard } from '@/components/layout/collection-item-card';
import {
  useArchiveChannel,
  useArchivedChannelsIndex,
  type WorkspaceListItem,
} from '@/features/workspaces/hooks';
import { dmWorkspaceLabel } from '@/lib/workspace-name';
import { FilterBlock } from '@/components/ui/filter-select';
import {
  WorkspaceFilterSelect,
  workspaceFilterId,
  type WorkspaceFilterValue,
} from '@/components/ui/workspace-filter-select';
import {
  DateFilterSelect,
  dateFilterSince,
  type DateFilterValue,
} from '@/components/ui/date-filter-select';
import { ListRowsSkeleton } from './ListRowsSkeleton';

/** Archived-view filter selection. Lifted to App so it survives pane
 *  switches for the app session (shiki #task:1259) — NOT persisted, so a
 *  restart clears it back to the default. Mirrors SavedFilterState. */
export interface ArchivedFilterState {
  workspace: WorkspaceFilterValue;
  date: DateFilterValue;
}

export const ARCHIVED_FILTER_DEFAULT: ArchivedFilterState = {
  workspace: 'all',
  date: 'all',
};

interface ArchivedChannelsPanelProps {
  workspaces: WorkspaceListItem[];
  /** Filter selection, owned by App so it persists across pane switches
   *  within the session (see ArchivedFilterState). */
  filter: ArchivedFilterState;
  onFilterChange: (next: ArchivedFilterState) => void;
  onOpenChannel: (workspaceId: string, channelId: string) => void;
}

export function ArchivedChannelsPanel({
  workspaces,
  filter,
  onFilterChange,
  onOpenChannel,
}: ArchivedChannelsPanelProps): JSX.Element {
  // App-owned (controlled) filter state so switching panes and returning
  // keeps the selection for the session (#task:1259).
  const { workspace: workspaceFilter, date: dateFilter } = filter;
  const setWorkspaceFilter = (next: WorkspaceFilterValue) =>
    onFilterChange({ ...filter, workspace: next });
  const setDateFilter = (next: DateFilterValue) =>
    onFilterChange({ ...filter, date: next });
  // Both collections feed this recovery index (#task:1145): regular
  // workspaces' archived channels AND agent_home (DM) workspaces' archived
  // dm_channels. The backend aggregate is channel-like, so the panel offers
  // both as filter scopes and subscribes to both for live invalidation —
  // otherwise an archived DM would be unfindable/unrestorable from the
  // default Archived entry.
  const filterableWorkspaces = useMemo(
    () =>
      workspaces.filter(
        workspace => workspace.kind === 'regular' || workspace.kind === 'dm',
      ),
    [workspaces],
  );
  const workspaceScopeIds = useMemo(
    () => filterableWorkspaces.map(workspace => workspace.id),
    [filterableWorkspaces],
  );
  const workspaceId = workspaceFilterId(workspaceFilter);
  const since = useMemo(() => dateFilterSince(dateFilter), [dateFilter]);
  const { data: channels = [], isFetching, isLoading } = useArchivedChannelsIndex({
    workspaceId,
    since,
    workspaceScopeIds,
  });
  const archiveChannel = useArchiveChannel(null);
  const hasFilters = workspaceFilter !== 'all' || dateFilter !== 'all';

  return (
    <main
      className="flex h-full min-w-0 flex-1 flex-col bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
    >
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <Archive className="size-3.5 text-accent" />
        <span className="font-serif text-sm font-semibold text-text-primary">
          Archived Channels
        </span>
        <span className="text-xs tabular-nums text-text-muted">{channels.length}</span>
        {isFetching ? (
          <span className="ml-auto text-xs text-text-muted">Refreshing…</span>
        ) : null}
      </header>

      <section className="shrink-0 border-b border-border-subtle px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterBlock label="Workspace" className="w-full sm:w-72">
            <WorkspaceFilterSelect
              value={workspaceFilter}
              workspaces={filterableWorkspaces}
              onChange={setWorkspaceFilter}
              allIcon={<Archive className="size-3.5" />}
              showArchivedSuffix
            />
          </FilterBlock>
          <FilterBlock label="Archived date" className="w-full sm:w-48">
            <DateFilterSelect
              value={dateFilter}
              onChange={setDateFilter}
              ariaLabel="Archived date filter"
            />
          </FilterBlock>
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <ListRowsSkeleton withIcon />
        ) : channels.length === 0 ? (
          <EmptyState
            text={
              hasFilters
                ? 'No archived channels match these filters'
                : 'No archived channels'
            }
          />
        ) : (
          <ul className="space-y-2">
            {channels.map(item => (
              <ArchivedChannelRow
                key={item.channel.id}
                item={item}
                restorePending={archiveChannel.isPending}
                onOpen={() => {
                  const target = archivedRowOpenTarget(item);
                  onOpenChannel(target.workspaceId, target.channelId);
                }}
                onRestore={() =>
                  archiveChannel.mutate({
                    channelId: item.channel.id,
                    archived: false,
                    workspaceId: item.workspace.id,
                  })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function ArchivedChannelRow({
  item,
  restorePending,
  onOpen,
  onRestore,
}: {
  item: ArchivedChannelListItemDto;
  restorePending: boolean;
  onOpen: () => void;
  onRestore: () => void;
}): JSX.Element {
  const archivedAt = item.channel.archived_at
    ? dayjs(item.channel.archived_at).format('YYYY-MM-DD HH:mm')
    : 'Unknown archive date';

  return (
    <li>
      <CollectionItemCard className="flex min-w-0 items-stretch">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left"
        >
          <span data-collection-card-icon className="flex size-8 shrink-0 items-center justify-center text-text-muted">
            <ChannelIcon variant="sticker" density="lg" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span className="font-medium text-text-primary">
                {archivedRowWorkspaceLabel(item)}
              </span>
              {item.workspace.archived_at !== null ? (
                <>
                  <span>·</span>
                  <span>archived workspace</span>
                </>
              ) : null}
            </span>
            <span className="mt-1 block truncate text-sm font-medium text-text-primary">
              {item.channel.title}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span>Archived {archivedAt}</span>
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onRestore();
          }}
          disabled={restorePending}
          className="m-3 ml-0 inline-flex shrink-0 items-center gap-1.5 self-center rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:border-[color:var(--border-control-hover)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Restore ${item.channel.title}`}
          title="Restore channel"
        >
          <ArchiveRestore className="size-3.5" />
          Restore
        </button>
      </CollectionItemCard>
    </li>
  );
}

function EmptyState({ text }: { text: string }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
      {text}
    </div>
  );
}

/**
 * Workspace label for an archived row's context (#task:1145, label converged
 * #task:1156). A regular `channel` row shows its bare workspace name; a
 * `dm_channel` row shows `@<agentName>` — the same handle the filter dropdown
 * shows (one shared `dmWorkspaceLabel`). The workspace RAIL is the one
 * exception: it shows the agent's raw display name, no `@` (#task:1768) — a
 * recognition surface, not a handle ref. The DM name arrives bare here
 * (`insertAgentHome` sets `name = agent.name`); `dmWorkspaceLabel` also strips
 * the `dm-` UI prefix the dropdown shape carries, so both normalize to the
 * same handle.
 */
export function archivedRowWorkspaceLabel(
  item: ArchivedChannelListItemDto,
): string {
  return item.channel.kind === 'dm_channel'
    ? dmWorkspaceLabel(item.workspace.name)
    : item.workspace.name;
}

/** Nav target for opening an archived row. Always the channel's OWN
 *  workspace — for a DM row that's the agent_home workspace (the aggregate
 *  sets `workspace.id = conversation.workspace_id`), NOT whatever workspace
 *  is currently selected. The destination workspace then loads its archived
 *  channel-like list (`useArchivedChannelsForWorkspace`, now enabled for DM)
 *  so the row resolves to a real conversation instead of a blank pane
 *  (#task:1145). Pure so the "dm row → agent_home ws + dm_channel" contract
 *  is unit-testable without rendering. */
export function archivedRowOpenTarget(item: ArchivedChannelListItemDto): {
  workspaceId: string;
  channelId: string;
} {
  return { workspaceId: item.workspace.id, channelId: item.channel.id };
}
