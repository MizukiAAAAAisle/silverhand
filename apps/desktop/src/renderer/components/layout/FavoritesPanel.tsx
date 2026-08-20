import { useMemo } from 'react';
import { Bell, Copy, Star } from 'lucide-react';
import type {
  ChannelAttentionMode,
  ChannelAttentionModeRowDto,
  FavoriteRowDto,
} from '@silverhand/shared';
import { useSortable } from '@dnd-kit/sortable';
import { ChannelIcon } from '@/components/ChannelIcon';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
  AppContextMenuSub,
} from '@/components/menus/AppContextMenu';
import { useFavorites, useUnstarFavorite } from '@/features/favorites/hooks';
import { useAttentionModesAcrossWorkspaces } from '@/features/attention/hooks';
import type { FavoritesWatchScope } from '@/lib/home-grouping';
import { useSetSortMode } from '@/features/workspaces/hooks';
import { channelRowBadge } from '@/lib/attention-mode';
import { conversationSelectionTier } from '@/lib/rail-selection';
import { sortModeOf } from '@/lib/viewer-sort';
import { ChannelAttentionMenuItems } from '@/components/layout/ChannelAttentionSurfaces';
import { SortModeMenu } from '@/components/layout/SortModeMenu';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
  useListDragSort,
} from '@/components/layout/list-drag-sort';
import {
  ConversationRowLayout,
  MutedMarker,
  SidebarSection,
  UnreadBadge,
  copyConversationName,
} from './sidebar-shared';

/** The favorites list's own sort namespace. A single FLAT group (`favorites`),
 *  list-wide [recent|manual] toggle — the wire group name must equal the backend
 *  `legalGroups('favorites') = ['favorites']`, and the scope is list-wide (no
 *  per-group axis), exactly like the channel sidebar (#task:1252 / #task:1254). */
const FAVORITES_LIST_KEY = 'favorites';
const FAVORITES_GROUP = 'favorites';

/**
 * The sidebar's STARRED section — the viewer's GLOBAL favorites list (#task:1253),
 * a first-class SORTABLE list (#task:1254).
 *
 * SCOPE (#task:1888, shiki-approved #task:1887): STARRED holds CONVERSATIONS only —
 * both open- and fixed-roster conversations. Containers (workspace / agent space)
 * have no star at all
 * (#task:1900), so the list cannot receive one: what belongs permanently in reach is
 * the handful of rooms you actually work in, not a second rail of containers.
 *
 * EXCLUSIVE (load-bearing — mirrors shared `api/favorites.ts` + docs/list-sort-v1.md):
 * a starred conversation appears HERE and NOWHERE else, MOVED out of its parent's
 * channel list via `viewer_sort.entries[].starred_at` (see lib/home-grouping). Slack
 * "move", chosen over the old additive overlay because one entity in two places meant
 * every per-entity signal (unread, tier, silence) had to stay in sync in both — a
 * drift source. STARRED owns PRESENCE + ORDER only, never BEHAVIOR: open, selection,
 * badge and attention all delegate to the same authorities the parent's row uses.
 *
 * ROW: byte-identical to the row this conversation has under its own workspace —
 * the channel's `#` sticker, then the title. It had led with the PARENT's glyph, on
 * the theory that a global list needs a source cue to tell two `#general`s apart;
 * that theory was wrong in practice, because `WorkspaceIcon`'s regular branch is a
 * literal `W`, so every regular parent rendered the SAME badge and disambiguated
 * nothing while taking the loudest element in the section (shiki: 「starred 的 icon
 * 不对」, 2026-08-08). Source now reaches the user through the row's `title` and its
 * tooltip (`parent_title`) — shiki accepted that two same-named rows look identical
 * at rest (「接受同名」, 2026-08-08), so the DTO's parent glyph/runtime fields were
 * deleted; a source cue would have to be re-designed, not just re-rendered.
 *
 * BADGE (#task:1875 contract, @Cindy MUST FIX on #task:1889): the row must NOT paint
 * `FavoriteRowDto.unread_count` directly — that number is POSITIONAL only. It goes
 * through the same `channelRowBadge` as the parent's row, fed by the same
 * `GET /api/attention/modes` authority, so the badge a channel shows is IDENTICAL
 * before and after the move. No renderer-invented tier, no subtraction from a
 * workspace roll-up, no badge field in the favorites DTO.
 *
 * SORT (#task:1254): Favorites has its OWN viewer-scoped ordering state under
 * `list_key='favorites'` (a flat single group, list-wide recent/manual + manual drag),
 * reusing the shared `useListDragSort` + `SortModeMenu` exactly like the channel
 * sidebar — recent orders by the conversation's HOME-list `last_accessed_at`
 * (recently-OPENED, NOT recently-starred), manual by the favorites `rank`. This axis
 * is INDEPENDENT of the parent's list: reordering favorites never touches a
 * conversation's rank there.
 *
 * Self-contained: it owns its data (`useFavorites`), its tier batches, its sort
 * wiring and its unstar mutation, so the parent only passes the current selection +
 * the navigation handler. Renders nothing when empty.
 */
