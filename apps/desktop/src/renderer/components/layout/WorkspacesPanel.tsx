import { Fragment, type ReactNode } from 'react';
import type { AgentDto, SortGroup } from '@silverhand/shared';
import { useSortable } from '@dnd-kit/sortable';
import { LayoutGrid, MessagesSquare, Plus } from 'lucide-react';
import { DisclosureTriangle } from '@/components/icons/DisclosureTriangle';
import { Button } from '@/components/ui/button';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
} from '@/components/layout/list-drag-sort';
import {
  OUTER_GLYPH_INSET,
  SidebarSection,
  MutedMarker,
  UnreadBadge,
  useSidebarSectionExpanded,
} from './sidebar-shared';
import { ChannelSortMenu, WorkspaceChannels } from './WorkspaceChannels';
import { WorkspaceContextMenu } from './WorkspaceContextMenu';
import { dmRecognitionName } from '@/lib/workspace-name';
import {
  branchHoldsSelectedRow,
  type SelectedConversation,
} from '@/lib/home-grouping';

type WorkspaceUiKind = 'regular' | 'dm';

export interface WorkspaceItem {
  id: string;
  name: string;
  kind: WorkspaceUiKind;
  dm_agent_id: string | null;
  active?: boolean;
  /** Unread mention notifications scoped to this workspace. Falsy / 0
   *  hides the badge. */
  unread?: number;
  /** True when the viewer has muted this workspace — drives the persistent
   *  `MutedMarker`. Read from the attention roll-up's `muted_workspace_ids`, the
   *  same carrier as `unread`, so the row can never disagree with itself about
   *  one workspace (#task:1870 / #task:1877). Never true for a DM (structurally
   *  un-mutable). */
  muted?: boolean;
  /** True for soft-archived workspaces. Since #task:1889 an archived workspace is
   *  NOT in this tree at all — the top-level `Archived` page (#task:1890) is the
   *  single archive index. */
  archived?: boolean;
  /** Creation time — stable fallback/tiebreak for the viewer sort modes
   *  (#task:1146). */
  created_at: number;
}

/** Live drag-sort wiring for ONE sortable group (#task:1146). `WorkspaceGroup`
 *  partitions its (already-ordered) workspaces into the `order` hard sub-groups —
 *  each its own DnD context, dividers between — and renders draggable rows. The
 *  drag state machine itself lives in the shared `useListDragSort` (owned by
 *  `Sidebar`); this just carries the per-row callbacks down. */
export interface WorkspaceSortConfig<GroupKey extends SortGroup = SortGroup> {
  /** Sub-group render order. Each rail section now drives a single group:
   *  `['dm']` or `['regular']` — one flat, drag-ordered list per kind. */
  order: GroupKey[];
  /** The hard group a workspace lives in (by kind: dm | regular). */
  groupKeyOf: (workspace: WorkspaceItem) => GroupKey;
  /** Commit a group's new full order. */
  onReorder: (group: GroupKey, orderedIds: string[]) => void;
}

