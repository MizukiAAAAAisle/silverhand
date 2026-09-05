// One workspace's channel children in the MERGED single-column sidebar
// (#task:1889). This file is what the retired `ChannelsSidebar.tsx` (the second
// column) became: the row vocabulary, the badge path and the drag group are
// ported unchanged — only the mounting story is new.
//
// LAZY BY MOUNT. Every per-workspace read THIS SUBTREE needs lives inside it, so a
// collapsed workspace renders nothing and this subtree fetches nothing; expanding
// mounts the component and its three queries fire together. The sort menu is a
// sibling in the header and is likewise rendered only while expanded — mounting it
// collapsed would re-introduce the request (it reads the same `channelsKey` cache),
// and the collapsed render (below) shows a partial set with no order to choose.
//
// ONE EXCEPTION, bounded to the workspace you are currently in: collapsing the
// branch that holds the open channel keeps that ONE row on screen (`collapsed`
// render, `pokeUnread` off), so this subtree stays mounted there and its three
// queries stay
// armed while collapsed. That is the price of the invariant "the selected row is
// always visible in the sidebar" (shiki, 2026-08-08) — the sidebar otherwise shows
// no selection at all while the main pane shows that channel. It is bounded: at
// most one branch in the whole tree can hold the selection, it is the workspace
// the user is looking at (its caches are warm), and every OTHER collapsed
// workspace stays fully lazy.
//
// SECOND EXCEPTION, the collapsed poke-out (#task:1939): a collapsed branch whose
// workspace attention badge is lit (`workspace.unread > 0`) also mounts, and renders
// the rows that lit it — the `loud` unread ones — beside the kept selection. The
// badge is the WAKE GATE: it is already loaded on the rail, so the decision to mount
// costs no fetch, and the reveal set reuses `channelRowBadge`'s `loud` verdict, so it
// is the same fact the workspace badge sums (Σ loud rows = badge_count). Bounded like
// the first exception: only branches that actually have loud unread mount, and a
// workspace whose ONLY loud row is starred mounts, finds nothing to show (STARRED
// already moved that row out) and renders empty — a wasted query, never a visible
// signal. That empty case is the precondition for the badge staying an INVISIBLE wake
// gate (see WorkspacesPanel's header, which paints no number/dot).
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
import { Plus } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { ChannelIcon } from '@/components/ChannelIcon';
import { AppContextMenu } from '@/components/menus/AppContextMenu';
import { ChannelRowMenuItems } from './ChannelRowMenuItems';
import {
  ConversationRowLayout,
  NESTED_GLYPH_INSET,
  MutedMarker,
  UnreadBadge,
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
import { channelRowBadge, type RowBadge } from '@/lib/attention-mode';
import { sortModeOf } from '@/lib/viewer-sort';
import { collapsedRevealRows, excludeStarredChannels } from '@/lib/home-grouping';

interface ChannelNode {
  id: string;
  title: string;
  roster_policy: 'open' | 'fixed';
  /** Identity-level visibility. `'private'` regular channels render a Lock
   *  glyph; `'public'` render the canonical `#`. Only meaningful for
   *  `roster_policy === 'open'` — a fixed-roster conversation is not a private *channel* and never
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
 *
 * Mounts only inside a RESOLVED workspace row's header (`WorkspacesPanel` maps
 * over the list it already holds), which is why the `workspaceResolved` argument
 * below is a literal `true` — same invariant, same origin as the one stated in
 * {@link WorkspaceChannels} (@Paul, #task:2078 F2).
 */
export function ChannelSortMenu({
  workspaceId,
}: {
  workspaceId: string;
}): JSX.Element {
  const { data: viewerSort } = useChannelSortState(workspaceId, true);
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
  /** The conversation the tree is currently FILLing, or null. One id for the
   *  whole tree (the spec's single-highlight rule), so at most one row in one
   *  workspace can match. */
  selectedChannelId: string | null;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  /** Create a channel in THIS workspace — the empty-state action, and the
   *  compensation for `/chat/w/:id` having no highlight of its own. */
  onCreateChannel: (workspaceId: string) => void;
  /** COLLAPSED partial render: show only a subset — no drag, no sort, no empty-state
   *  action (see the file header). Always keeps the open channel's row; a starred
   *  selection is excluded and shows in STARRED, so it may render nothing. Both a
   *  collapsed SECTION and a collapsed BRANCH pass this. */
  collapsed?: boolean;
  /** Poke this branch's `loud` unread rows out on top of the kept selection
   *  (#task:1939). Read ONLY while `collapsed`. MUST be the branch's WAKE GATE (the
   *  lit workspace badge), never `!expanded`: a branch collapses-and-mounts to keep
   *  the selection with a DARK badge, and gating the poke on "collapsed" would reveal
   *  a stale `loud` sibling with no wake signal (`collapsedRevealRows` docblock). */
  pokeUnread?: boolean;
  /** A leading node (a workspace caption) shown ABOVE the revealed rows in the
   *  collapsed render — but ONLY when the reveal set is non-empty (#task:1939, @Cindy
   *  MUST FIX). It is co-fated with the rows on purpose: the collapsed GROUP mounts a
   *  branch on its WAKE GATE (`workspace.unread > 0`, an aggregate), which can be lit
   *  while this branch's row-level reveal is empty — its only loud row is STARRED
   *  (moved out), or the row queries are loading / failed. Rendering the caption
   *  beside the branch (before this component) would then leave a lone title with no
   *  channels under it — a visible signal with nothing to point at, breaking
   *  "starred-only only spins, shows no signal" and "loading/failure fabricates
   *  nothing". Passing it HERE binds it to the same `revealed.length > 0` gate the
   *  rows use, so no-rows ⟹ no-caption by construction. Only the collapsed GROUP
   *  passes it (to attribute a non-current branch's rows); the branch level does not. */
  revealCaption?: ReactNode;
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
  selectedChannelId,
  onSelectChannel,
  onCreateChannel,
  collapsed = false,
  pokeUnread = false,
  revealCaption,
}: WorkspaceChannelsProps): JSX.Element {
  // The `workspaceResolved` argument is a literal `true` throughout this file: a
  // subtree only ever mounts UNDER a resolved workspace row (WorkspacesPanel maps
  // over the list it already has), so "id known, row not yet" — the window the
  // argument exists to hold queries off for — is unreachable here. It is passed
  // explicitly rather than defaulted, so the assertion is stated at the call site
  // (#task:2078).
  const { data: items = [] } = useChannelsForWorkspace(workspaceId, true);
  const { data: viewerSort } = useChannelSortState(workspaceId, true);
  // ONE batch read of every channel tier in this workspace (#task:1870) — the
  // badges need a tier per row and the right-click menu needs the row's own
  // stored choice, so a per-channel GET would be both N requests and a second
  // carrier of the same fact.
  const { data: attentionModes } = useWorkspaceAttentionModes(workspaceId);
  const { data: unreadData } = useMessageUnreadCounts(workspaceId, true);
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
      roster_policy: s.roster_policy,
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

  // Collapsed render (see the file header's two exceptions). `collapsed` shows a
  // partial set: the open channel's row, plus — only when `pokeUnread` is on — this
  // branch's `loud` unread rows. Both drop drag / sort / empty-state on purpose: a
  // partial set has no order to reorder, and a collapsed branch must not offer "New
  // channel" — the one thing it may still say is where you are and what is shouting.
  // The reveal filter reuses `channelNodeBadge` (the exact predicate the row paints),
  // so the poked-out set is the same `loud` fact the workspace wake badge sums.
  // `ordered` is already starred-excluded (`excludeStarredChannels`), so a starred
  // selection or a starred loud row never surfaces here — the accepted empty-reveal
  // case. `pokeUnread` is the WAKE GATE, never `!expanded` (see its prop docblock).
  if (collapsed) {
    const revealed = collapsedRevealRows(ordered, {
      pokeUnread,
      isSelected: c => c.id === selectedChannelId,
      // Same-source with the row paint: a row pokes out iff the badge it would
      // show is `loud` (`channelNodeBadge`), which is exactly what it contributes
      // to the workspace wake badge. With `pokeUnread` off (a collapsed section, or
      // a branch kept only for its selection) only the selected row survives.
      isLoud: c =>
        channelNodeBadge(
          c,
          attentionByChannel.get(c.id),
          unreadByChannel[c.id] ?? 0,
        )?.tier === 'loud',
    });
    if (revealed.length === 0) return <></>;
    return (
      <>
        {/* Co-fated with the rows: only reached because `revealed` is non-empty, so a
            wake-gate-lit-but-empty branch (starred-only loud, or loading/failure)
            renders NEITHER caption nor rows — no orphan title (see `revealCaption`). */}
        {revealCaption}
        {revealed.map(c => (
          <li key={c.id}>
            <ChannelRow
              channel={c}
              selected={c.id === selectedChannelId}
              onClick={() => onSelectChannel(c.id, workspaceId)}
              onStar={(channelId, starred) => starChannel.mutate({ channelId, starred })}
              onArchive={(channelId, archived) =>
                archiveChannel.mutate({ channelId, archived, workspaceId })
              }
              archivePending={archiveChannel.isPending}
              unreadCount={unreadByChannel[c.id] ?? 0}
              attention={attentionByChannel.get(c.id)}
              workspaceMuted={workspaceMuted}
            />
          </li>
        ))}
      </>
    );
  }

  if (ordered.length === 0) {
    // An expanded workspace with nothing to show offers the action instead of a
    // dead "No channels yet" line — the same affordance `/chat/w/:id` needs.
    return (
      <li>
        <button
          type="button"
          onClick={() => onCreateChannel(workspaceId)}
          className={
            'flex h-7 w-full items-center gap-1.5 text-left text-xs text-text-muted hover:text-text-primary ' +
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
        unreadCount={unreadByChannel[channel.id] ?? 0}
        attention={attentionByChannel.get(channel.id)}
        workspaceMuted={workspaceMuted}
        draggable
      />
    </li>
  );
}

/** The unread badge a channel row shows, or `null`. Extracted so the collapsed
 *  poke-out reveal filter (`WorkspaceChannels`) paints from the EXACT same predicate
 *  the row does: a row is revealed while collapsed iff the badge it would show is
 *  `loud`, and `loud` is precisely what a row contributes to its workspace's wake
 *  badge (`channelRowBadge`'s Σ invariant). Folds in the member gate — a browse-only
 *  public row (non-member, or an unknown row on a stale payload) has no unread of its
 *  own — and the `dm_channel`'s unconditional `'all'` tier. Missing/unresolved
 *  attention leaves `effective_mode` undefined, which `channelRowBadge` renders as
 *  nothing: a loading batch reveals no rows rather than fabricating unread. */
function channelNodeBadge(
  channel: ChannelNode,
  attention: ChannelAttentionModeRowDto | undefined,
  unreadCount: number,
): RowBadge | null {
  if (channel.is_member !== true) return null;
  const effectiveMode: ChannelAttentionMode | undefined =
    channel.roster_policy === 'open' ? attention?.effective_mode : 'all';
  return channelRowBadge({
    effectiveMode,
    positionalUnread: unreadCount,
    directedUnread: attention?.directed_unread_count ?? 0,
  });
}

function ChannelRow({
  channel,
  selected,
  onClick,
  onStar,
  onArchive,
  archivePending,
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
  unreadCount: number;
  /** This row's tier from the workspace batch, or `undefined` when it has none.
   *  Carries BOTH the stored `mode` (what the marker paints) and the folded
   *  `effective_mode` (what the badge weighs) — see `isSilenced` below. */
  attention?: ChannelAttentionModeRowDto;
  /** The workspace suppressor, `undefined` until the tier batch resolves. */
  workspaceMuted: boolean | undefined;
  /** Grab cursor — set by `SortableChannelItem` alone; the collapsed-reveal row
   *  has nothing to reorder. Drag listeners live on the parent `<li>`. */
  draggable?: boolean;
}): JSX.Element {
  const isClosed = channel.closed_at !== null;
  const isArchived = channel.archived_at !== null;
  // One number per row, and its volume — via the shared `channelNodeBadge` so the
  // collapsed poke-out reveal filter paints from the EXACT same predicate (a row is
  // revealed iff the badge it would show is `loud`). The member gate, the
  // non-member's absent unread and the EFFECTIVE tier (suppressor folded in) all
  // live in there: loudness is a function of the effective tier, always.
  const badge = channelNodeBadge(channel, attention, unreadCount);
  // A silenced row says so without being right-clicked: a MutedMarker rides beside
  // the name, like the workspace row's (shiki 2026-08-09). Mute is the marker ALONE
  // — the name keeps its full colour (shiki 2026-08-09: dimming the title read as
  // the row being de-emphasised, not silenced).
  //
  // The marker reads the channel's OWN stored tier, NOT `effective_mode`
  // (#task:1952, shiki 2026-08-10): a workspace suppressor is ONE fact, so it is
  // drawn ONCE on the workspace row. Folding it in here repainted it on every
  // child, which reads as N facts and is pure noise on a workspace with many
  // channels. So the marker keeps its actionable meaning — "this channel is
  // silenced on its own" — and survives a workspace unmute unchanged, exactly
  // like the stored value it now paints.
  //
  // Loudness is NOT affected: `badge` above and the reveal filter still fold in
  // the suppressor, so a muted workspace stays quiet. A `dm_channel` carries no
  // tier at all (the backend 404s it; a DB trigger forbids an agent_home
  // suppressor), so `mode` is forever `undefined` there and a DM never marks —
  // no default is resolved for it.
  const isSilenced = attention?.mode === 'mute';

  const row = (
    <ConversationRowLayout
      selected={selected}
      // A channel under a workspace is the ONLY row in the tree that indents:
      // the tree's single step is spent on this boundary (#task:1889, rationale
      // at NESTED_GLYPH_INSET).
      column="nested"
      draggable={draggable}
      onSelect={onClick}
    >
      <ChannelIcon
        variant="sticker"
        // Lock is opt-in for a private *regular* channel only. A `dm_channel`
        // is not a private channel, so it keeps the canonical `#` — pass the
        // visibility only when the row is a real channel.
        visibility={channel.roster_policy === 'open' ? channel.visibility : undefined}
        className={isClosed ? 'text-text-muted/50' : 'text-text-muted'}
      />
      <span
        className={
          'min-w-0 truncate ' + (isClosed ? 'line-through text-text-muted' : '')
        }
      >
        {channel.title}
      </span>
      {/* Mute rides WITH the name, matching the workspace row (shiki 2026-08-09):
          the shared MutedMarker hugs the (truncating) title, off the trailing edge
          where the badge lives. */}
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
      <ChannelRowMenuItems
        channelId={channel.id}
        title={channel.title}
        rosterPolicy={channel.roster_policy}
        isMember={channel.is_member === true}
        isArchived={isArchived}
        starred={false}
        attention={attention}
        workspaceMuted={workspaceMuted}
        onStar={() => onStar(channel.id, true)}
        onArchive={() => onArchive(channel.id, !isArchived)}
        archivePending={archivePending}
      />
    </AppContextMenu>
  );
}

// Every workspace-scoped query in this file asserts a RESOLVED container row (see
// the literal `true` at the call sites): a subtree only exists under a real
// workspace row, so the old "no workspace selected" arm (and its `null` gates on
// the archive menu / list key) has no reachable input here.
export type { ChannelNode };