export function FavoritesGroup(props: {
  /** The open conversation — the ONLY thing that highlights a STARRED row. */
  selectedChannelId: string | null;
  /** Every workspace the viewer can currently see. This list's freshness
   *  subscription is scoped to them (see `useFavorites`) — the set must come from
   *  OUTSIDE the projection, because a parent with no visible favorite is exactly
   *  the one holding a hidden star waiting to be restored. `FavoritesWatchScope`
   *  is what enforces that: its only producer is
   *  `partitionRailWorkspaces().allVisibleIds`, so a projection-derived
   *  `string[]` cannot be passed here. */
  watchWorkspaceIds: FavoritesWatchScope;
  /** Navigate to a starred conversation inside its parent workspace. */
  onSelectConversation: (workspaceId: string, conversationId: string) => void;
}): JSX.Element | null {
  const { data } = useFavorites(props.watchWorkspaceIds);
  const items = useMemo(() => data?.items ?? [], [data]);
  const viewerSort = data?.viewer_sort;
  const unstar = useUnstarFavorite();
  const setSortMode = useSetSortMode();

  // Tier authority for the rows that HAVE a tier. Only open-roster parents
  // are fanned out: the modes population joins `conversation_users` AND
  // `c.roster_policy='open'`, so a fixed-roster row's parent (an agent home) would answer with
  // an empty batch every time — zero information, and one request per DM. A DM
  // channel's verdict is `'all'` by backend rule, resolved on the row below.
  const channelParentIds = useMemo(
    () =>
      Array.from(
        new Set(items.filter(i => i.roster_policy === 'open').map(i => i.workspace_id)),
      ).sort(),
    [items],
  );
  const { byChannel, mutedByWorkspace } =
    useAttentionModesAcrossWorkspaces(channelParentIds);

  // Compose the live order from the favorites `viewer_sort` (recent → home
  // last_accessed_at, manual → rank), reusing the shared drag-sort machine. A single
  // flat group; list-wide mode scope (no `modeScopeOf`), same as the channel sidebar.
  // `getId` MUST be `favorite_key` — it is the entity_id under which
  // `viewer_sort.entries` (and the backend rank) live, and the reorder `ordered_ids`
  // element.
  const { orderedGroups, onReorder } = useListDragSort<typeof FAVORITES_GROUP, FavoriteRowDto>({
    listKey: FAVORITES_LIST_KEY,
    groups: { [FAVORITES_GROUP]: items },
    viewerSort,
    getId: r => r.favorite_key,
    getCreatedAt: r => r.created_at,
  });
  const ordered = orderedGroups[FAVORITES_GROUP];
  const mode = sortModeOf(viewerSort, undefined);

  if (items.length === 0) return null;

  // Collapsed STARRED, open conversation starred: keep that one row (see
  // `SidebarSection.collapsedContent`). Not the sortable wrapper — a single row has
  // nothing to reorder — but the row itself is unchanged, menu included.
  const selectedFavorite = props.selectedChannelId
    ? ordered.find(i => i.entity_id === props.selectedChannelId)
    : undefined;

  return (
    <SidebarSection
      label="STARRED"
      icon={<Star className="size-3.5" />}
      count={items.length}
      collapsible
      defaultExpanded
      persistId="starred"
      collapsedContent={
        selectedFavorite ? (
          <li>
            <FavoriteRow
              item={selectedFavorite}
              selectedChannelId={props.selectedChannelId}
              attention={byChannel.get(selectedFavorite.entity_id)}
              workspaceMuted={mutedByWorkspace.get(selectedFavorite.workspace_id)}
              onSelectConversation={props.onSelectConversation}
              onUnstar={() => unstar.mutate(selectedFavorite)}
            />
          </li>
        ) : null
      }
      action={
        <SortModeMenu
          mode={mode}
          onChange={m => setSortMode.mutate({ list_key: FAVORITES_LIST_KEY, mode: m })}
        />
      }
    >
      <SortableGroup
        ids={ordered.map(i => i.favorite_key)}
        onReorder={o => onReorder(FAVORITES_GROUP, o)}
      >
        {ordered.map(item => (
          <SortableFavoriteRow
            key={item.favorite_key}
            item={item}
            selectedChannelId={props.selectedChannelId}
            attention={byChannel.get(item.entity_id)}
            workspaceMuted={mutedByWorkspace.get(item.workspace_id)}
            onSelectConversation={props.onSelectConversation}
            onUnstar={() => unstar.mutate(item)}
          />
        ))}
      </SortableGroup>
    </SidebarSection>
  );
}

