// One workspace's channel children in the MERGED single-column sidebar
// (#task:1889). This file is what the retired `ChannelsSidebar.tsx` (the second
// column) became: the row vocabulary, the badge path and the drag group are
// ported unchanged — only the mounting story is new.
//
// LAZY BY MOUNT. Every per-workspace read THIS SUBTREE needs lives inside it, so a
// collapsed workspace renders nothing and this subtree fetches nothing; expanding
// mounts the component and its three queries fire together. The sort menu is a
// sibling in the header and is likewise rendered only while expanded — mounting it
// collapsed would re-introduce the request (it reads the same `channelsKey` cache).
//
// SCOPED CLAIM, on purpose (@Cindy, #task:1889): this is "the subtree mounts no
// queries of its own", NOT "a collapsed workspace is request-free" and NOT
// "`useChannelsForWorkspace` owns the `workspace:<id>` subscription". Two surfaces
// outside this file reach a collapsed workspace: STARRED subscribes to EVERY
// visible workspace scope (`useFavorites` — it must stay armed where nothing is
// showing), and a starred regular channel makes STARRED fetch its parent's
// attention modes. So expanding is what stops THIS subtree's fetches, and realtime
// liveness for a workspace's channel list is what tracks visibility here.
//
// WHY THE MUTATIONS ARE HERE TOO: `useStarChannel(workspaceId)` /
// `useArchiveChannel(workspaceId)` are per-workspace (they reconcile that
// workspace's `channelsKey`). The old single-column sidebar could hold ONE
// instance at the composition root because only one workspace was ever
// rendered; the tree shows many at once, so each subtree owns its own.
import { useMemo, type ReactNode } from 'react';
import {
  type ChannelAttentionMode,
  type ChannelAttentionModeRowDto,
  type ConversationVisibility,
} from '@silverhand/shared';
import { Archive, ArchiveRestore, Bell, Copy, Plus, Star } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { ChannelIcon } from '@/components/ChannelIcon';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
  AppContextMenuSub,
} from '@/components/menus/AppContextMenu';
import { ChannelAttentionMenuItems } from '@/components/layout/ChannelAttentionSurfaces';
import {
  NESTED_GLYPH_INSET,
  UnreadBadge,
  copyConversationName,
} from '@/components/layout/sidebar-shared';
import { SortModeMenu } from '@/components/layout/SortModeMenu';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
  useListDragSort,
} from '@/components/layout/list-drag-sort';
import {
  useArchiveChannel,
  useChannelSortState,
  useChannelsForWorkspace,
  useSetSortMode,
  useStarChannel,
} from '@/features/workspaces/hooks';
import { useMessageUnreadCounts } from '@/features/channels/message-unread';
import { useWorkspaceAttentionModes } from '@/features/attention/hooks';
import { channelRowBadge } from '@/lib/attention-mode';
import { sortModeOf } from '@/lib/viewer-sort';
import { excludeStarredChannels } from '@/lib/home-grouping';

export type WorkspaceUiKind = 'regular' | 'dm';

interface ChannelNode {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel';
  /** Identity-level visibility. `'private'` regular channels render a Lock
   *  glyph; `'public'` render the canonical `#`. Only meaningful for
   *  `kind === 'channel'` — a `dm_channel` is not a private *channel* and never
   *  shows the lock (see the render site). */
  visibility: ConversationVisibility;
  closed_at: number | null;
  starred_at: number | null;
  archived_at: number | null;
  /** Creation time — stable fallback/tiebreak for sort modes (#task:1146). */
  created_at: number;
  /** Per-viewer membership. The discovery union mixes joined channels with active
   *  PUBLIC channels the viewer has NOT joined (`is_member: false`,
   *  browse-and-join). Member projections are FAIL-CLOSED (`is_member === true`):
   *  the unread badge (a member read-state projection) and the member/org context
   *  actions (Archive, Notifications) render only for an authoritative member; a
   *  non-member OR an unknown row shows neither. Local star + manual sort are
   *  viewer-local presentation state and STAY available for a visible unjoined
   *  public row. The backend stamps the field on every regular/DM item, so
   *  `undefined` only occurs on a stale payload — where fail-closed is safe. */
  is_member?: boolean;
}