interface WorkspaceGroupProps<GroupKey extends SortGroup = SortGroup> {
  label: string;
  /** Default kind for icon picking when a row's `kind` is the same.
   *  Kept on the group for the empty-state messaging. */
  kind: WorkspaceUiKind;
  workspaces: WorkspaceItem[];
  /** The open conversation, as one object. NOT three loose props: the workspace
   *  half only ever answers "which collapsed branch keeps the open row", and that
   *  answer also depends on whether the row has moved into STARRED — splitting
   *  them let a call site supply the parent id without the star fact, which is
   *  exactly the bug `branchHoldsSelectedRow` closes (#task:1901). The channel id
   *  is still the single FILL authority: at most one CHANNEL row highlights, and
   *  no container row ever does. */
  selected: SelectedConversation;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  onCreateChannel: (workspaceId: string) => void;
  /** Optional `+` button. DM groups omit this — DM workspaces are
   *  auto-created when an agent is provisioned. Ignored when `headerAction`
   *  is set (the caller composes its own action cluster, e.g. sort + add). */
  onAdd?: () => void;
  /** Header right-slot content (e.g. the sort menu, or sort + add). Takes
   *  precedence over `onAdd`. */
  headerAction?: ReactNode;
  /** Shown when `workspaces` is empty. */
  emptyHint?: ReactNode;
  /** Whether the group starts expanded. Defaults to true. With `persistId` this
   *  is only the first-run value. */
  defaultExpanded?: boolean;
  /** Storage identity for cross-restart collapse state (see
   *  `SidebarSection`). Omit for session-only collapse. */
  persistId?: string;
  /** Lookup of all workspace agents, keyed by id. DM workspace rows resolve
   *  their `dm_agent_id` here for the agent's runtime + display name. The
   *  avatar object URLs themselves come via `dmAgentAvatarUrls` (resolved ONCE
   *  at the rail level, not per-section) so reordering a DM never churns an
   *  avatar. Optional so callers without agent context still get a sane
   *  fallback. #task:919 / #task:1146 */
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** Resolved DM-agent avatar object URLs, keyed by agent id. Owned by the
   *  parent (`Sidebar`) over the STABLE union of all rail DM agents, so this
   *  map is identical across reorders — no per-section refetch flash
   *  (#task:1146). */
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
  /** Drag-sort wiring. Required since #task:1889 — the last non-sortable caller
   *  (the bottom ARCHIVED group) is gone. */
  sort: WorkspaceSortConfig<GroupKey>;
}

/** Per-row context shared by every entry point so a row is the SAME component
 *  regardless of where it is rendered (one entity, one shape). */
interface RailRowContext {
  selected: SelectedConversation;
  onSelectChannel: (channelId: string, workspaceId: string) => void;
  onCreateChannel: (workspaceId: string) => void;
  agentsById?: ReadonlyMap<string, AgentDto>;
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
}

function rowIconFor(workspace: WorkspaceItem, ctx: RailRowContext): JSX.Element {
  // One canonical workspace glyph for every surface (sidebar + filter
  // dropdowns). DM rows resolve to the bound agent's avatar; regular rows to
  // the themed `data-workspace-icon` badge — all handled inside `WorkspaceIcon`
  // so this stays identical to the workspace-filter dropdowns (#task:1192 /
  // #task:919 / #task:1160).
  return (
    <WorkspaceIcon
      kind={workspace.kind}
      dmAgentId={workspace.dm_agent_id}
      agentsById={ctx.agentsById}
      dmAgentAvatarUrls={ctx.dmAgentAvatarUrls}
    />
  );
}

/** The GROUP header's semantic glyph — the thing shiki asked for on
 *  STARRED / WORKSPACES / DM: identity at rest, chevron on hover. The three must
 *  read as one family, so all three are stroke glyphs at the same optical
 *  weight: `Star` / `MessagesSquare` (Slack's double bubble for DMs) /
 *  `LayoutGrid` (four tiles = a set of spaces).
 *
 *  WORKSPACES is NOT a `W` (shiki, 2026-08-08: 「和后面的 label W 重复了」). A
 *  letterform beside the word it is the first letter of says nothing the label has
 *  not already said, and it stuttered a second time against the rows below, where
 *  every regular workspace's own badge is a literal `W`. `LayoutGrid` is also the
 *  only candidate with no enclosing square: `MessagesSquare` one row down and
 *  `Archive` in the tools group both are, and at 14px a third outlined box would
 *  have read as the same word. `Layers` was unavailable — it is the compaction
 *  glyph (`ComposerActivityHeader`) and the Saved filter's "all".
 *
 *  A hand-drawn oval-bubble glyph was tried for DM and rejected on looks (shiki,
 *  2026-08-08). The concern it answered — square bubbles are the THREAD
 *  vocabulary (`ThreadIcon`) — is carried by the COMPOUND form instead: the
 *  thread glyph is the single `MessageSquare`, so two stacked bubbles stay a
 *  distinct word (and the same one NavRail's Chat tab uses).
 *
 *  Deliberately WITHOUT `data-workspace-icon`: that hook is the themed poster
 *  badge for a workspace INSTANCE, and a muted section header is not one (see
 *  app-layout.md §9 on not inventing a second primitive — this reuses the header
 *  vocabulary rather than the row's). */
function sectionGlyphFor(kind: WorkspaceUiKind): JSX.Element {
  if (kind === 'dm') return <MessagesSquare className="size-3.5" />;
  return <LayoutGrid className="size-3.5" />;
}

export function WorkspaceGroup<GroupKey extends SortGroup = SortGroup>({
  label,
  kind,
  workspaces,
  selected,
  onSelectChannel,
  onCreateChannel,
  onAdd,
  headerAction,
  emptyHint,
  defaultExpanded,
  persistId,
  agentsById,
  dmAgentAvatarUrls,
  sort,
}: WorkspaceGroupProps<GroupKey>): JSX.Element {
  const ctx: RailRowContext = {
    selected,
    onSelectChannel,
    onCreateChannel,
    agentsById,
    dmAgentAvatarUrls,
  };

  // Collapsed group, open conversation inside it: keep that ONE channel row and
  // nothing else (`app-layout.md` §3). The branch's own header row is NOT kept —
  // its only action is a collapse that would no longer change anything, and which
  // workspace you are in is on the titlebar. Reuses the branch's own
  // `selectedOnly` render, so the surviving row is the same row with the same
  // indent, fill and menu. Same `branchHoldsSelectedRow` the branch itself uses, so
  // a starred selection resolves to nothing here — its row lives in STARRED, and
  // this group must not mount a branch that has no row to show (#task:1901).
  const selectedBranch = workspaces.find(w => branchHoldsSelectedRow(w.id, selected));

  return (
    <SidebarSection
      label={label}
      icon={sectionGlyphFor(kind)}
      count={workspaces.length}
      onAdd={headerAction ? undefined : onAdd}
      action={headerAction}
      collapsible
      defaultExpanded={defaultExpanded ?? true}
      persistId={persistId}
      selectionPath={
        selectedBranch ? (
          <WorkspaceChannels
            workspaceId={selectedBranch.id}
            workspaceKind={selectedBranch.kind}
            selectedChannelId={selected.channelId}
            onSelectChannel={onSelectChannel}
            onCreateChannel={onCreateChannel}
            selectedOnly
          />
        ) : null
      }
    >
      {workspaces.length === 0 ? (
        <li className="px-2 py-2 text-xs text-text-muted">{emptyHint ?? 'Empty'}</li>
      ) : (
        renderSortableGroups(workspaces, sort, ctx)
      )}
    </SidebarSection>
  );
}

/** Render the workspaces as drag-sortable hard sub-groups in `sort.order`,
 *  each its own DnD context (no cross-group drag), a divider between non-empty
 *  groups. The workspaces are already in final order (Sidebar sorted them), so
 *  partitioning preserves within-group order. */
function renderSortableGroups<GroupKey extends SortGroup>(
  workspaces: WorkspaceItem[],
  sort: WorkspaceSortConfig<GroupKey>,
  ctx: RailRowContext,
): ReactNode {
  const partitions = sort.order
    .map(key => ({ key, items: workspaces.filter(w => sort.groupKeyOf(w) === key) }))
    .filter(p => p.items.length > 0);

  return partitions.map((p, i) => (
    <Fragment key={p.key}>
      {i > 0 ? (
        <li>
          <div className="mx-2 my-1 border-t border-border-subtle" />
        </li>
      ) : null}
      <SortableGroup
        ids={p.items.map(w => w.id)}
        onReorder={ordered => sort.onReorder(p.key, ordered)}
      >
        {p.items.map(w => (
          <SortableWorkspaceItem key={w.id} workspace={w} ctx={ctx} />
        ))}
      </SortableGroup>
    </Fragment>
  ));
}

/** Drag-sortable workspace BRANCH — the `<li>` is the sortable node and holds
 *  the transform, so an expanded workspace's channel children travel with their
 *  parent while it is dragged (they live inside this `<li>`).
 *
 *  The drag SURFACE, however, is the header row only: `attributes` + `listeners`
 *  are handed down and spread on the header `<div>`, not here. Putting them on the
 *  `<li>` (what the flat rail did) would make a pointerdown on any CHILD row start
 *  a workspace drag. Whole-row drag on the header (no grip), 4px activation; the
 *  drag style comes from the shared list-drag-sort helpers. */
function SortableWorkspaceItem({
  workspace,
  ctx,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
}): JSX.Element {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } =
    useSortable({ id: workspace.id, animateLayoutChanges });
  return (
    <li
      ref={setNodeRef}
      style={sortableItemStyle({ transform, transition, isDragging })}
      // `group/wsbranch` spans the header row AND its channels: the row's
      // right-side actions (sort, `+`) are revealed by pointing anywhere in the
      // BRANCH, not just at its header (shiki, 2026-08-08) — same reveal scope
      // the group headers use, one level down. The header keeps its own narrower
      // `group/ws` for the glyph swap: a triangle appearing on the parent while
      // the pointer is on a child would say the wrong thing about what is under
      // the cursor.
      className="touch-none group/wsbranch"
    >
      <WorkspaceBranch
        workspace={workspace}
        ctx={ctx}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </li>
  );
}