interface FavoriteRowProps {
  item: FavoriteRowDto;
  selectedChannelId: string | null;
  /** This conversation's tier row from its parent's batch. Absent ≡ no tier of its
   *  own (a `dm_channel`, a browse-only public channel, or the batch hasn't landed) —
   *  never defaulted here. */
  attention: ChannelAttentionModeRowDto | undefined;
  /** The parent workspace's suppressor, `undefined` until its batch resolves. Only
   *  reaches the Notifications sub-menu, which needs it to explain a checked row. */
  workspaceMuted: boolean | undefined;
  onSelectConversation: (workspaceId: string, conversationId: string) => void;
  onUnstar: () => void;
  /** Paint the grab cursor so the row reads as draggable (shiki 2026-08-10 — the
   *  in-tree `ChannelRow` already does). Set by the sortable wrapper ALONE: the
   *  collapsed-reveal row has nothing to reorder. */
  draggable?: boolean;
}

/** The drag wrapper: an `<li>` bound to dnd-kit by `favorite_key` (the same id in
 *  `SortableGroup ids` + the backend rank), mirroring the channel sidebar's
 *  `SortableChannelItem`. Drag listeners sit on the `<li>`; the row's own click
 *  (navigate) and context menu (unstar) still fire — dnd-kit's activation constraint
 *  separates a drag from a click. */
function SortableFavoriteRow(props: Omit<FavoriteRowProps, 'draggable'>): JSX.Element {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } =
    useSortable({ id: props.item.favorite_key, animateLayoutChanges });
  return (
    <li
      ref={setNodeRef}
      style={sortableItemStyle({ transform, transition, isDragging })}
      className="touch-none"
      {...attributes}
      {...listeners}
    >
      <FavoriteRow {...props} draggable />
    </li>
  );
}

