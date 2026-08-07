import { useMemo } from 'react';
import { Bell, Copy, Star, User } from 'lucide-react';
import type {
  ChannelAttentionMode,
  ChannelAttentionModeRowDto,
  FavoriteRowDto,
} from '@silverhand/shared';
import { useSortable } from '@dnd-kit/sortable';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import { AgentAvatar } from '@/components/AgentAvatar';
import { ChannelIcon } from '@/components/ChannelIcon';
import { AVATAR_PX } from '@/components/avatar-scale';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
  AppContextMenuSub,
} from '@/components/menus/AppContextMenu';
import {
  useAgentAvatarObjectUrls,
  type AgentAvatarSource,
} from '@/features/agents/avatar-hooks';
import { useFavorites, useUnstarFavorite } from '@/features/favorites/hooks';
import { useAttentionModesAcrossWorkspaces } from '@/features/attention/hooks';
import { useSetSortMode } from '@/features/workspaces/hooks';
import { channelRowBadge } from '@/lib/attention-mode';
import { conversationSelectionTier, railRowTierClass } from '@/lib/rail-selection';
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
 * `channel` and `dm_channel`. A starred CONTAINER (workspace / DM home) is NOT here:
 * its star merely pins it at the top of its own rail group. The flip from the
 * previous model is deliberate: what you want permanently in reach is the handful of
 * rooms you actually work in, and a flat global list of containers just read as a
 * second rail.
 *
 * EXCLUSIVE (load-bearing — mirrors shared `api/favorites.ts` + docs/list-sort-v1.md):
 * a starred conversation appears HERE and NOWHERE else, MOVED out of its parent's
 * channel list via `viewer_sort.entries[].starred_at` (see lib/home-grouping). Slack
 * "move", chosen over the old additive overlay because one entity in two places meant
 * every per-entity signal (unread, tier, silence) had to stay in sync in both — a
 * drift source. STARRED owns PRESENCE + ORDER only, never BEHAVIOR: open, selection,
 * badge and attention all delegate to the same authorities the parent's row uses.
 *
 * ROW (matches mockups/sidebar-merge-single-column.html): the identity column shows
 * the PARENT's glyph, not the channel's — the list is global, so two workspaces can
 * each have a `#general` and without a source cue the rows are indistinguishable. The
 * `#` is demoted to a subordinate prefix on the name (`ChannelIcon variant="utility"`:
 * the parent glyph is this row's identity anchor, so the `#` must not also wear a
 * theme's sticker chrome and inflate beside it). Every parent glyph is server-resolved
 * (`parent_icon_url` / `parent_runtime`) — the renderer joins nothing.
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
 * Self-contained: it owns its data (`useFavorites`), its parent-avatar resolution, its
 * tier batches, its sort wiring and its unstar mutation, so the parent only passes the
 * current selection + the navigation handler. Renders nothing when empty.
 */
export function FavoritesGroup(props: {
  /** The open conversation — the ONLY thing that highlights a STARRED row. */
  selectedChannelId: string | null;
  /** Navigate to a starred conversation inside its parent workspace. */
  onSelectConversation: (workspaceId: string, conversationId: string) => void;
}): JSX.Element | null {
  const { data } = useFavorites();
  const items = useMemo(() => data?.items ?? [], [data]);
  const viewerSort = data?.viewer_sort;
  const unstar = useUnstarFavorite();
  const setSortMode = useSetSortMode();

  // Parent-agent avatars, resolved once for the whole section over the stable set of
  // rows whose parent is an agent home with an avatar. Keyed by `entity_id` (the row
  // id). The server gives a relative `?v=`-busted URL; the Electron renderer can't
  // use it directly in <img>, so it must go through the avatar object-url proxy —
  // same as Activity's preview_sender (avoids the blank/broken-img trap).
  const parentAvatarSources = useMemo<AgentAvatarSource[]>(
    () =>
      items
        .filter(i => i.parent_icon_url)
        .map(i => ({ id: i.entity_id, avatar_url: i.parent_icon_url })),
    [items],
  );
  const parentAvatarUrls = useAgentAvatarObjectUrls(parentAvatarSources);

  // Tier authority for the rows that HAVE a tier. Only `kind === 'channel'` parents
  // are fanned out: the modes population joins `conversation_users` AND
  // `c.kind='channel'`, so a `dm_channel`'s parent (an agent home) would answer with
  // an empty batch every time — zero information, and one request per DM. A DM
  // channel's verdict is `'all'` by backend rule, resolved on the row below.
  const channelParentIds = useMemo(
    () =>
      Array.from(
        new Set(items.filter(i => i.kind === 'channel').map(i => i.workspace_id)),
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

  return (
    <SidebarSection
      label="STARRED"
      count={items.length}
      collapsible
      defaultExpanded
      persistId="starred"
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
            parentAvatarUrl={parentAvatarUrls.get(item.entity_id) ?? null}
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
  parentAvatarUrl: string | null;
  /** This conversation's tier row from its parent's batch. Absent ≡ no tier of its
   *  own (a `dm_channel`, a browse-only public channel, or the batch hasn't landed) —
   *  never defaulted here. */
  attention: ChannelAttentionModeRowDto | undefined;
  /** The parent workspace's suppressor, `undefined` until its batch resolves. Only
   *  reaches the Notifications sub-menu, which needs it to explain a checked row. */
  workspaceMuted: boolean | undefined;
  onSelectConversation: (workspaceId: string, conversationId: string) => void;
  onUnstar: () => void;
}

/** The drag wrapper: an `<li>` bound to dnd-kit by `favorite_key` (the same id in
 *  `SortableGroup ids` + the backend rank), mirroring the channel sidebar's
 *  `SortableChannelItem`. Drag listeners sit on the `<li>`; the row's own click
 *  (navigate) and context menu (unstar) still fire — dnd-kit's activation constraint
 *  separates a drag from a click. */
function SortableFavoriteRow(props: FavoriteRowProps): JSX.Element {
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
      <FavoriteRow {...props} />
    </li>
  );
}

function FavoriteRow({
  item,
  selectedChannelId,
  parentAvatarUrl,
  attention,
  workspaceMuted,
  onSelectConversation,
  onUnstar,
}: FavoriteRowProps): JSX.Element {
  const tier = conversationSelectionTier(item.entity_id, selectedChannelId);
  const isPrimary = tier === 'primary';

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
    item.kind === 'channel' ? attention?.effective_mode : 'all';
  const badge = channelRowBadge({
    effectiveMode,
    positionalUnread: item.unread_count ?? 0,
    directedUnread: attention?.directed_unread_count ?? 0,
  });
  // A silenced row says so without being right-clicked — the title drops to the muted
  // ink. Subtractive, same as the parent list: no marker icon, and a directed badge
  // still stands out against it.
  const isSilenced = effectiveMode === 'mute';

  // Notifications is a member-scoped write on regular channels only (the backend 404s
  // a dm_channel). Every STARRED row is a conversation the viewer can reach, and a
  // favorite is only projected for a member or a public channel.
  const showAttentionMenu = item.kind === 'channel';

  // No `transition-colors`: selection is a discrete committed state — fading it is
  // the leaving-row "flicker" (#task:1162). One tier vocabulary shared with every
  // other sidebar row.
  const rowBg = railRowTierClass(tier);

  const row = (
    <div
      data-row-selected={isPrimary || undefined}
      className={'sidebar-row-border flex h-8 w-full items-stretch border px-2 ' + rowBg}
    >
      <button
        type="button"
        onClick={() => onSelectConversation(item.workspace_id, item.entity_id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]"
        title={`${item.title} — ${item.parent_title}`}
      >
        {/* Fixed 16px leading column for the PARENT's glyph, so the heterogeneous
            sources (workspace poster badge / agent avatar) align down the list. */}
        <span className="flex size-4 shrink-0 items-center justify-center text-text-muted">
          <FavoriteParentIcon item={item} parentAvatarUrl={parentAvatarUrl} />
        </span>
        <ChannelIcon
          variant="utility"
          density="sm"
          className={isSilenced && !isPrimary ? 'text-text-muted/60' : 'text-text-muted'}
        />
        <span
          className={
            'min-w-0 truncate ' + (isSilenced && !isPrimary ? 'text-text-muted' : '')
          }
        >
          {item.title}
        </span>
        {badge ? (
          <UnreadBadge count={badge.count} tier={badge.tier} className="ml-auto" />
        ) : null}
      </button>
    </div>
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

/** The row's identity anchor: its PARENT. `parent_icon_url` is non-null only for an
 *  agent home with an avatar, `parent_runtime` only for an agent home — so the three
 *  branches are the contract, not a guess (shared `api/favorites.ts`). Regular
 *  workspaces carry no icon storage, hence the canonical themed poster badge. */
function FavoriteParentIcon({
  item,
  parentAvatarUrl,
}: {
  item: FavoriteRowDto;
  parentAvatarUrl: string | null;
}): JSX.Element {
  if (item.parent_runtime) {
    return (
      <AgentAvatar
        runtime={item.parent_runtime}
        size={AVATAR_PX.xs}
        avatarObjectUrl={parentAvatarUrl}
      />
    );
  }
  if (item.kind === 'dm_channel') {
    // A DM parent with no resolved runtime — neutral glyph rather than a guessed
    // runtime.
    return <User className="size-4 shrink-0" />;
  }
  return <WorkspaceIcon kind="regular" dmAgentId={null} />;
}
