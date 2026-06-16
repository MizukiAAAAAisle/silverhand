import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Hash,
  MessageSquarePlus,
  Pin,
  PinOff,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  defaultAnimateLayoutChanges,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import {
  AppContextMenu,
  AppContextMenuItem,
  AppContextMenuSeparator,
} from '@/components/menus/AppContextMenu';
import { SidebarSectionHeader } from '@/components/layout/sidebar-shared';
import { SortModeMenu } from '@/components/layout/SortModeMenu';
import { Button } from '@/components/ui/button';
import {
  useChannelSortState,
  useReorderSort,
  useSetSortMode,
  useApplySortOrder,
} from '@/features/workspaces/hooks';
import { sortEntryLookup, sortGroup, sortModeOf } from '@/lib/viewer-sort';

type WorkspaceUiKind = 'regular' | 'dm';

interface ChannelNode {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel' | 'thread';
  status: 'active' | 'idle' | 'crashed';
  parent_channel_id: string | null;
  closed_at: number | null;
  pinned_at: number | null;
  archived_at: number | null;
  /** Creation time — stable fallback/tiebreak for sort modes (#task:1146). */
  created_at: number;
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
   *  channels / DM channels. Any legacy `kind='thread'` row (which carries
   *  a `parent_channel_id`) is filtered out below. Archived channels live
   *  on a dedicated chat tool page. */
  channels: ChannelNode[];
  workspaceKind: WorkspaceUiKind | null;
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  onPinChannel: (channelId: string, pinned: boolean) => void;
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
  onPinChannel,
  onArchiveChannel,
  onCreateChannel,
  archivePending = false,
  unreadByChannel = {},
}: ChannelsSidebarProps): JSX.Element {
  const { data: viewerSort } = useChannelSortState(workspaceId, workspaceKind);
  const setSortMode = useSetSortMode();
  const reorderSort = useReorderSort();
  const applySortOrder = useApplySortOrder();

  const listKey = workspaceId ? `channels:${workspaceId}` : null;
  const mode = sortModeOf(viewerSort);
  const lookup = sortEntryLookup(viewerSort);

  // The sidebar renders top-level channels only (threads are reply clusters
  // now, never conversation nodes). Pinned channels are a hard top group;
  // within each group the viewer's sort mode orders the rows — recent-opened
  // (last_accessed_at) or manual drag (rank). See docs/list-sort-v1.md.
  //
  // A drop applies its new order to LOCAL state (`pendingDrop`) synchronously
  // inside the onDragEnd event — see onReorder for why. That override is laid
  // on top of the cache-derived order here, and self-clears once the cache
  // catches up (effect below). Outside the bridge window the cache stays the
  // sole render source, so mode switches / pin / other-device / error-refetch
  // all flow through normally.
  const [pendingDrop, setPendingDrop] = useState<{
    listKey: string;
    pinned?: string[];
    unpinned?: string[];
  } | null>(null);

  const applyPendingOrder = (
    sorted: ChannelNode[],
    groupKey: 'pinned' | 'unpinned',
  ): ChannelNode[] => {
    const override =
      pendingDrop && pendingDrop.listKey === listKey ? pendingDrop[groupKey] : undefined;
    if (!override) return sorted;
    const pos = new Map(override.map((id, i) => [id, i] as const));
    return [...sorted].sort(
      (a, b) =>
        (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  };

  const topLevel = channels.filter(s => s.parent_channel_id === null);
  const sortCh = (items: ChannelNode[], groupKey: 'pinned' | 'unpinned'): ChannelNode[] =>
    applyPendingOrder(sortGroup(items, mode, c => c.id, c => c.created_at, lookup), groupKey);
  const pinnedTop = sortCh(
    topLevel.filter(s => s.pinned_at !== null),
    'pinned',
  );
  const unpinnedTop = sortCh(
    topLevel.filter(s => s.pinned_at === null),
    'unpinned',
  );

  // Drop the override once the cache-derived order matches it (cache caught up,
  // a microtask after the drop) — at which point it is a no-op and re-render is
  // invisible. This is Alice's reconcile rule: our own optimistic write makes
  // derived == override, so clearing causes no thrash.
  useEffect(() => {
    if (!pendingDrop) return;
    if (pendingDrop.listKey !== listKey) {
      setPendingDrop(null);
      return;
    }
    const settled = (groupKey: 'pinned' | 'unpinned', items: ChannelNode[]): boolean => {
      const override = pendingDrop[groupKey];
      if (!override) return true;
      const derived = sortGroup(items, mode, c => c.id, c => c.created_at, lookup).map(c => c.id);
      return derived.length === override.length && derived.every((id, i) => id === override[i]);
    };
    if (
      settled('pinned', topLevel.filter(s => s.pinned_at !== null)) &&
      settled('unpinned', topLevel.filter(s => s.pinned_at === null))
    ) {
      setPendingDrop(null);
    }
  }, [pendingDrop, listKey, mode, lookup, topLevel]);

  // True from the drop event until the cache catches up (pendingDrop clears) —
  // the post-drop "bridge" window. We extend the color-transition freeze across
  // it: on the drop frame the active row briefly loses `:hover` (its new slot
  // isn't under the pointer for one frame on downward drags), and if
  // `transition-colors` is live then, the recovery animates a 150ms fade =
  // residual flicker. `isSorting` alone flips false exactly on that frame
  // (dnd clears active), so it can't cover it; `bridging` does. See ChannelRow.
  const bridging = pendingDrop !== null && pendingDrop.listKey === listKey;

  const rowProps = {
    selectedChannelId,
    onSelect: onSelectChannel,
    onPin: onPinChannel,
    onArchive: onArchiveChannel,
    archivePending,
    workspaceKind,
    unreadByChannel,
    bridging,
  };

  // A drag is an explicit "I want to arrange these myself" action, so rows
  // are draggable in BOTH modes — gating it behind a mode toggle reads as a
  // bug (shiki + Cindy). Committing an order also flips the list to Manual
  // atomically on the backend (`PUT /api/sort/order` sets mode=manual, per
  // Alice).
  //
  // Render-order ordering on drop must change in the SAME React commit as
  // dnd-kit's internal drag-reset, or a 1-frame desync flickers on fast
  // release: dnd clears the active row's transform immediately (frame N), but
  // the cache-driven reorder lands a frame later (frame N+1) because React
  // Query's observer notify is microtask-batched — so for one frame the row
  // snaps back to its OLD slot, then jumps to the new one (Cindy's CDP, B-type;
  // flushSync can't fix it — there's nothing pending to flush). The fix:
  // `setPendingDrop` is React state set inside this event handler, so it
  // batches with dnd's reset into one commit → DOM reorders the same frame the
  // transform clears. INVARIANT: drop-time list reorder must be driven by
  // synchronous local state (`pendingDrop`) in the same onDragEnd React commit.
  // Do not collapse this back to pure `setQueryData` or any async-store-driven
  // reorder, or transform clearing and DOM reordering split by one frame and
  // the B-type desync returns (see docs/list-sort-v1.md §Renderer composition).
  // The cache write (applySortOrder) + mutation are pure persistence; the
  // override self-clears once the cache catches up. On error, drop the override
  // so the invalidate-driven revert to the old order shows.
  const onReorder = (groupKey: 'pinned' | 'unpinned', ordered: string[]): void => {
    if (!listKey) return;
    setPendingDrop(prev => ({
      ...(prev && prev.listKey === listKey ? prev : { listKey }),
      listKey,
      [groupKey]: ordered,
    }));
    applySortOrder(listKey, ordered);
    reorderSort.mutate(
      { list_key: listKey, group: groupKey, ordered_ids: ordered },
      { onError: () => setPendingDrop(null) },
    );
  };

  const renderGroup = (
    group: ChannelNode[],
    groupKey: 'pinned' | 'unpinned',
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
            count={topLevel.length}
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
                    onClick={onCreateChannel}
                    aria-label="新建 Channel"
                    title="新建 Channel"
                  >
                    <MessageSquarePlus className="size-3.5" />
                  </Button>
                ) : null}
              </span>
            }
          />
        </div>
      ) : null}

      <div className="scrollbar-hide flex-1 overflow-y-auto px-1.5 pb-1.5">
        {!workspaceName ? (
          <EmptyHint message="选择左侧 Workspace" />
        ) : topLevel.length === 0 ? (
          <EmptyHint message="还没有 Channel。点 + 开始" />
        ) : (
          <ul className="space-y-0.5">
            {renderGroup(pinnedTop, 'pinned')}
            {pinnedTop.length > 0 && unpinnedTop.length > 0 ? (
              <li>
                <div className="mx-2 my-1 border-t border-border-subtle" />
              </li>
            ) : null}
            {renderGroup(unpinnedTop, 'unpinned')}
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
  onPin: (channelId: string, pinned: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind | null;
  unreadByChannel: Record<string, number>;
  /** Post-drop bridge window (see ChannelsSidebar). Threaded to
   *  SortableChannelItem to extend the color-transition freeze past the drop
   *  frame. Ignored by the non-sortable ChannelTreeItem. */
  bridging: boolean;
}

function ChannelTreeItem({
  channel,
  selectedChannelId,
  onSelect,
  onPin,
  onArchive,
  archivePending,
  workspaceKind,
  unreadByChannel,
}: { channel: ChannelNode } & RowChildProps): JSX.Element {
  return (
    <li>
      <ChannelRow
        channel={channel}
        selected={channel.id === selectedChannelId}
        onClick={() => onSelect(channel.id)}
        onPin={onPin}
        onArchive={onArchive}
        archivePending={archivePending}
        workspaceKind={workspaceKind}
        unreadCount={unreadByChannel[channel.id] ?? 0}
      />
    </li>
  );
}

// Animate sibling rows WHILE sorting (the smooth "make way" slide as you drag
// over them), but skip dnd-kit's post-drop settle animation. We reorder the
// data synchronously on drop, so the row is already in its final DOM slot — a
// settle would then animate a leftover transform→0, the visible "jump" (worst
// on the row that lands at the top, largest displacement). Per Alice + Cindy:
// keep the sort animation, kill only the settle (a full DragOverlay is the
// last-resort if during-drag feel ever regresses).
const animateLayoutChanges: AnimateLayoutChanges = args =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

/** Drag-sortable row for manual ordering. The `<li>` is BOTH the sortable
 *  node (`setNodeRef`) AND the drag surface — the dnd-kit `attributes` +
 *  `listeners` live here, not on the inner row, so they don't have to pass
 *  through the Radix context-menu `Slot` (which was swallowing the pointer
 *  activation). The whole row drags (no grip — per shiki); a 4px pointer
 *  activation distance keeps a plain click selecting. Vertical-only. */
function SortableChannelItem({
  channel,
  selectedChannelId,
  onSelect,
  onPin,
  onArchive,
  archivePending,
  workspaceKind,
  unreadByChannel,
  bridging,
}: { channel: ChannelNode } & RowChildProps): JSX.Element {
  const {
    setNodeRef,
    transform,
    transition,
    isDragging,
    isSorting,
    attributes,
    listeners,
  } = useSortable({ id: channel.id, animateLayoutChanges });
  // No DragOverlay (reverted — overlay regressed tracking/visibility, and the
  // in-place version is already crisp on a controlled release). The row itself
  // translates with the pointer; keep zIndex + relative so it stays above
  // siblings as it crosses them. Dim it to 0.6 while dragging as a "lifted"
  // affordance (shiki). NOTE: a dim was removed once because the 0.6→1 restore
  // on release could read as a one-frame pop; re-added deliberately now that the
  // desync / color flickers are gone — if the release frame ever pops, add a
  // `transition-opacity` settle. Crispness otherwise comes from the sibling-only
  // hover-color freeze (see `freezeColorValue`) + the animateLayoutChanges guard.
  const style: CSSProperties = {
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? 1 : undefined,
    position: isDragging ? 'relative' : undefined,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="touch-none"
      {...attributes}
      {...listeners}
    >
      <ChannelRow
        channel={channel}
        selected={channel.id === selectedChannelId}
        onClick={() => onSelect(channel.id)}
        onPin={onPin}
        onArchive={onArchive}
        archivePending={archivePending}
        workspaceKind={workspaceKind}
        unreadCount={unreadByChannel[channel.id] ?? 0}
        draggable
        freezeColorTransition={isSorting || bridging}
        freezeColorValue={isSorting && !isDragging}
      />
    </li>
  );
}

function SortableGroup({
  ids,
  onReorder,
  children,
}: {
  ids: string[];
  onReorder: (orderedIds: string[]) => void;
  children: ReactNode;
}): JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return;
        const oldIndex = ids.indexOf(String(active.id));
        const newIndex = ids.indexOf(String(over.id));
        if (oldIndex < 0 || newIndex < 0) return;
        // Always send the COMPLETE group order — the backend requires
        // ordered_ids set-equal to the live group (#task:1147).
        onReorder(arrayMove(ids, oldIndex, newIndex));
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

function ChannelRow({
  channel,
  selected,
  onClick,
  onPin,
  onArchive,
  archivePending,
  workspaceKind,
  unreadCount,
  draggable,
  freezeColorTransition = false,
  freezeColorValue = false,
}: {
  channel: ChannelNode;
  selected: boolean;
  onClick: () => void;
  onPin: (channelId: string, pinned: boolean) => void;
  onArchive: (channelId: string, archived: boolean) => void;
  archivePending: boolean;
  workspaceKind: WorkspaceUiKind | null;
  unreadCount: number;
  /** Manual mode: show the grab cursor so the row reads as draggable. The
   *  drag listeners live on the parent `<li>`, not here. */
  draggable?: boolean;
  /* COLOR-FREEZE MODEL — two orthogonal axes (frame-level CDP narrative in
   * docs/list-sort-v1.md §Renderer composition). Rows shuffle under a
   * near-stationary pointer during a drag, so `:hover` / selected bg recompute
   * as a row slides under the cursor — and with `transition-colors` live that
   * recompute plays a ~150ms fade (the post-drop flicker). Two independent
   * freezes suppress it:
   *
   *     what \ when    →  freeze prop
   *     transition     →  freezeColorTransition  (all rows, drag + bridge)
   *     value (:hover) →  freezeColorValue       (siblings only, during drag)
   *
   * GUARDRAIL — these MUST stay two separate signals; do NOT collapse them.
   * The active row keeps its REAL hover/selected VALUE the whole time (it sits
   * under the cursor), with only its transition frozen. Freezing its value too
   * would create a value delta at the un-freeze boundary that the re-armed
   * transition animates → the fade reappears, just relocated to the bridge-end
   * frame. So: transition-freeze = all rows, value-freeze = siblings only. */
  /** Freeze the color TRANSITION (drop `transition-colors`). True for EVERY row
   *  across the drag AND the post-drop bridge (`isSorting || bridging`) — the
   *  bridge half covers the drop frame, where on downward drags the active row
   *  briefly loses `:hover` while `isSorting` has already flipped false. */
  freezeColorTransition?: boolean;
  /** Freeze the color VALUE — strip `:hover` + hide the hover-pin. SIBLINGS
   *  only (`isSorting && !isDragging`); never the active row (see guardrail). */
  freezeColorValue?: boolean;
}): JSX.Element {
  const isClosed = channel.closed_at !== null;
  const isPinned = channel.pinned_at !== null;
  const isArchived = channel.archived_at !== null;
  const [hovered, setHovered] = useState(false);

  // Pin control shows on hover or when already pinned — but NEVER mid-drag for
  // siblings (its opacity fade is a flicker source the value-freeze covers; see
  // freezeColorValue).
  const showPin = isPinned || (hovered && !freezeColorValue);
  // Archive/Restore is a channel-like organization action (#task:1145):
  // it applies to any top-level channel-like row — `channel` in a regular
  // workspace AND `dm_channel` in an agent_home/DM — and only excludes
  // threads. `channel.kind` is the precise discriminant, so we no longer
  // gate on the workspace `workspaceKind` beyond "a workspace is selected".
  const showArchiveMenu =
    workspaceKind !== null &&
    (channel.kind === 'channel' || channel.kind === 'dm_channel');
  const hasManagementMenu = showArchiveMenu;

  // Siblings mid-drag: drop the hover classes so a row sliding under the pointer
  // can't paint a hover bg (and can't transition back out on drop). Value-freeze
  // — siblings only; see freezeColorValue.
  const rowBg = selected
    ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
    : freezeColorValue
      ? 'border-transparent text-text-secondary'
      : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary';

  const row = (
    <div
      data-row-selected={selected || undefined}
      className={
        'sidebar-row-border flex w-full items-stretch border ' +
        // Freeze the color transition on every row during the drag + bridge so
        // any hover/selected recompute lands instantly (no ~150ms fade). The
        // active row keeps its real value, only its transition frozen; siblings
        // also freeze the value (rowBg above). See freezeColorTransition.
        (freezeColorTransition ? '' : 'transition-colors ') +
        rowBg +
        (draggable ? ' cursor-grab select-none active:cursor-grabbing' : '')
      }
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Channel select button — grows to fill the row */}
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 text-left text-sm"
      >
        <Hash
          data-channel-icon
          className={
            'size-3.5 shrink-0 ' +
            (isClosed ? 'text-text-muted/50' : 'text-text-muted')
          }
        />
        <span
          className={
            'min-w-0 truncate ' + (isClosed ? 'line-through text-text-muted' : '')
          }
        >
          {channel.title}
        </span>
        {unreadCount > 0 && !selected ? (
          <span data-sidebar-unread className="ml-auto shrink-0 min-w-[16px] rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-[16px] text-text-on-accent">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {/* Pin button — sibling, not nested. Reserves fixed width so the
          title doesn't shift on hover. */}
      <button
        type="button"
        aria-label={isPinned ? '取消固定' : '固定'}
        title={isPinned ? '取消固定' : '固定'}
        onClick={e => {
          e.stopPropagation();
          onPin(channel.id, !isPinned);
        }}
        className={
          'group/pin flex shrink-0 items-center justify-center px-1 ' +
          (!showPin ? 'pointer-events-none opacity-0' : '') +
          (selected
            ? isPinned
              ? ' text-text-on-selected'
              : ' text-text-on-selected/60 hover:text-text-on-selected'
            : isPinned
              ? ' text-accent'
              : ' text-text-muted hover:text-text-primary')
        }
        tabIndex={showPin ? 0 : -1}
      >
        {isPinned ? (
          <PinOff data-pin-icon className="size-3 transition-transform group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]" />
        ) : (
          <Pin data-pin-icon className="size-3 transition-transform group-hover/pin:scale-125 group-hover/pin:[stroke-width:2.5]" />
        )}
      </button>
    </div>
  );

  return (
    <AppContextMenu trigger={row}>
      <AppContextMenuItem
        icon={
          isPinned ? (
            <PinOff className="size-3.5" />
          ) : (
            <Pin className="size-3.5" />
          )
        }
        onSelect={() => onPin(channel.id, !isPinned)}
      >
        {isPinned ? 'Unpin' : 'Pin'}
      </AppContextMenuItem>
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
    toast.success('已复制名称');
  } catch {
    toast.error('复制名称失败');
  }
}
