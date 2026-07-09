import { useMemo } from 'react';
import { User } from 'lucide-react';
import type { FavoriteRowDto } from '@silverhand/shared';
import { useSortable } from '@dnd-kit/sortable';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import {
  useAgentAvatarObjectUrls,
  type AgentAvatarSource,
} from '@/features/agents/avatar-hooks';
import { useFavorites, useUnstarFavorite } from '@/features/favorites/hooks';
import { useSetSortMode } from '@/features/workspaces/hooks';
import {
  railRowTierClass,
  railSelectionTier,
  type RailRowRef,
  type RowSelectionTier,
} from '@/lib/rail-selection';
import { sortModeOf } from '@/lib/viewer-sort';
import { SortModeMenu } from '@/components/layout/SortModeMenu';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
  useListDragSort,
} from '@/components/layout/list-drag-sort';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';
import type { WorkspaceItem } from './WorkspacesPanel';
import { SidebarSection } from './sidebar-shared';

/** The favorites list's own sort namespace. A single FLAT group (`favorites`),
 *  list-wide [recent|manual] toggle — the wire group name must equal the backend
 *  `legalGroups('favorites') = ['favorites']`, and the scope is list-wide (no
 *  per-group axis), exactly like the channel sidebar (#task:1252 / #task:1254). */
const FAVORITES_LIST_KEY = 'favorites';
const FAVORITES_GROUP = 'favorites';

/**
 * The rail's STARRED section — a GLOBAL favorites list (#task:1253), a
 * first-class SORTABLE list (#task:1254).
 *
 * SCOPE (final model, shiki 2026-07-01): STARRED holds WORKSPACE / DM rows ONLY.
 * A starred CHANNEL is NOT surfaced here — a channel is a workspace-nested leaf,
 * so its star pins it in its OWN channel sidebar (a local starred group) instead;
 * hoisting it into a flat global peer-group severed its parent context and read
 * as weird (dogfood). Channels are gone from the favorites bounded context: the
 * backend does not project them and this component renders only workspace/dm.
 *
 * EXCLUSIVE for workspace/DM (load-bearing — mirrors shared `api/favorites.ts` +
 * docs/list-sort-v1.md): a starred workspace/DM appears HERE and NOWHERE else —
 * MOVED out of its home rail group via `viewer_sort.entries[].starred_at` (see
 * lib/home-grouping). Slack "move", chosen over the old additive overlay because
 * one entity in two places meant every per-entity signal (unread badge, …) had to
 * stay in sync in both — a drift source. STARRED owns PRESENCE + ORDER only,
 * never BEHAVIOR: open / layout-restore / selection / unread all delegate to the
 * same home-surface entry (the navigation handlers passed in).
 *
 * SORT (#task:1254): Favorites has its OWN viewer-scoped ordering state under
 * `list_key='favorites'` (a flat single group, list-wide recent/manual + manual
 * drag), reusing the shared `useListDragSort` + `SortModeMenu` exactly like the
 * channel sidebar — recent orders by the entity's HOME-list `last_accessed_at`
 * (recently-OPENED, NOT recently-starred), manual by the favorites `rank`. This
 * axis is INDEPENDENT of the home groups: reordering favorites never touches a
 * workspace/DM's rank in its home list. The backend persists, the renderer
 * composes from `viewer_sort` (no client pre-sort assumption).
 *
 * Self-contained: it owns its data (`useFavorites`), its dm-avatar resolution,
 * its sort wiring, and its unstar mutation, so the parent `Sidebar` only passes
 * the current selection + the navigation handler. Renders nothing when empty.
 *
 * Row vocabulary (all rows one height, square, ink-on-select; #task:1250):
 *   - workspace → themed `W` poster badge + name.
 *   - dm        → the bound agent's avatar (server-resolved, no local join) +
 *                 agent name.
 * No inline ★ affordance — unstar lives in the row's context menu (keeps the
 * dense row clean; shiki #task:1250).
 */