/**
 * One workspace: its header row plus, when expanded, its channel children.
 *
 * The header is pure CHROME (#task:1889, shiki: 「workspace 应该永远不能高亮」) —
 * a collapse toggle and a right-click menu. It does NOT navigate, does NOT change
 * the titlebar context and NEVER highlights, so the tree has exactly one FILL and
 * it always belongs to the open conversation. Hierarchy is carried by one 16px
 * indent step (children sit on the child glyph column), the lighter ink and the
 * absence of the row vocabulary (no ink frame) — the header's own glyph slot is
 * the collapse control's home on hover, so no column is spent on a chevron.
 *
 * Collapse state persists per workspace under the shared section vocabulary
 * (`silverhand:layout.sidebar-section.ws.<id>`), so the shape of the tree survives
 * a restart. It starts COLLAPSED and only an explicit click changes it — the stored
 * bit means "I want this open", never "I have been here" (see `holdsSelection`
 * below). Opening a channel in a collapsed branch does not expand it; the branch
 * keeps that one row on screen by itself (`selectedOnly`), which is how the FILL
 * stays reachable without pinning the branch open or handing the header a stand-in
 * marker.
 */
function WorkspaceBranch({
  workspace,
  ctx,
  dragHandleProps,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  dragHandleProps: Record<string, unknown>;
}): JSX.Element {
  // FIRST RUN IS COLLAPSED (shiki, 2026-08-08:「只展开 starred/workspace/dm 第一
  // 级,第二级不展开」). The three group headers open by default, the branches under
  // them do not: an untouched tree is then a list of workspaces you can read at a
  // glance instead of every channel of every workspace, and the lazy-mount rule
  // above pays off on the very first paint rather than only after the user has
  // collapsed things by hand.
  const [expanded, setExpanded] = useSidebarSectionExpanded(`ws.${workspace.id}`, false);
  // Navigation does NOT expand this branch (shiki, 2026-08-08 — the second level
  // stays collapsed until you open it yourself). It used to: reveal-on-navigate
  // forced EXPANDED and wrote that through, so the stored bit recorded "you have
  // been here" rather than "you want this open", and a default of collapsed decayed
  // back to fully expanded over a few days of use. Nothing is lost by dropping it,
  // because a collapsed branch holding the open channel already shows that one row
  // (`selectedOnly`) — the same reveal, without the siblings and without the write.
  //
  // "Holding" is membership AFTER exclusive-home, not parent-id equality: a starred
  // conversation's row is STARRED's, so this branch keeps nothing and stays
  // unmounted (`branchHoldsSelectedRow`, #task:1901 @Cindy MUST FIX).
  const holdsSelection = branchHoldsSelectedRow(workspace.id, ctx.selected);

  return (
    <>
      <WorkspaceHeaderRow
        workspace={workspace}
        ctx={ctx}
        expanded={expanded}
        onToggle={() => setExpanded()}
        dragHandleProps={dragHandleProps}
      />
      {expanded || holdsSelection ? (
        <ul className="space-y-0.5">
          <WorkspaceChannels
            workspaceId={workspace.id}
            workspaceKind={workspace.kind}
            selectedChannelId={ctx.selected.channelId}
            onSelectChannel={ctx.onSelectChannel}
            onCreateChannel={ctx.onCreateChannel}
            // Collapsed, but this is the branch you are IN: keep the open
            // channel's row and drop the rest (shiki, 2026-08-08). Collapse
            // stays a working control — the rejected alternative was pinning the
            // branch open, which turns a header row whose ONLY action is collapse
            // into a focusable, pressable no-op. What it costs is this branch's
            // three queries staying armed while collapsed; bounded to one branch,
            // and to the workspace whose caches are already warm.
            selectedOnly={!expanded}
          />
        </ul>
      ) : null}
    </>
  );
}

