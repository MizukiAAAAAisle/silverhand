import { type ReactNode } from 'react';
import {
  type ChannelAttentionMode,
  type ChannelAttentionModeRowDto,
  type ConversationVisibility,
} from '@silverhand/shared';
import {
  Archive,
  ArchiveRestore,
  Bell,
  Copy,
  Plus,
  Star,
} from 'lucide-react';
import { toast } from 'sonner';
import { useSortable } from '@dnd-kit/sortable';
import { ChannelIcon } from '@/components/ChannelIcon';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
  AppContextMenuSub,
} from '@/components/menus/AppContextMenu';
import { ChannelAttentionMenuItems } from '@/components/layout/ChannelAttentionSurfaces';
import { SidebarSectionHeader, UnreadBadge } from '@/components/layout/sidebar-shared';
import { SortModeMenu } from '@/components/layout/SortModeMenu';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
  useListDragSort,
} from '@/components/layout/list-drag-sort';
import { Button } from '@/components/ui/button';
import { useChannelSortState, useSetSortMode } from '@/features/workspaces/hooks';
import { useWorkspaceAttentionModes } from '@/features/attention/hooks';
import { channelRowBadge } from '@/lib/attention-mode';
import { sortModeOf } from '@/lib/viewer-sort';
import { partitionHomeChannels } from '@/lib/home-grouping';

type WorkspaceUiKind = 'regular' | 'dm';

interface ChannelNode {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel';
  /** Identity-level visibility. `'private'` regular channels render a Lock
   *  glyph; `'public'` render the canonical `#`. Only meaningful for
   *  `kind === 'channel'` — a `dm_channel` is not a private *channel* and never
   *  shows the lock (see the render site). */
  visibility: ConversationVisibility;
  status: 'active' | 'idle' | 'crashed';
  closed_at: number | null;
  starred_at: number | null;
  archived_at: number | null;
  /** Creation time — stable fallback/tiebreak for sort modes (#task:1146). */
  created_at: number;
  /** Per-viewer membership. The discovery union mixes joined
   *  channels with active PUBLIC channels the viewer has NOT joined
   *  (`is_member: false`, browse-and-join). Member projections are FAIL-CLOSED
   *  (`is_member === true`): the unread badge (a member read-state projection)
   *  and the member/org context actions (Archive,
   *  Show-in-Activity) render only for an authoritative member; a non-member OR
   *  an unknown row shows neither. Local star + manual sort are viewer-local
   *  presentation state and STAY available for a visible unjoined public row
   *  (presentation state covers the discovery union). The backend stamps
   *  the field on every regular/DM item, so `undefined` only occurs on a stale
   *  payload — where fail-closed is the safe default. */
  is_member?: boolean;
}

interface ChannelsSidebarProps {
  /** null when no workspace is selected — used only to choose the empty
   *  hint copy. Workspace name + workspace-level actions live in the
   *  titlebar; channel-list-level actions (create + sort) live in this
   *  sidebar's own header (#task:1146). */
  workspaceName: string | null;
  /** The selected workspace id — drives the viewer's per-list sort state
   *  (`channels:<id>`) + reorder/mode mutations. null when none selected. */
  workspaceId: string | null;
  /** Active (non-archived) top-level channels, server-filtered. In the
   *  reply-cluster model a thread is no longer a conversation node, so it
   *  never appears in this tree — the sidebar only renders top-level
   *  channels / DM channels. Archived channels live
   *  on a dedicated chat tool page. */
  channels: ChannelNode[];
  workspaceKind: WorkspaceUiKind | null;
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  onStarChannel: (channelId: string, starred: boolean) => void;
  onArchiveChannel: (channelId: string, archived: boolean) => void;
  /** Create a channel — moved here from the titlebar (#task:1146). Absent
   *  when creation isn't applicable (no workspace selected / not in channel
   *  view); when absent the header shows the sort entry only. */
  onCreateChannel?: () => void;
  archivePending?: boolean;
  /** Unread notification counts keyed by channel id. Used to render
   *  per-channel badges. Missing key ≡ zero. */
  unreadByChannel?: Record<string, number>;
}