function FavoriteRow({
  item,
  selectedChannelId,
  attention,
  workspaceMuted,
  onSelectConversation,
  onUnstar,
  draggable,
}: FavoriteRowProps): JSX.Element {
  const isPrimary = conversationSelectionTier(item.entity_id, selectedChannelId) === 'primary';

  // Byte-identical to the parent list's `ChannelRow`, which is the acceptance
  // contract for the move. A `dm_channel` carries no tier row (the backend's
  // `loudPositionalPredicate` makes it unconditionally loud, so its verdict IS
  // `'all'`, and its agent-home parent cannot be muted at all — the attention
  // suppressor early-returns on a non-regular workspace). For a real channel the
  // batch row is the ONLY authority: a missing row propagates `undefined`, and the
  // badge then renders nothing rather than fabricating the loudest tier. That also
  // subsumes the parent list's `isMember` gate — the batch joins `conversation_users`,
  // so a browse-only public row has no tier and therefore no badge.
  const effectiveMode: ChannelAttentionMode | undefined =
    item.roster_policy === 'open' ? attention?.effective_mode : 'all';
  const badge = channelRowBadge({
    effectiveMode,
    positionalUnread: item.unread_count ?? 0,
    directedUnread: attention?.directed_unread_count ?? 0,
  });
  // A silenced row says so without being right-clicked: a MutedMarker rides beside
  // the name (shiki 2026-08-09), matching the workspace row and the parent list's
  // `ChannelRow`. Mute is the marker ALONE — the name keeps its full colour (shiki
  // 2026-08-09). A directed badge still stands out at the trailing edge.
  //
  // The marker reads the channel's OWN stored tier, so it stays a SEPARATE test
  // from `effectiveMode` above rather than reusing it (#task:1952, shiki
  // 2026-08-10): a workspace suppressor is one fact and is drawn once on the
  // workspace row, so repainting it per child was noise. `effectiveMode` must keep
  // feeding the badge — swapping that shared variable to the stored tier would
  // make a muted workspace's `all`-tier rows count positional unread as `loud`
  // again (a behaviour regression, not one fewer icon). Same split as `ChannelRow`.
  const isSilenced = attention?.mode === 'mute';

  // Notifications is a member-scoped write on regular channels only (the backend
  // 404s a dm_channel). Membership is read off the SAME authority the badge uses:
  // the modes batch joins `conversation_users`, so a row with no tier is a row the
  // viewer is not a member of — a browse-only PUBLIC channel can be starred without
  // joining, and offering it the menu would hand the user a guaranteed 404
  // (@Cindy MUST FIX, #task:1889; the parent list's `ChannelRow` gates on `isMember`
  // for the same reason). While the batch is loading or failed the entry is simply
  // absent rather than optimistically offered.
  const showAttentionMenu = item.roster_policy === 'open' && attention !== undefined;

  const row = (
    <ConversationRowLayout
      selected={isPrimary}
      // A STARRED row sits on the OUTER column: its parent IS the group, so it is
      // flush with the STARRED header and with the container header rows below —
      // the single indent step is spent on channels nested under a workspace.
      column="outer"
      draggable={draggable}
      // The visible title is the child's alone, so the tooltip carries where it
      // came from — STARRED lifts a row out of its parent's list.
      title={`${item.title} — ${item.parent_title}`}
      onSelect={() => onSelectConversation(item.workspace_id, item.entity_id)}
    >
      <ChannelIcon
        variant="sticker"
        // Same glyph axis as the in-tree `ChannelRow` (#task:1954, shiki
        // 「starred group 中的 icon 是恒定的」): a private channel wears the
        // Lock here too — STARRED owns PRESENCE + ORDER, never a different
        // identity. Kind-gated exactly as the parent list does it: a
        // `dm_channel` is stored `private` but is not a private channel, so it
        // keeps the canonical `#`.
        visibility={item.roster_policy === 'open' ? item.visibility : undefined}
        className="text-text-muted"
      />
      <span className="min-w-0 truncate">{item.title}</span>
      {/* Mute rides WITH the name (shiki 2026-08-09), matching the workspace row
          and the parent list's `ChannelRow`: shared MutedMarker beside the title,
          badge stays at the trailing edge. */}
      {isSilenced ? (
        <span className="flex shrink-0 items-center">
          <MutedMarker />
        </span>
      ) : null}
      {badge ? (
        <UnreadBadge count={badge.count} tier={badge.tier} className="ml-auto" />
      ) : null}
    </ConversationRowLayout>
  );

  return (
    <AppContextMenu trigger={row}>
      {/* Unstar returns the conversation to its parent's list — the inverse of the
          move, and the only place it can be undone (the parent's list no longer
          holds the row). */}
      <AppContextMenuItem
        icon={<Star className="size-3.5 fill-current" />}
        onSelect={onUnstar}
      >
        Unstar
      </AppContextMenuItem>
      {showAttentionMenu ? (
        <AppContextMenuSub icon={<Bell className="size-3.5" />} label="Notifications">
          <ChannelAttentionMenuItems
            channelId={item.entity_id}
            mode={attention?.mode}
            workspaceMuted={workspaceMuted}
          />
        </AppContextMenuSub>
      ) : null}
      <AppContextMenuSeparator />
      <AppContextMenuItem
        icon={<Copy className="size-3.5" />}
        onSelect={() => {
          void copyConversationName(item.title);
        }}
      >
        Copy name
      </AppContextMenuItem>
    </AppContextMenu>
  );
}