function WorkspaceHeaderRow({
  workspace,
  ctx,
  expanded,
  onToggle,
  dragHandleProps,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  expanded: boolean;
  onToggle: () => void;
  dragHandleProps: Record<string, unknown>;
}): JSX.Element {
  // DM rows show the bound agent's RAW display name — no `@`, no `· DM` suffix
  // (shiki 2026-08-01, #task:1768). This is a recognition surface (who you're
  // talking to), so it reads like a person, not a handle. Shares
  // `dmRecognitionName` with the titlebar so the two can't drift.
  const dmAgent =
    workspace.kind === 'dm' && workspace.dm_agent_id
      ? ctx.agentsById?.get(workspace.dm_agent_id)
      : undefined;
  const title =
    workspace.kind === 'dm'
      ? dmRecognitionName(workspace.name, dmAgent)
      : workspace.name;
  const icon = rowIconFor(workspace, ctx);
  const unread = workspace.unread;
  // Hover-revealed actions, scoped to the whole BRANCH (`group/wsbranch` on the
  // sortable `<li>`): pointing at any channel keeps its parent's sort / `+` up
  // (shiki, 2026-08-08) — you reach for them while reading the list, not while
  // reading its header, and a `+` that hides the moment you move down toward the
  // channels is a target you have to re-acquire.
  // Keyboard reachability comes from `focus-visible` — on
  // the control itself, or on a descendant for the wrappers whose focusable part is
  // a menu trigger. NOT `group-focus-within`: Chromium focuses a <button> on
  // mousedown, so clicking the workspace header (a collapse toggle) left the row's
  // `+` and sort menu pinned visible until focus moved elsewhere — the row read as
  // stuck in a selected state (shiki, #task:1889 review). `:focus-visible` is the
  // keyboard-only half of that signal, which is the only half this affordance
  // wanted. `:has([data-state=open])` keeps a trigger visible while its own menu is
  // open — otherwise it vanishes from under an open Radix popover the moment the
  // pointer leaves the row.
  const hoverOnly =
    'opacity-0 transition-opacity group-hover/wsbranch:opacity-100 '
    + 'focus-visible:opacity-100 [&:has(:focus-visible)]:opacity-100 '
    + '[&:has([data-state=open])]:opacity-100';

  const row = (
    <div
      className={
        // 28px chrome, NOT the 32px row vocabulary. A workspace / DM header is a
        // GROUPING line, and the tree already spends its fill on the thing that
        // matters — the selected channel. So no ink frame and NO hover fill: the
        // `sidebar-row-gutter` twin reserves the same stroke for column alignment
        // but takes none of `.sidebar-row-border`'s state paint (in forza6 that
        // hover is a lime fill + drop shadow, which made this line compete with a
        // real selection). Hover lifts the ink and swaps the glyph for the
        // disclosure triangle — nothing else (shiki, 2026-08-08). The indent puts
        // it on the OUTER column — flush with its group header, because the one
        // available step is spent below this row instead: its channels are what
        // needs position to be readable as a block (shiki, 2026-08-08).
        //
        // Resting ink is `text-text-secondary`, NOT muted: muted is the group
        // LABEL's weight, and wearing it made the parent row read as a caption —
        // lighter than its own channel children, so the line that is actually a
        // control looked like the one thing on screen you cannot press (shiki:
        // 「可点击提示不强」, 2026-08-08).
        'sidebar-row-gutter group/ws flex h-7 w-full items-stretch pr-2 ' +
        OUTER_GLYPH_INSET +
        ' ' +
        'text-text-secondary hover:text-text-primary'
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group/wstoggle flex min-w-0 flex-1 items-center text-left text-[12.5px] font-medium"
      >
        {/* Identity at rest, disclosure triangle on hover / keyboard focus — the
            SAME swap the three group headers use. The rule is drawn by CAPABILITY,
            not by kind: every row that owns an `aria-expanded` (regular workspace
            AND DM home — one `WorkspaceHeaderRow` serves both) swaps, and the leaf
            rows (channel / STARRED) never do, because their glyph is not a hinge.
            Until 2026-08-08 no instance row swapped at all, which left this line's
            only affordance an ink lift: it said "hoverable", never "collapses"
            (shiki: 「可点击提示不强」). A PERMANENT triangle was the other candidate
            and was rejected — it needs its own column, and keeping the one indent
            step then costs every channel another 12px in an already narrow list
            (docs/app-layout.md §3).
            Structure mirrors the group header: the fading wrapper carries no theme
            hook, so a theme that paints the icon (forza6's `[data-workspace-icon]`
            ink square, an agent avatar) can never win a specificity race against
            the fade and leave both glyphs stacked. */}
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <span className="inline-flex items-center transition-opacity group-hover/ws:opacity-0 group-focus-visible/wstoggle:opacity-0">
            {icon}
          </span>
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover/ws:opacity-100 group-focus-visible/wstoggle:opacity-100"
          >
            <DisclosureTriangle
              direction={expanded ? 'down' : 'right'}
              className="size-3.5"
            />
          </span>
        </span>
        <span className="ml-2 min-w-0 truncate">{title}</span>
      </button>
      <span className="flex shrink-0 items-center gap-1 pl-1">
        {/* Mute is a two-state fact about the workspace itself, so it is present
            collapsed AND expanded. The aggregate unread badge is not: it exists to
            answer "is it worth opening this?", so it is withdrawn once the children
            that carry the same information are on screen. It is consumed exactly as
            the backend projects it — a channel that has moved into STARRED is still
            counted here (shiki's ruling: don't re-derive the projection to subtract
            it). */}
        {workspace.muted ? <MutedMarker /> : null}
        {!expanded ? (
          unread && unread > 0 ? (
            <UnreadBadge count={unread} />
          ) : workspace.active ? (
            <span className="size-1.5 rounded-full bg-success" />
          ) : null
        ) : null}
        {expanded ? (
          <span className={hoverOnly}>
            <ChannelSortMenu workspaceId={workspace.id} workspaceKind={workspace.kind} />
          </span>
        ) : null}
        {/* Same recipe as the sort trigger beside it — one `ghost` icon Button at
            h-6 w-6, so resting ink and hover fill come from one place (shiki,
            2026-08-08: the `+` had no hover background and sat at a different
            resting colour). Two sibling actions on one row differ by glyph and
            command only. The reveal lives on a WRAPPER, as it does for the sort
            menu: `hoverOnly` sets `transition-opacity`, which would otherwise
            merge away the Button's own `transition-colors` and make the hover
            fill snap while its neighbour's fades. */}
        <span className={hoverOnly}>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => ctx.onCreateChannel(workspace.id)}
            aria-label={`New channel in ${title}`}
            title="New channel"
          >
            <Plus className="size-3.5" />
          </Button>
        </span>
      </span>
    </div>
  );

  // The drag surface is a WRAPPER around the header, not the header itself: the
  // context-menu trigger below goes through a Radix `Slot`, which swallows the
  // dnd-kit pointer activation when the listeners are cloned onto the same element
  // (the hazard `ChannelRow` documents). Wrapping also scopes the surface to the
  // header — a pointerdown on a child channel row can never start a workspace drag.
  return (
    <div
      className="mt-1.5 cursor-grab select-none active:cursor-grabbing"
      {...dragHandleProps}
    >
      <WorkspaceContextMenu
        trigger={row}
        muteWorkspaceId={canMuteWorkspace(workspace) ? workspace.id : null}
      />
    </div>
  );
}

/** A row can flip the workspace mute suppressor when it is a REGULAR, non-archived
 *  workspace. A DM (`agent_home`) is structurally un-mutable — directed-grade
 *  traffic has no ambient floor to silence, and the DB trigger forbids the row —
 *  and an archived workspace isn't being listened to at all. */
function canMuteWorkspace(workspace: WorkspaceItem): boolean {
  return workspace.kind === 'regular' && !workspace.archived;
}