export function ChannelsSidebar({
  workspaceName,
  workspaceId,
  channels,
  workspaceKind,
  selectedChannelId,
  onSelectChannel,
  onStarChannel,
  onArchiveChannel,
  onCreateChannel,
  archivePending = false,
  unreadByChannel = {},
}: ChannelsSidebarProps): JSX.Element {
  const { data: viewerSort } = useChannelSortState(workspaceId, workspaceKind);
  const setSortMode = useSetSortMode();

  // ONE batch read of every channel tier in this workspace (#task:1870) — the
  // badges below need a tier per row, and the right-click menu needs the row's own
  // stored choice, so a per-channel GET would be both N requests and a second
  // carrier of the same fact.
  const { data: attentionModes } = useWorkspaceAttentionModes(workspaceId);
  const attentionByChannel = new Map(
    (attentionModes?.channels ?? []).map(c => [c.conversation_id, c]),
  );
  // `undefined` until the batch resolves — the third state the row must not
  // collapse into `false`, or every unresolved row fabricates the loudest tier.
  const workspaceMuted = attentionModes?.muted;

  const listKey = workspaceId ? `channels:${workspaceId}` : null;
  const mode = sortModeOf(viewerSort);

  // The sidebar renders top-level channels only (threads are reply clusters now,
  // never conversation nodes). Star is the personal ⭐ favorite, read off the
  // viewer's `viewer_sort.entries[].starred_at` (joined onto each node's
  // `starred_at` upstream in App.tsx), never a shared field (#task:1209). A
  // starred channel does NOT leave this sidebar (unlike a starred workspace/DM,
  // which moves into the global STARRED rail): it is PINNED into a local
  // `starred` hard group above `unstarred` (#task:1254, shiki dogfood — a
  // workspace-nested leaf keeps its parent context). Within each group the
  // viewer's sort mode orders the rows — recent-opened `last_accessed_at` or
  // manual drag `rank`. See docs/list-sort-v1.md. The drag state machine lives in
  // useListDragSort — shared with the workspace rail so the CDP-tuned drop
  // invariants can't drift.
  const { starred: starredTopLevel, unstarred: unstarredTopLevel } =
    partitionHomeChannels(channels);
  const topLevelCount = starredTopLevel.length + unstarredTopLevel.length;
  const { orderedGroups, onReorder } = useListDragSort<'starred' | 'unstarred', ChannelNode>({
    listKey,
    groups: { starred: starredTopLevel, unstarred: unstarredTopLevel },
    viewerSort,
    getId: c => c.id,
    getCreatedAt: c => c.created_at,
  });
  const starredTop = orderedGroups.starred;
  const unstarredTop = orderedGroups.unstarred;

  const rowProps = {
    selectedChannelId,
    onSelect: onSelectChannel,
    onStar: onStarChannel,
    onArchive: onArchiveChannel,
    archivePending,
    workspaceKind,
    unreadByChannel,
    attentionByChannel,
    workspaceMuted,
  };

  const renderGroup = (
    group: ChannelNode[],
    groupKey: 'starred' | 'unstarred',
  ): ReactNode => {
    if (listKey) {
      const ids = group.map(c => c.id);
      return (
        <SortableGroup ids={ids} onReorder={ordered => onReorder(groupKey, ordered)}>
          {group.map(channel => (
            <SortableChannelItem key={channel.id} channel={channel} {...rowProps} />
          ))}
        </SortableGroup>
      );
    }
    return group.map(channel => (
      <ChannelTreeItem key={channel.id} channel={channel} {...rowProps} />
    ));
  };

  return (
    <aside
      data-sidebar="channels"
      className="flex h-full w-[var(--channels-sidebar-width)] shrink-0 flex-col bg-[var(--bg-sessions-sidebar)]"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
    >
      {workspaceName ? (
        <div className="shrink-0 px-1.5 pt-1.5">
          <SidebarSectionHeader
            label="CHANNELS"
            count={topLevelCount}
            action={
              <span className="flex items-center">
                <SortModeMenu
                  mode={mode}
                  onChange={m =>
                    listKey && setSortMode.mutate({ list_key: listKey, mode: m })
                  }
                />
                {onCreateChannel ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={onCreateChannel}
                    aria-label="New channel"
                    title="New channel"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                ) : null}
              </span>
            }
          />
        </div>
      ) : null}

      <div className="scrollbar-hide flex-1 overflow-y-auto px-1.5 pb-1.5">
        {!workspaceName ? (
          <EmptyHint message="Select a workspace" />
        ) : topLevelCount === 0 ? (
          <EmptyHint message="No channels yet. Use + to create one." />
        ) : (
          <ul className="space-y-0.5">
            {renderGroup(starredTop, 'starred')}
            {starredTop.length > 0 && unstarredTop.length > 0 ? (
              <li>
                <div className="mx-2 my-1 border-t border-border-subtle" />
              </li>
            ) : null}
            {renderGroup(unstarredTop, 'unstarred')}
          </ul>
        )}
      </div>
    </aside>
  );
}

