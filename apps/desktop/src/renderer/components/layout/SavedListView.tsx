import { useMemo } from 'react';
import { Bookmark, Hash, Layers } from 'lucide-react';
import dayjs from 'dayjs';
import type { SavedMessageDto } from '@silverhand/shared';
import { Markdown } from '@/components/chat/Markdown';
import { useSavedMessages, useUnsaveMessage } from '@/features/saved/hooks';
import { useUsersById, makeUserNameResolver } from '@/features/users/hooks';
import { formatUserDisplayName } from '@/lib/current-user';
import type { WorkspaceListItem } from '@/features/workspaces/hooks';
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

/** Saved-view filter selection. Lifted to App so it survives pane switches
 *  for the app session (shiki #task:1258 follow-up) — NOT persisted, so a
 *  restart clears it back to the default. */
export interface SavedFilterState {
  workspace: WorkspaceFilterValue;
  date: DateFilterValue;
}

export const SAVED_FILTER_DEFAULT: SavedFilterState = {
  workspace: 'all',
  date: 'all',
};

interface SavedListViewProps {
  workspaces: WorkspaceListItem[];
  /** Filter selection, owned by App so it persists across pane switches
   *  within the session (see SavedFilterState). */
  filter: SavedFilterState;
  onFilterChange: (next: SavedFilterState) => void;
  /** Called when the user clicks a saved entry. The parent owns view
   *  routing — flips back to channel view, selects the workspace +
   *  channel, and forwards the message id to the next ChannelView
   *  render so it can scroll + flash. */
  onJump: (params: {
    workspaceId?: string;
    channelId: string;
    threadRootId?: string | null;
    messageId: string;
  }) => void;
}

export function SavedListView({
  workspaces,
  filter,
  onFilterChange,
  onJump,
}: SavedListViewProps): JSX.Element {
  const unsave = useUnsaveMessage();

  // Same filter form as ArchivedChannelsPanel (shiki #task:1258): Workspace +
  // Date, sharing that panel's WorkspaceFilterSelect (identical item design +
  // canonical workspace data source) and DateFilterSelect (same recency option
  // semantics). No Sender axis. State is App-owned (controlled) so switching
  // panes and coming back keeps the selection for the session.
  const { workspace, date } = filter;
  const setWorkspace = (next: WorkspaceFilterValue) =>
    onFilterChange({ ...filter, workspace: next });
  const setDate = (next: DateFilterValue) =>
    onFilterChange({ ...filter, date: next });
  const wsId = workspaceFilterId(workspace);
  const since = useMemo(() => dateFilterSince(date), [date]);

  // Filtering is SERVER-SIDE: the query carries workspace_id + since so the
  // backend narrows the FULL saved set, not a client slice of the LIMIT-200
  // window (which would silently drop older history).
  const { data, isLoading } = useSavedMessages({ workspaceId: wsId, since });
  const items = useMemo(() => data ?? [], [data]);
  const hasFilters = workspace !== 'all' || date !== 'all';
  // Keep the filter row visible whenever a filter is active, even if it yields
  // zero rows — else filtering to empty would hide the controls and trap the
  // user with no way to clear.
  const showFilters = hasFilters || items.length > 0;

  return (
    <main
      className="flex h-full flex-1 flex-col bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
    >
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <Bookmark className="size-3.5 fill-current text-accent" />
        <span className="font-serif text-sm font-semibold text-text-primary">
          Saved
        </span>
        {data ? (
          <span className="text-xs tabular-nums text-text-muted">
            {items.length}
          </span>
        ) : null}
      </header>

      {showFilters ? (
        <section className="shrink-0 border-b border-border-subtle px-4 py-3">
          <div className="flex flex-wrap items-end gap-3">
            <FilterBlock label="Workspace" className="w-full sm:w-72">
              <WorkspaceFilterSelect
                value={workspace}
                workspaces={workspaces}
                onChange={setWorkspace}
                allIcon={<Layers className="size-3.5" />}
              />
            </FilterBlock>
            <FilterBlock label="Saved date" className="w-full sm:w-48">
              <DateFilterSelect
                value={date}
                onChange={setDate}
                ariaLabel="Saved date filter"
              />
            </FilterBlock>
          </div>
        </section>
      ) : null}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <div className="text-sm text-text-muted">加载中…</div>
        ) : items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">
            {hasFilters ? 'No matches' : 'No saved messages'}
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map(item => (
              <SavedItem
                key={item.id}
                item={item}
                onJump={() =>
                  onJump({
                    workspaceId: item.workspace_id,
                    channelId: item.channel_id,
                    // New reply-cluster: the saved message carries its own
                    // `thread_root_id`; the cluster pane opens to it.
                    threadRootId: item.message.thread_root_id,
                    messageId: item.message.id,
                  })
                }
                onUnsave={() => unsave.mutate(item.message.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function SavedItem({
  item,
  onJump,
  onUnsave,
}: {
  item: SavedMessageDto;
  onJump: () => void;
  onUnsave: () => void;
}): JSX.Element {
  // Multi-human audit 2026-06-03 #task:857 P0.10: resolve the saved
  // message's author against the global directory so it renders as the
  // human's display name instead of a raw uuid.
  const usersById = useUsersById();
  const userResolver = useMemo(() => makeUserNameResolver(usersById), [usersById]);
  const sender = useMemo(() => {
    if (item.message.from_kind === 'user') {
      return formatUserDisplayName(item.message.from_user_id, userResolver);
    }
    if (item.agent_name) return `@${item.agent_name}`;
    return '@agent';
  }, [item, userResolver]);
  const when = useMemo(
    () => dayjs(item.saved_at).format('YYYY-MM-DD HH:mm'),
    [item.saved_at],
  );

  return (
    <li>
      {/* The whole card is clickable. Bookmark/unsave is a nested button —
          stopPropagation prevents it from firing the jump. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onJump}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onJump();
          }
        }}
        data-list-row
        className={
          // Row card identity is token-driven and shared verbatim with the
          // Search / Archived list rows so all three read identically per
          // theme (radius `--row-radius`, border `--control-border-width`).
          // Hover is NOT painted here — it's a per-theme structural signal
          // in each theme's CSS via `[data-list-row]:hover` (forza6 = ink
          // border + poster shadow + lift; warm/slack = border deepen + soft
          // lift), so a row hover never flips to the brand hue or a bg wash.
          'rounded-[var(--row-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating px-4 py-3 transition'
        }
      >
        <header className="mb-2 flex items-center gap-2 text-xs text-text-muted">
          <span className="inline-flex items-center gap-1 font-medium text-text-primary">
            <Hash data-channel-icon className="size-3.5" />
            {item.workspace_name}
          </span>
          <span>·</span>
          <span className="truncate">{item.conversation_title}</span>
          <span>·</span>
          <span>{sender}</span>
          <span>·</span>
          <span>{when}</span>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onUnsave();
            }}
            className="ml-auto text-accent hover:text-accent-hover"
            title="取消保存"
            aria-label="取消保存"
          >
            <Bookmark className="size-3.5 fill-current" />
          </button>
        </header>

        <div className="text-sm text-text-primary">
          <Markdown content={item.message.content} />
        </div>
      </div>
    </li>
  );
}
