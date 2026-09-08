import * as Popover from "@radix-ui/react-popover";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentDto, SortGroup } from "@silverhand/shared";
import { useSortable } from "@dnd-kit/sortable";
import {
  ChevronDown,
  LayoutGrid,
  MessagesSquare,
  MoreVertical,
  Plus,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { WorkspaceIcon } from "@/components/WorkspaceIcon";
import {
  SortableGroup,
  animateLayoutChanges,
  sortableItemStyle,
} from "@/components/layout/list-drag-sort";
import {
  OUTER_GLYPH_INSET,
  SidebarSection,
  MutedMarker,
  useSidebarSectionExpanded,
} from "../../../components/layout/sidebar-shared";
import { WorkspaceChannels } from "./workspace-channels";
import { WorkspaceContextMenu } from "./workspace-context-menu";
import { agentSpaceRecognitionName } from "@/features/workspaces/workspace-name";
import {
  branchHoldsSelectedRow,
  collapsedGroupRevealBranches,
  isWorkspaceAwake,
  type SelectedConversation,
} from "@/features/chat-shell/model/home-grouping";
import { isAgentSpace } from "@/features/workspaces/workspace-ownership";

export interface WorkspaceItem {
  id: string;
  name: string;
  /** The agent that owns this container, or `null` for a people-owned workspace.
   *  The rail's only spelling of the distinction (#task:2078): classify through
   *  `isAgentSpace`, read the id itself only to resolve the owner's avatar. */
  owner_agent_id: string | null;
  active?: boolean;
  /** Unread mention notifications scoped to this workspace. Falsy / 0
   *  hides the badge. */
  unread?: number;
  /** True when the viewer has muted this workspace — drives the persistent
   *  `MutedMarker`. Read from the attention roll-up's `muted_workspace_ids`, the
   *  same carrier as `unread`, so the row can never disagree with itself about
   *  one workspace (#task:1870 / #task:1877). Never true for an agent space
   *  (structurally un-mutable). */
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
   *  `['agent_space']` or `['regular']` — one flat, drag-ordered list per section.
   *  These are `SortGroup` WIRE + DB tokens, produced in exactly one place
   *  (`railSortGroupOf`); they are not display words. */
  order: GroupKey[];
  /** The hard group a workspace lives in (agent-owned | people-owned). */
  groupKeyOf: (workspace: WorkspaceItem) => GroupKey;
  /** Commit a group's new full order. */
  onReorder: (group: GroupKey, orderedIds: string[]) => void;
}

interface WorkspaceGroupProps<GroupKey extends SortGroup = SortGroup> {
  label: string;
  /** The section's header glyph — one of the two constants below, so the family
   *  of three section glyphs stays defined in one place (#task:2078: this used to
   *  be a container KIND that the group did nothing else with). */
  icon: ReactNode;
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
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  /** Optional `+` button. The AGENT SPACES section omits this — an agent space is
   *  created with its agent, never from the rail. Ignored when `headerAction`
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
  /** Lookup of all workspace agents, keyed by id. An agent space's row resolves
   *  its `owner_agent_id` here for the agent's runtime + display name. The
   *  avatar object URLs themselves come via `ownerAgentAvatarUrls` (resolved ONCE
   *  at the rail level, not per-section) so reordering a row never churns an
   *  avatar. Optional so callers without agent context still get a sane
   *  fallback. #task:919 / #task:1146 */
  agentsById?: ReadonlyMap<string, AgentDto>;
  /** Resolved owner-agent avatar object URLs, keyed by agent id. Owned by the
   *  parent (`Sidebar`) over the STABLE union of all rail owner agents, so this
   *  map is identical across reorders — no per-section refetch flash
   *  (#task:1146). */
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
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
  onOpenWorkspaceSettings: (workspaceId: string) => void;
  agentsById?: ReadonlyMap<string, AgentDto>;
  ownerAgentAvatarUrls: ReadonlyMap<string, string | null>;
}

function rowIconFor(workspace: WorkspaceItem, ctx: RailRowContext): JSX.Element {
  return (
    <WorkspaceIcon
      ownerAgentId={workspace.owner_agent_id}
      agentsById={ctx.agentsById}
      ownerAgentAvatarUrls={ctx.ownerAgentAvatarUrls}
    />
  );
}

/** The recognition name a workspace row shows: an agent space reads as its owning
 *  agent (no `@`, no `· DM` suffix — shiki, #task:1768), any other workspace as its
 *  own name. Shared by the interactive header and the collapsed-group caption so the
 *  two can never drift. */
function workspaceRowTitle(workspace: WorkspaceItem, ctx: RailRowContext): string {
  const ownerAgent = workspace.owner_agent_id
    ? ctx.agentsById?.get(workspace.owner_agent_id)
    : undefined;
  return isAgentSpace(workspace)
    ? agentSpaceRecognitionName(workspace.name, ownerAgent)
    : workspace.name;
}

function WorkspaceRow(
  props: {
    icon: ReactNode;
    title: string;
  } & (
    | { mode: "caption" }
    | {
        mode: "interactive";
        expanded: boolean;
        onToggle: () => void;
        muted?: boolean;
        children: ReactNode;
      }
  ),
): JSX.Element {
  const identity = (
    <>
      <span className="flex size-5.5 shrink-0 items-center justify-center">{props.icon}</span>
      <span className="ml-2 min-w-0 truncate">{props.title}</span>
    </>
  );

  return (
    <div
      className={cn(
        "sidebar-row-gutter group/ws flex h-7 w-full items-center",
        OUTER_GLYPH_INSET,
        props.mode === "caption"
          ? "text-text-muted"
          : "text-text-secondary hover:text-text-primary",
      )}
    >
      {props.mode === "caption" ? (
        <span className="flex min-w-0 flex-1 items-center text-xs font-medium">{identity}</span>
      ) : (
        <>
          <button
            type="button"
            onClick={props.onToggle}
            aria-expanded={props.expanded}
            className="group/wstoggle flex min-w-0 flex-1 items-center text-left text-sm font-medium leading-4"
          >
            {identity}
            {props.muted ? (
              <span className="ml-1 flex shrink-0 items-center">
                <MutedMarker />
              </span>
            ) : null}
            <span
              aria-hidden
              data-sidebar-branch-caret
              className="ml-1 inline-flex shrink-0 items-center text-text-muted opacity-0 transition-opacity group-hover/ws:opacity-100 group-focus-visible/wstoggle:opacity-100"
            >
              <ChevronDown
                className={cn(
                  "size-3 transition-transform duration-150",
                  props.expanded ? "rotate-0" : "-rotate-90",
                )}
              />
            </span>
          </button>
          {props.children}
        </>
      )}
    </div>
  );
}

/**
 * A NON-interactive workspace label, shown above a non-current awake branch's poked
 * rows while the whole group is collapsed (#task:1939). When a collapsed group reveals
 * loud channels from more than one workspace, those rows would otherwise float with no
 * owner — two workspaces' `general` become indistinguishable. The branch you are IN
 * needs none of this (the titlebar names it), so only the OTHER branches are captioned.
 *
 * Deliberately NOT `WorkspaceHeaderRow`: it carries no disclosure triangle, drag,
 * sort menu or `+`. A collapse toggle here would be the fake control shiki removed
 * from the collapsed branch (its only action can no longer change anything), and
 * writing `expanded` from it would break the "reveal is DERIVED" invariant. It wears
 * the muted grouping weight (a caption), not the header's `text-text-secondary`
 * (a control), so it reads as a label for the rows beneath it.
 */
function WorkspaceCaption({
  workspace,
  ctx,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
}): JSX.Element {
  return (
    <li>
      <WorkspaceRow
        icon={rowIconFor(workspace, ctx)}
        title={workspaceRowTitle(workspace, ctx)}
        mode="caption"
      />
    </li>
  );
}

export const WORKSPACES_SECTION_GLYPH: ReactNode = <LayoutGrid className="size-3.5" />;
export const AGENT_SPACES_SECTION_GLYPH: ReactNode = <MessagesSquare className="size-3.5" />;

export function WorkspaceGroup<GroupKey extends SortGroup = SortGroup>({
  label,
  icon,
  workspaces,
  selected,
  onSelectChannel,
  onCreateChannel,
  onOpenWorkspaceSettings,
  onAdd,
  headerAction,
  emptyHint,
  defaultExpanded,
  persistId,
  agentsById,
  ownerAgentAvatarUrls,
  sort,
}: WorkspaceGroupProps<GroupKey>): JSX.Element {
  const ctx: RailRowContext = {
    selected,
    onSelectChannel,
    onCreateChannel,
    onOpenWorkspaceSettings,
    agentsById,
    ownerAgentAvatarUrls,
  };

  const revealBranches = collapsedGroupRevealBranches(workspaces, {
    holdsSelection: (w) => branchHoldsSelectedRow(w.id, selected),
    isAwake: (w) => isWorkspaceAwake(w),
  });

  return (
    <SidebarSection
      label={label}
      icon={icon}
      count={workspaces.length}
      onAdd={headerAction ? undefined : onAdd}
      action={headerAction}
      collapsible
      defaultExpanded={defaultExpanded ?? true}
      persistId={persistId}
      collapsedContent={
        revealBranches.length > 0 ? (
          <>
            {revealBranches.map((w) => (
              <WorkspaceChannels
                key={w.id}
                workspaceId={w.id}
                selectedChannelId={selected.channelId}
                onSelectChannel={onSelectChannel}
                onCreateChannel={onCreateChannel}
                collapsed
                pokeUnread={isWorkspaceAwake(w)}
                // The current branch is headerless (titlebar names it); any OTHER
                // branch gets a caption — but passed THROUGH `WorkspaceChannels` so it
                // renders only when that branch's reveal is non-empty. A wake-gate-lit
                // branch whose only loud row is STARRED (or whose row queries are
                // loading/failed) then shows nothing at all, never an orphan title.
                revealCaption={
                  branchHoldsSelectedRow(w.id, selected) ? undefined : (
                    <WorkspaceCaption workspace={w} ctx={ctx} />
                  )
                }
              />
            ))}
          </>
        ) : null
      }
    >
      {workspaces.length === 0 ? (
        <li className="px-2 py-2 text-xs text-text-muted">{emptyHint ?? "Empty"}</li>
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
    .map((key) => ({ key, items: workspaces.filter((w) => sort.groupKeyOf(w) === key) }))
    .filter((p) => p.items.length > 0);

  return partitions.map((p, i) => (
    <Fragment key={p.key}>
      {i > 0 ? (
        <li>
          <div className="mx-2 my-1 border-t border-border-subtle" />
        </li>
      ) : null}
      <SortableGroup
        ids={p.items.map((w) => w.id)}
        onReorder={(ordered) => sort.onReorder(p.key, ordered)}
      >
        {p.items.map((w) => (
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
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id: workspace.id,
    animateLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      style={sortableItemStyle({ transform, transition, isDragging })}
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

function WorkspaceBranch({
  workspace,
  ctx,
  dragHandleProps,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  dragHandleProps: Record<string, unknown>;
}): JSX.Element {
  const [expanded, setExpanded] = useSidebarSectionExpanded(`ws.${workspace.id}`, false);

  const holdsSelection = branchHoldsSelectedRow(workspace.id, ctx.selected);

  const wakeGate = isWorkspaceAwake(workspace);

  return (
    <>
      <WorkspaceHeaderRow
        workspace={workspace}
        ctx={ctx}
        expanded={expanded}
        onToggle={() => setExpanded()}
        dragHandleProps={dragHandleProps}
      />
      {expanded || holdsSelection || wakeGate ? (
        <ul className="space-y-1">
          <WorkspaceChannels
            workspaceId={workspace.id}
            selectedChannelId={ctx.selected.channelId}
            onSelectChannel={ctx.onSelectChannel}
            onCreateChannel={ctx.onCreateChannel}
            collapsed={!expanded}
            pokeUnread={wakeGate}
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
  const title = workspaceRowTitle(workspace, ctx);
  const icon = rowIconFor(workspace, ctx);
  const unread = workspace.unread;

  const hoverOnly = cn(
    "opacity-0 transition-opacity group-hover/wsbranch:opacity-100",
    "focus-visible:opacity-100 [&:has(:focus-visible)]:opacity-100",
    "[&:has([data-state=open])]:opacity-100",
  );

  const row = (
    <WorkspaceRow
      icon={icon}
      title={title}
      mode="interactive"
      expanded={expanded}
      onToggle={onToggle}
      muted={workspace.muted}
    >
      <span className="flex shrink-0 items-center gap-1 pl-1">
        {!expanded && !(unread && unread > 0) && workspace.active ? (
          <span className="size-1.5 rounded-full bg-success" />
        ) : null}
        <span className={hoverOnly}>
          <WorkspaceActions
            title={title}
            onCreate={() => ctx.onCreateChannel(workspace.id)}
            onSettings={
              isAgentSpace(workspace) ? undefined : () => ctx.onOpenWorkspaceSettings(workspace.id)
            }
          />
        </span>
      </span>
    </WorkspaceRow>
  );

  // The drag surface is a WRAPPER around the header, not the header itself: the
  // context-menu trigger below goes through a Radix `Slot`, which swallows the
  // dnd-kit pointer activation when the listeners are cloned onto the same element
  // (the hazard `ChannelRow` documents). Wrapping also scopes the surface to the
  // header — a pointerdown on a child channel row can never start a workspace drag.
  return (
    <div className="mt-1.5 cursor-grab select-none active:cursor-grabbing" {...dragHandleProps}>
      <WorkspaceContextMenu
        trigger={row}
        muteWorkspaceId={canMuteWorkspace(workspace) ? workspace.id : null}
        leaveWorkspace={
          canLeaveWorkspaceRow(workspace) ? { id: workspace.id, name: workspace.name } : null
        }
      />
    </div>
  );
}

function canMuteWorkspace(workspace: WorkspaceItem): boolean {
  return !isAgentSpace(workspace) && !workspace.archived;
}

function canLeaveWorkspaceRow(workspace: WorkspaceItem): boolean {
  return !isAgentSpace(workspace) && !workspace.archived;
}

function WorkspaceActions({
  title,
  onCreate,
  onSettings,
}: {
  title: string;
  onCreate: () => void;
  onSettings?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const keyboardOpen = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const cancelClose = (): void => {
    clearTimeout(closeTimer.current);
  };
  const show = (): void => {
    cancelClose();
    setOpen(true);
  };
  const hide = (): void => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={`Actions for ${title}`}
          onMouseEnter={show}
          onMouseLeave={hide}
          onClick={(event) => {
            event.preventDefault();
            keyboardOpen.current = event.detail === 0;
            show();
            if (keyboardOpen.current)
              contentRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }}
        >
          <MoreVertical className="size-3.5" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          align="end"
          sideOffset={4}
          onMouseEnter={cancelClose}
          onMouseLeave={hide}
          onOpenAutoFocus={(event) => {
            if (!keyboardOpen.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!keyboardOpen.current) event.preventDefault();
          }}
          data-popover-frame="menu"
          className="z-(--z-dialog) min-w-40 bg-bg-floating p-1 shadow-popover"
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-(--floating-item-radius) px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover"
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
          >
            <Plus className="size-3.5" />
            Create channel
          </button>
          {onSettings ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-(--floating-item-radius) px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover"
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              <Settings className="size-3.5" />
              Settings
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
