import { useMemo } from 'react';
import { Bookmark, Clock, Layers } from 'lucide-react';
import dayjs from 'dayjs';
import type { AgentDto, SavedMessageDto } from '@silverhand/shared';
import { Markdown } from '@/components/chat/Markdown';
import { CollectionItemCard } from '@/components/layout/collection-item-card';
import { ChannelIcon } from '@/components/ChannelIcon';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import { AuthorAvatarView, AuthorName } from '@/components/chat/author-avatar-view';
import { presentAuthor } from '@/components/chat/author-presentation';
import { useAuthorAvatarObjectUrls } from '@/components/chat/author-avatar-hooks';
import { AVATAR_PX } from '@/components/avatar-scale';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useSavedMessages, useUnsaveMessage } from '@/features/saved/hooks';
import type { WorkspaceListItem } from '@/features/workspaces/hooks';
import { workspaceDisplayName } from '@/lib/workspace-name';
import { FilterBlock } from '@/components/ui/filter-select';
import { ListRowsSkeleton } from './ListRowsSkeleton';
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
import { paneChrome } from './pane-chrome';

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

/** A Saved card navigates on click, but it wraps fully-interactive message
 *  content: a code-fence Copy button, inline links, and selectable text. The
 *  jump must fire only for a *bare* click — not when the click lands on a
 *  nested interactive control (button / link) or ends a text selection inside
 *  the card. Extracted + exported so the decision branch is unit-tested rather
 *  than presentation-locked (#task:1497). */