export function FavoritesGroup(props: {
  /** The selected workspace, already suppressed by the parent when a top-level
   *  view (Activity/Saved/…) owns selection. */
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  /** The RAW full workspace set keyed by id (a starred workspace stays in it —
   *  star only MOVES it out of the home render groups). Lets a favorite row
   *  resolve its `workspace_path` / reveal capability so its context menu
   *  matches the home-rail one (#task:1439). */
  workspacesById: ReadonlyMap<string, WorkspaceItem>;
  canRevealWorkspace: (workspace: WorkspaceItem) => boolean;
}): JSX.Element | null {
  const { data } = useFavorites();
  const items = useMemo(() => data?.items ?? [], [data]);
  const viewerSort = data?.viewer_sort;
  const unstar = useUnstarFavorite();
  const setSortMode = useSetSortMode();

  // Resolve dm-agent avatars once for the whole section, over the stable set of
  // dm rows that carry an icon. Keyed by `entity_id` (the dm workspace id). The
  // server gives a relative `?v=`-busted URL; the Electron renderer can't use it
  // directly in <img>, so it must go through the avatar object-url proxy — same
  // as Activity's preview_sender (avoids the blank-subtitle / broken-img trap).
  const dmAvatarSources = useMemo<AgentAvatarSource[]>(
    () =>
      items
        .filter(i => i.kind === 'dm' && i.icon_url)
        .map(i => ({ id: i.entity_id, avatar_url: i.icon_url })),
    [items],
  );
  const dmAvatarUrls = useAgentAvatarObjectUrls(dmAvatarSources);

  // Compose the live order from the favorites `viewer_sort` (recent → home
  // last_accessed_at, manual → rank), reusing the shared drag-sort machine. A
  // single flat group; list-wide mode scope (no `modeScopeOf`), same as the
  // channel sidebar. `getId` MUST be `favorite_key` — it is the entity_id under
  // which `viewer_sort.entries` (and the backend rank) live, and the reorder
  // `ordered_ids` element.
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
        {ordered.map(item => {
          const ws = props.workspacesById.get(item.workspace_id);
          return (
            <SortableFavoriteRow
              key={item.favorite_key}
              item={item}
              tier={railSelectionTier(
                favoriteToRailRow(item),
                props.selectedWorkspaceId,
              )}
              dmAvatarUrl={dmAvatarUrls.get(item.entity_id) ?? null}
              workspacePath={ws?.workspace_path ?? null}
              canReveal={ws ? props.canRevealWorkspace(ws) : false}
              onSelectWorkspace={props.onSelectWorkspace}
              onUnstar={() => unstar.mutate(item)}
            />
          );
        })}
      </SortableGroup>
    </SidebarSection>
  );
}

interface FavoriteRowProps {
  item: FavoriteRowDto;
  tier: RowSelectionTier;
  dmAvatarUrl: string | null;
  /** From the joined `WorkspaceItem` — powers the shared menu's Open in Finder /
   *  Copy path. Null in the brief window before the workspace record resolves. */
  workspacePath: string | null;
  canReveal: boolean;
  onSelectWorkspace: (id: string) => void;
  onUnstar: () => void;
}

/** Map a favorite row to the unified rail-row identity so STARRED computes its
 *  highlight through the SAME `railSelectionTier` as the home rail — a
 *  workspace/dm favorite is primary when it is the selected workspace.
 *  `FavoriteKind` (workspace/dm) already equals `RailRowRef.kind`. */
function favoriteToRailRow(item: FavoriteRowDto): RailRowRef {
  return { kind: item.kind, workspaceId: item.workspace_id };
}