function EmptyHint({ message }: { message: string }): JSX.Element {
  return (
    <div className="px-2 py-3 text-center text-xs text-text-muted">{message}</div>
  );
}

interface RowChildProps {
  selectedChannelId: string | null;
  onSelect: (id: string) => void;
  onStar: (channelId: string, starred: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind | null;
  unreadByChannel: Record<string, number>;
  /** This workspace's channel tiers, keyed by conversation id. Missing key ≡ the
   *  row has no tier of its own (a `dm_channel`, or the batch hasn't landed). */
  attentionByChannel: ReadonlyMap<string, ChannelAttentionModeRowDto>;
  /** The workspace suppressor, `undefined` until the tier batch resolves. Rows keep
   *  their own stored tier checked while it is on; only the resolved volume
   *  changes. */
  workspaceMuted: boolean | undefined;
}

function ChannelTreeItem({
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
  return (
    <li>
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
      />
    </li>
  );
}

// Animate sibling rows WHILE sorting (the smooth "make way" slide as you drag
// over them), but skip dnd-kit's post-drop settle animation — see
// `animateLayoutChanges` in list-drag-sort.tsx (shared with the rail).

/** Drag-sortable row for manual ordering. The `<li>` is BOTH the sortable
 *  node (`setNodeRef`) AND the drag surface — the dnd-kit `attributes` +
 *  `listeners` live here, not on the inner row, so they don't have to pass
 *  through the Radix context-menu `Slot` (which was swallowing the pointer
 *  activation). The whole row drags (no grip — per shiki); a 4px pointer
 *  activation distance keeps a plain click selecting. Vertical-only. The drag
 *  STYLE (transform/opacity-lift) comes from the shared list-drag-sort helpers
 *  so it stays identical to the rail's row. */
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
  workspaceKind: WorkspaceUiKind | null;
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
  const isStarred = channel.starred_at !== null;
  const isArchived = channel.archived_at !== null;
  // Fail-closed membership gate: member/org actions render only for
  // an authoritative member. A browse-only public row (is_member === false) — or
  // an unknown row — keeps only the presentation-state actions (Star) + read-side
  // Copy name. Star + manual drag-sort are viewer-local and stay available.
  const isMember = channel.is_member === true;
  // Archive/Restore is a channel-like organization action (#task:1145):
  // it applies to any top-level channel-like row — `channel` in a regular
  // workspace AND `dm_channel` in an agent_home/DM — and only excludes
  // threads. `channel.kind` is the precise discriminant, so we no longer
  // gate on the workspace `workspaceKind` beyond "a workspace is selected".
  // Non-members can't organize a channel they haven't joined (the backend
  // 403s), so it is member-gated.
  const showArchiveMenu =
    isMember &&
    workspaceKind !== null &&
    (channel.kind === 'channel' || channel.kind === 'dm_channel');
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
        'sidebar-row-border flex h-8 w-full items-stretch border px-2 ' +
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
      <AppContextMenuItem
        icon={<Star className={'size-3.5' + (isStarred ? ' fill-current' : '')} />}
        onSelect={() => onStar(channel.id, !isStarred)}
      >
        {isStarred ? 'Unstar' : 'Star'}
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
          void copyChannelName(channel.title);
        }}
      >
        Copy name
      </AppContextMenuItem>
    </AppContextMenu>
  );
}

async function copyChannelName(name: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(name);
    toast.success('Name copied');
  } catch {
    toast.error("Couldn't copy the name");
  }
}