export function isBareCardClick(
  target: HTMLElement,
  card: HTMLElement,
  selection: Selection | null,
): boolean {
  if (target.closest('button, a')) return false;
  if (
    selection &&
    !selection.isCollapsed &&
    card.contains(selection.anchorNode)
  ) {
    return false;
  }
  return true;
}

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

  // Identity resolution for each row's meta line (shiki #task:1441). A
  // `workspace_channel` row shows the WORKSPACE's own icon + name (joined live
  // from the workspace list — `SavedPlace` embeds only `workspace_id` +
  // `workspace_kind`, never a frozen name, #task:2055), the CHANNEL's `#` +
  // `place.channel_name`, and the SENDER's avatar.
  const workspacesById = useMemo(
    () => new Map(workspaces.map(w => [w.id, w])),
    [workspaces],
  );
  // A `direct_pair` row wears NO "where" segment at all (shiki #task:2060): a
  // pair is not a place, and standing its counterpart's agent identity in the
  // workspace slot reads as "this lives in that agent" — a place that does not
  // exist. The row's only identity is then its SENDER, which every row already
  // carries. So no pair join here: the counterpart face belongs to the DM pane
  // and the pair list, not to a cross-conversation row's meta line.
  // The agent directory drives only the WorkspaceIcon's DM-avatar (an
  // INDEPENDENT facet — the DM workspace's agent, not the row's author).
  const { data: agents = [] } = useAgents();
  const agentsById = useMemo<ReadonlyMap<string, AgentDto>>(
    () => new Map(agents.map(a => [a.id, a])),
    [agents],
  );
  const dmAgentAvatarUrls = useAgentAvatarObjectUrls(agents);
  // The byline avatar's bytes come STRICTLY from each row's own author DTO
  // (#task:1792 B2) — never a directory join, so a saved message whose author is
  // outside the loaded directory (or deleted) still renders its own avatar.
  const authors = useMemo(() => items.map(i => i.message.author), [items]);
  const { agentAvatarUrls: authorAgentAvatarUrls, humanAvatarUrls: authorHumanAvatarUrls } =
    useAuthorAvatarObjectUrls(authors);

  return (
    <main
      className="flex h-full flex-1 flex-col bg-bg-chat"
      style={{ ...paneChrome, overflow: 'hidden' }}
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
          <ListRowsSkeleton />
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
                workspacesById={workspacesById}
                agentsById={agentsById}
                dmAgentAvatarUrls={dmAgentAvatarUrls}
                authorAgentAvatarUrls={authorAgentAvatarUrls}
                authorHumanAvatarUrls={authorHumanAvatarUrls}
                onJump={() =>
                  onJump(
                    item.place.kind === 'workspace_channel'
                      ? {
                          workspaceId: item.place.workspace_id,
                          channelId: item.place.conversation_id,
                          // New reply-cluster: the saved message carries its own
                          // `thread_root_id`; the cluster pane opens to it.
                          threadRootId: item.message.thread_root_id,
                          messageId: item.message.id,
                        }
                      : {
                          // A direct-pair save has no workspace: the pane opens
                          // the pair straight from its conversation id.
                          channelId: item.place.conversation_id,
                          threadRootId: item.message.thread_root_id,
                          messageId: item.message.id,
                        },
                  )
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
  workspacesById,
  agentsById,
  dmAgentAvatarUrls,
  authorAgentAvatarUrls,
  authorHumanAvatarUrls,
  onJump,
  onUnsave,
}: {
  item: SavedMessageDto;
  /** Workspace records joined by id — the `workspace_channel` arm reads its
   *  workspace out of this to drive the WorkspaceIcon's kind / DM-agent branch
   *  and the live display name. Empty in the brief window before the list
   *  resolves. */
  workspacesById: ReadonlyMap<string, WorkspaceListItem>;
  agentsById: ReadonlyMap<string, AgentDto>;
  /** Directory avatars, for the WorkspaceIcon's DM agent only (independent
   *  facet — NOT the row's author). */
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
  /** Byline avatars derived from the row's own author DTO (#task:1792 B2). */
  authorAgentAvatarUrls: ReadonlyMap<string, string | null>;
  authorHumanAvatarUrls: ReadonlyMap<string, string | null>;
  onJump: () => void;
  onUnsave: () => void;
}): JSX.Element {
  // Author identity flows through the ONE shared seam (#task:1792): the
  // server-authoritative `MessageAuthorDto` → `presentAuthor`, so a deleted
  // author keeps its snapshot name + neutral avatar and an unresolved one
  // degrades to "Unknown …" here exactly as in the stream — never a live
  // directory re-join by `from_*_id`. A saved system message (`author === null`)
  // reads as "System" with a neutral person square.
  const presentation = item.message.author
    ? presentAuthor(item.message.author)
    : null;
  const sender = presentation?.label ?? 'System';
  const when = useMemo(
    () => dayjs(item.saved_at).format('YYYY-MM-DD HH:mm'),
    [item.saved_at],
  );

  // The saved's "where" lives in its discriminated `place` (#task:2055): a
  // `workspace_channel` save is the workspace + channel it sits in, joined live
  // from the viewer's own list — the carrier freezes no workspace name. A
  // `direct_pair` save has no "where" to show (#task:2060), so this arm is the
  // only one that resolves one.
  const place = item.place;
  const workspace =
    place.kind === 'workspace_channel'
      ? workspacesById.get(place.workspace_id) ?? null
      : null;

  return (
    <li>
      {/* The whole card navigates on click, but it wraps fully-interactive
          message content: a code-fence Copy button, inline links, the unsave
          button, and selectable text. Those must keep working, so `onJump`
          fires only for a bare click — suppressed when the click lands on a
          nested interactive control (button / link) or ends a text selection.
          The unsave button also stopPropagation's, so it never reaches here. */}
      <CollectionItemCard
        role="button"
        tabIndex={0}
        onClick={e => {
          if (
            isBareCardClick(
              e.target as HTMLElement,
              e.currentTarget,
              window.getSelection(),
            )
          ) {
            onJump();
          }
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onJump();
          }
        }}
        // Frame + hover come from the shell; each theme paints one
        // `[data-collection-card]:hover` (forza6 = ink border + poster shadow +
        // lift; warm/slack = bg veil + soft lift), so a row hover never flips to
        // the brand hue. Local layout only below.
        className="px-4 py-3"
      >
        {/* Meta line identity segments (shiki #task:1441). A workspace_channel
            save wears three: the WORKSPACE icon + name, the CHANNEL `#` +
            `place.channel_name`, and the SENDER avatar. A direct_pair save
            wears NO where segment at all (shiki #task:2060) — a pair is not a
            place, and its counterpart's agent identity must not stand in the
            workspace slot; the row reads sender + time. Canonical primitives
            throughout, so a row reads like every other identity row.

            No `·` separators (shiki 2026-07-27, the same call as the task card
            meta row in #task:1579): every segment already opens with its own
            glyph, so the glyph + `gap-2` delimit the row and the middots were
            pure ink. The timestamp is the one segment with no identity glyph, so
            it gets a `Clock` — utility scale (14px), a notch under the 16px
            identity glyphs beside it. */}
        <header className="mb-2 flex items-center gap-2 text-xs text-text-muted">
          {place.kind === 'workspace_channel' ? (
            <>
              <span className="inline-flex items-center gap-1 font-medium text-text-primary">
                <WorkspaceIcon
                  kind={workspace?.kind ?? 'regular'}
                  dmAgentId={workspace?.dm_agent_id ?? null}
                  agentsById={agentsById}
                  dmAgentAvatarUrls={dmAgentAvatarUrls}
                />
                {workspace ? workspaceDisplayName(workspace) : ''}
              </span>
              <span className="inline-flex min-w-0 items-center gap-1">
                <ChannelIcon variant="sticker" density="sm" />
                <span className="truncate">{place.channel_name}</span>
              </span>
            </>
          ) : null}
          <span className="inline-flex min-w-0 items-center gap-1">
            <AuthorAvatarView
              avatar={presentation?.avatar ?? { variant: 'neutral-user' }}
              size={AVATAR_PX.xs}
              label={sender}
              agentAvatarUrls={authorAgentAvatarUrls}
              humanAvatarUrls={authorHumanAvatarUrls}
            />
            {/* Author name carries its deleted state through the ONE shared
                primitive (#task:1792 B3); a saved system row has no author DTO
                and reads "System". */}
            {presentation ? (
              <AuthorName presentation={presentation} />
            ) : (
              <span>{sender}</span>
            )}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1">
            <Clock aria-hidden className="size-3.5 shrink-0" />
            {when}
          </span>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onUnsave();
            }}
            className="ml-auto text-accent hover:text-accent-hover"
            title="Remove from saved"
            aria-label="Remove from saved"
          >
            <Bookmark className="size-3.5 fill-current" />
          </button>
        </header>

        <div className="text-sm text-text-primary">
          <Markdown content={item.message.content} />
        </div>
      </CollectionItemCard>
    </li>
  );
}