/** The drag wrapper: an `<li>` bound to dnd-kit by `favorite_key` (the same id
 *  in `SortableGroup ids` + the backend rank), mirroring the channel sidebar's
 *  `SortableChannelItem`. Drag listeners sit on the `<li>`; the row's own click
 *  (navigate) and context menu (unstar) still fire — dnd-kit's activation
 *  constraint separates a drag from a click. */
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
  tier,
  dmAvatarUrl,
  workspacePath,
  canReveal,
  onSelectWorkspace,
  onUnstar,
}: FavoriteRowProps): JSX.Element {
  const onClick = () => onSelectWorkspace(item.workspace_id);

  const isPrimary = tier === 'primary';
  // Unread badge (#task:1254): STARRED is the EXCLUSIVE home for a starred
  // workspace/DM, so it must carry the unread signal the home group used to. The
  // count is server-filled on the cross-workspace read-model
  // (`FavoriteRowDto.unread_count`, canonical `ConversationReadRepo`:
  // workspace/dm → workspace rollup) — the renderer can't stitch it (per-channel
  // unread cache is scoped to the SELECTED workspace, but a starred workspace's
  // rollup spans its own channels). Contract: `0` = computed, no unread; `null` =
  // wire back-compat only. Both render nothing; only `> 0` shows the pill.
  const unread = item.unread_count;
  const hasUnread = unread != null && unread > 0;
  // No `transition-colors`: selection is a discrete committed state — fading it
  // is the leaving-row "flicker" (mirrors WorkspaceRow / ChannelRow, #task:1162).
  // One binary tier vocabulary shared with the home rail (#task:1254).
  const rowBg = railRowTierClass(tier);

  const row = (
    <div
      data-row-selected={isPrimary || undefined}
      className={
        'sidebar-row-border flex h-8 w-full items-stretch border px-2 ' + rowBg
      }
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm leading-[16px]"
      >
        {/* Fixed 16px leading column so the heterogeneous glyphs (W badge /
            agent avatar) align down the list. */}
        <span className="flex size-4 shrink-0 items-center justify-center text-text-muted">
          <FavoriteLeadingIcon item={item} dmAvatarUrl={dmAvatarUrl} />
        </span>
        <span
          className={
            'min-w-0 flex-1 truncate ' +
            // Unread emphasis mirrors WorkspaceRow: bold the title when there is
            // unread and the row isn't already selected (selected fill is emphasis
            // enough). #task:1162 / #task:1254.
            (hasUnread && !isPrimary ? 'font-semibold text-text-primary' : '')
          }
        >
          {item.title}
        </span>
        {hasUnread ? (
          // Rightmost fixed status slot — the SAME pill as the home rail
          // (`data-sidebar-unread`): accent pill when resting, inverse
          // (`bg-bg-floating text-accent`) on the selected row. Never invents a
          // Favorites-specific badge (#task:1254).
          <span
            data-sidebar-unread
            className={
              'inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ' +
              (isPrimary ? 'bg-bg-floating text-accent' : 'bg-accent text-text-on-accent')
            }
            aria-label={`${unread} unread`}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
    </div>
  );

  return (
    <WorkspaceContextMenu
      trigger={row}
      canStar
      isStarred
      onToggleStar={onUnstar}
      canReveal={canReveal}
      workspacePath={workspacePath}
    />
  );
}

function FavoriteLeadingIcon({
  item,
  dmAvatarUrl,
}: {
  item: FavoriteRowDto;
  dmAvatarUrl: string | null;
}): JSX.Element {
  if (item.kind === 'dm') {
    // runtime is contractually non-null for dm rows; fall back to the neutral
    // glyph if it is ever missing rather than guessing a runtime.
    if (!item.runtime) return <User className="size-4 shrink-0" />;
    return (
      <AgentAvatar runtime={item.runtime} size={AVATAR_PX.xs} avatarObjectUrl={dmAvatarUrl} />
    );
  }
  // workspace → the canonical themed poster badge (regular workspaces carry no
  // icon storage, so there is never an icon_url here).
  return <WorkspaceIcon kind="regular" dmAgentId={null} />;
}