/**
 * The viewer's sort control for one workspace's channel list, rendered into the
 * workspace header's hover actions. Separate component so it mounts and
 * unmounts with the expanded state: it reads the SAME `channelsKey` cache as the
 * children below (`useChannelSortState` is a `select` over
 * `useChannelsForWorkspace`'s query), so mounting it on a COLLAPSED workspace
 * would fetch that workspace's channels — the one fetch the lazy mount exists to
 * avoid (see the file header for what "lazy" does and does not claim).
 */
export function ChannelSortMenu({
  workspaceId,
  workspaceKind,
}: {
  workspaceId: string;
  workspaceKind: WorkspaceUiKind;
}): JSX.Element {
  const { data: viewerSort } = useChannelSortState(workspaceId, workspaceKind);
  const setSortMode = useSetSortMode();
  const listKey = `channels:${workspaceId}`;
  return (
    <SortModeMenu
      mode={sortModeOf(viewerSort)}
      onChange={m => setSortMode.mutate({ list_key: listKey, mode: m })}
    />
  );
}

interface WorkspaceChannelsProps {
  workspaceId: string;
  workspaceKind: WorkspaceUiKind;
  /** The conversation the tree is currently FILLing, or null. One id for the
   *  whole tree (the spec's single-highlight rule), so at most one row in one
   *  workspace can match. */
  selectedChannelId: string | null;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  /** Create a channel in THIS workspace — the empty-state action, and the
   *  compensation for `/chat/w/:id` having no highlight of its own. */
  onCreateChannel: (workspaceId: string) => void;
}

/**
 * The expanded workspace's children: its live top-level channels, MINUS the
 * starred ones (#task:1888 moved those into the global STARRED list — exclusive,
 * one visible copy). Archived channels are not here; they live on the Archived
 * tool page.
 *
 * The exclusion runs BEFORE `useListDragSort` so a whole-group reorder submits
 * exactly the member set `routes/sort.ts` validates against. Each workspace owns
 * its own drag context and its own `channels:<id>` sort scope — dragging never
 * crosses parents.
 */
export function WorkspaceChannels({
  workspaceId,
  workspaceKind,
  selectedChannelId,
  onSelectChannel,
  onCreateChannel,
}: WorkspaceChannelsProps): JSX.Element {
  const { data: items = [] } = useChannelsForWorkspace(workspaceId, workspaceKind);
  const { data: viewerSort } = useChannelSortState(workspaceId, workspaceKind);
  // ONE batch read of every channel tier in this workspace (#task:1870) — the
  // badges need a tier per row and the right-click menu needs the row's own
  // stored choice, so a per-channel GET would be both N requests and a second
  // carrier of the same fact.
  const { data: attentionModes } = useWorkspaceAttentionModes(workspaceId);
  const { data: unreadData } = useMessageUnreadCounts(workspaceId, workspaceKind);
  const starChannel = useStarChannel(workspaceId);
  const archiveChannel = useArchiveChannel(workspaceId);

  const attentionByChannel = useMemo(
    () =>
      new Map((attentionModes?.channels ?? []).map(c => [c.conversation_id, c])),
    [attentionModes],
  );
  // `undefined` until the batch resolves — the third state the row must not
  // collapse into `false`, or every unresolved row fabricates the loudest tier.
  const workspaceMuted = attentionModes?.muted;
  const unreadByChannel = unreadData?.by_conversation ?? {};

  // `starred_at` is viewer-local sort state, never a channel field (#task:1209).
  // The old second column got it joined at the composition root; here the join
  // is local — this subtree already holds both halves of the same cache entry,
  // and a per-workspace join is what lets many workspaces render at once without
  // App.tsx keeping one map per workspace.
  const nodes = useMemo<ChannelNode[]>(() => {
    const starredAt = new Map<string, number>();
    for (const e of viewerSort?.entries ?? []) {
      if (e.starred_at !== null) starredAt.set(e.entity_id, e.starred_at);
    }
    return items.map(s => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      visibility: s.visibility,
      is_member: s.is_member,
      closed_at: s.closed_at,
      starred_at: starredAt.get(s.id) ?? null,
      archived_at: s.archived_at,
      created_at: s.created_at,
    }));
  }, [items, viewerSort]);

  const homeTopLevel = excludeStarredChannels(nodes);
  const { orderedGroups, onReorder } = useListDragSort<'channels', ChannelNode>({
    listKey: `channels:${workspaceId}`,
    groups: { channels: homeTopLevel },
    viewerSort,
    getId: c => c.id,
    getCreatedAt: c => c.created_at,
  });
  const ordered = orderedGroups.channels;

  if (ordered.length === 0) {
    // An expanded workspace with nothing to show offers the action instead of a
    // dead "No channels yet" line — the same affordance `/chat/w/:id` needs.
    return (
      <li>
        <button
          type="button"
          onClick={() => onCreateChannel(workspaceId)}
          className={
            'flex h-7 w-full items-center gap-1.5 text-left text-[12px] text-text-muted hover:text-text-primary ' +
            NESTED_GLYPH_INSET
          }
        >
          <Plus className="size-3.5 shrink-0" />
          <span className="truncate">New channel</span>
        </button>
      </li>
    );
  }

  const rowProps = {
    selectedChannelId,
    onSelect: (channelId: string) => onSelectChannel(channelId, workspaceId),
    onStar: (channelId: string, starred: boolean) =>
      starChannel.mutate({ channelId, starred }),
    onArchive: (channelId: string, archived: boolean) =>
      archiveChannel.mutate({ channelId, archived, workspaceId }),
    archivePending: archiveChannel.isPending,
    workspaceKind,
    unreadByChannel,
    attentionByChannel,
    workspaceMuted,
  };

  return (
    <SortableGroup
      ids={ordered.map(c => c.id)}
      onReorder={next => onReorder('channels', next)}
    >
      {ordered.map(channel => (
        <SortableChannelItem key={channel.id} channel={channel} {...rowProps} />
      ))}
    </SortableGroup>
  );
}

interface RowChildProps {
  selectedChannelId: string | null;
  onSelect: (id: string) => void;
  onStar: (channelId: string, starred: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind;
  unreadByChannel: Record<string, number>;
  /** This workspace's channel tiers, keyed by conversation id. Missing key ≡ the
   *  row has no tier of its own (a `dm_channel`, or the batch hasn't landed). */
  attentionByChannel: ReadonlyMap<string, ChannelAttentionModeRowDto>;
  /** The workspace suppressor, `undefined` until the tier batch resolves. Rows keep
   *  their own stored tier checked while it is on; only the resolved volume
   *  changes. */
  workspaceMuted: boolean | undefined;
}

/** Drag-sortable row for manual ordering. The `<li>` is BOTH the sortable node
 *  (`setNodeRef`) AND the drag surface — the dnd-kit `attributes` + `listeners`
 *  live here, not on the inner row, so they don't have to pass through the Radix
 *  context-menu `Slot` (which was swallowing the pointer activation). The whole
 *  row drags (no grip — per shiki); a 4px pointer activation distance keeps a
 *  plain click selecting. Vertical-only. The drag STYLE comes from the shared
 *  list-drag-sort helpers so it stays identical to the rail's row. */
function SortableChannelItem({
  channel,
  selectedChannelId,
  onSelect,
  onStar,
  onArchive,
  archivePending,
  workspaceKind,
  unreadByChannel,
  attentionByChannel,
  workspaceMuted,
}: { channel: ChannelNode } & RowChildProps): JSX.Element {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } =
    useSortable({ id: channel.id, animateLayoutChanges });
  return (
    <li
      ref={setNodeRef}
      style={sortableItemStyle({ transform, transition, isDragging })}
      className="touch-none"
      {...attributes}
      {...listeners}
    >
      <ChannelRow
        channel={channel}
        selected={channel.id === selectedChannelId}
        onClick={() => onSelect(channel.id)}
        onStar={onStar}
        onArchive={onArchive}
        archivePending={archivePending}
        workspaceKind={workspaceKind}
        unreadCount={unreadByChannel[channel.id] ?? 0}
        attention={attentionByChannel.get(channel.id)}
        workspaceMuted={workspaceMuted}
        draggable
      />
    </li>
  );
}

function ChannelRow({
  channel,
  selected,
  onClick,
  onStar,
  onArchive,
  archivePending,
  workspaceKind,
  unreadCount,
  attention,
  workspaceMuted,
  draggable,
}: {
  channel: ChannelNode;
  selected: boolean;
  onClick: () => void;
  onStar: (channelId: string, starred: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind;
  unreadCount: number;
  /** This row's tier from the workspace batch, or `undefined` when it has none —
   *  see `effectiveMode` below. */
  attention?: ChannelAttentionModeRowDto;
  /** The workspace suppressor, `undefined` until the tier batch resolves. */
  workspaceMuted: boolean | undefined;
  /** Manual mode: show the grab cursor so the row reads as draggable. The
   *  drag listeners live on the parent `<li>`, not here. */
  draggable?: boolean;
}): JSX.Element {
  const isClosed = channel.closed_at !== null;
  const isArchived = channel.archived_at !== null;
  // Fail-closed membership gate: member/org actions render only for an
  // authoritative member. A browse-only public row (is_member === false) — or an
  // unknown row — keeps only the presentation-state actions (Star) + read-side
  // Copy name. Star + manual drag-sort are viewer-local and stay available.
  const isMember = channel.is_member === true;
  // Archive/Restore is a channel-like organization action (#task:1145): it
  // applies to any top-level channel-like row — `channel` in a regular workspace
  // AND `dm_channel` in an agent_home/DM — and only excludes threads.
  // Non-members can't organize a channel they haven't joined (the backend 403s),
  // so it is member-gated.
  const showArchiveMenu =
    isMember && (channel.kind === 'channel' || channel.kind === 'dm_channel');
  // Per-viewer attention preference — a member-scoped write, regular channels
  // only. Hidden for a browse-only public row.
  const showAttentionMenu = isMember && channel.kind === 'channel';
  // Star + attention + archive form the management group; the separator below
  // fences them off from "Copy name" whenever any member action is present.
  const hasManagementMenu = showArchiveMenu || showAttentionMenu;

  // A `dm_channel` carries no tier (the backend 404s it and the batch omits it):
  // a DM is directed-grade throughout, so it always reads at full volume. For a
  // real channel the batch row is the ONLY authority — no default is resolved
  // here, not even once the suppressor is known, because a missing row does not
  // mean "no stored choice" (the batch COALESCEs that server-side). `undefined`
  // propagates to the badge, which renders nothing for it.
  const effectiveMode: ChannelAttentionMode | undefined =
    channel.kind === 'channel' ? attention?.effective_mode : 'all';
  // One number per row, and its volume. Non-members have no unread of their own.
  const badge = isMember
    ? channelRowBadge({
        effectiveMode,
        positionalUnread: unreadCount,
        directedUnread: attention?.directed_unread_count ?? 0,
      })
    : null;
  // A silenced row says so without being right-clicked — the title drops to the
  // muted ink. Subtractive on purpose: the row loses emphasis instead of gaining
  // an icon, and a directed badge still stands out against it.
  const isSilenced = effectiveMode === 'mute';

  const rowBg = selected
    ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
    : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary';

  const row = (
    <div
      data-row-selected={selected || undefined}
      className={
        // The NESTED glyph column (#task:1889): a channel under a workspace is
        // the ONLY row in the tree that indents. The tree has exactly one step to
        // spend and it is spent here, because this is the only boundary position
        // alone can carry — a workspace row and a channel row are the same size,
        // weight, colour and height, so on one column a workspace and its nine
        // channels read as one flat run. Indented, each workspace's children are
        // a block whose edges are the boundary (shiki, 2026-08-08). A per-level
        // staircase stays rejected: in a column this narrow it spends the width
        // on whitespace and reads as too many levels.
        'sidebar-row-border flex h-8 w-full items-stretch border pr-2 ' +
        NESTED_GLYPH_INSET +
        ' ' +
        // No `transition-colors`: selected/hover switch instantly (#task:1162).
        // Selected is a discrete, already-committed state — fading it over 150ms
        // is what read as the leaving-row "flicker" (and the entering row "slow
        // to light up"). A discrete state must commit instantly; only hover (a
        // pointer-driven continuous affordance) ever earned the fade, and the
        // cost of keeping it (the whole drag-time color-freeze apparatus) wasn't
        // worth it. Hover now switches instantly too.
        rowBg +
        (draggable ? ' cursor-grab select-none active:cursor-grabbing' : '')
      }
    >
      {/* Channel select button — grows to fill the row */}
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]"
      >
        <ChannelIcon
          variant="sticker"
          // Lock is opt-in for a private *regular* channel only. A `dm_channel`
          // is not a private channel, so it keeps the canonical `#` — pass the
          // visibility only when the row is a real channel.
          visibility={channel.kind === 'channel' ? channel.visibility : undefined}
          className={isClosed ? 'text-text-muted/50' : 'text-text-muted'}
        />
        <span
          className={
            'min-w-0 truncate ' +
            (isClosed
              ? 'line-through text-text-muted'
              : isSilenced && !selected
                ? 'text-text-muted'
                : '')
          }
        >
          {channel.title}
        </span>
        {badge ? (
          <UnreadBadge count={badge.count} tier={badge.tier} className="ml-auto" />
        ) : null}
      </button>
    </div>
  );

  return (
    <AppContextMenu trigger={row}>
      {/* One-way: this list never holds a starred channel (#task:1888 excludes it
          before render), so there is no Unstar state to reach here. Unstar lives on
          the STARRED row itself, where the channel actually is. */}
      <AppContextMenuItem
        icon={<Star className="size-3.5" />}
        onSelect={() => onStar(channel.id, true)}
      >
        Star
      </AppContextMenuItem>
      {/* Per-viewer attention preference — regular channels only (the backend
          404s dm_channel / thread). The tier comes from the workspace batch the
          badges already read, so opening this fires no request of its own. */}
      {showAttentionMenu ? (
        <AppContextMenuSub icon={<Bell className="size-3.5" />} label="Notifications">
          <ChannelAttentionMenuItems
            channelId={channel.id}
            mode={attention?.mode}
            workspaceMuted={workspaceMuted}
          />
        </AppContextMenuSub>
      ) : null}
      {showArchiveMenu ? (
        <AppContextMenuItem
          icon={
            isArchived ? (
              <ArchiveRestore className="size-3.5" />
            ) : (
              <Archive className="size-3.5" />
            )
          }
          disabled={archivePending}
          onSelect={() => onArchive(channel.id, !isArchived)}
        >
          {isArchived ? 'Restore' : 'Archive'}
        </AppContextMenuItem>
      ) : null}
      {hasManagementMenu ? <AppContextMenuSeparator /> : null}
      <AppContextMenuItem
        icon={<Copy className="size-3.5" />}
        onSelect={() => {
          void copyConversationName(channel.title);
        }}
      >
        Copy name
      </AppContextMenuItem>
    </AppContextMenu>
  );
}

// `workspaceKind` is now non-nullable in this file: a subtree only exists under a
// real workspace row, so the old "no workspace selected" arm (and its `null`
// gates on the archive menu / list key) has no reachable input here.
export type { ChannelNode };
