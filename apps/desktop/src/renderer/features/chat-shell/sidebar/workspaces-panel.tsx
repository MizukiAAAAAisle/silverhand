import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentDto } from "@silverhand/shared";
import { MoreVertical, Plus, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { WorkspaceIcon } from "@/components/workspace-icon";

import {
  SidebarSectionHeader,
  SidebarBranchLayout,
  MutedMarker,
  useSidebarSectionExpanded,
} from "../../../components/layout/sidebar-shared";
import { WorkspaceChannels } from "./workspace-channels";
import { WorkspaceContextMenu } from "./workspace-context-menu";
import { agentSpaceRecognitionName } from "@/features/workspaces/workspace-name";
import {
  branchHoldsSelectedRow,
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

function workspaceRowTitle(workspace: WorkspaceItem, ctx: RailRowContext): string {
  const ownerAgent = workspace.owner_agent_id
    ? ctx.agentsById?.get(workspace.owner_agent_id)
    : undefined;
  return isAgentSpace(workspace)
    ? agentSpaceRecognitionName(workspace.name, ownerAgent)
    : workspace.name;
}

function WorkspaceRow({
  icon,
  title,
  expanded,
  onToggle,
  muted,
  children,
}: {
  icon: ReactNode;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  muted?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <SidebarSectionHeader
      label={title}
      collapsible
      expanded={expanded}
      onToggle={onToggle}
      leading={
        icon ? (
          <span className="flex size-5.5 shrink-0 items-center justify-center">{icon}</span>
        ) : undefined
      }
      trailing={muted ? <MutedMarker /> : undefined}
      action={children}
    />
  );
}

export function WorkspaceBranch({
  workspace,
  ctx,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
}): JSX.Element {
  const [expanded, setExpanded] = useSidebarSectionExpanded(`ws.${workspace.id}`, false);

  const holdsSelection = branchHoldsSelectedRow(workspace.id, ctx.selected);

  const wakeGate = isWorkspaceAwake(workspace);

  return (
    <SidebarBranchLayout
      header={
        <WorkspaceHeaderRow
          workspace={workspace}
          ctx={ctx}
          expanded={expanded}
          onToggle={() => setExpanded()}
        />
      }
    >
      {expanded || holdsSelection || wakeGate ? (
        <WorkspaceChannels
          workspaceId={workspace.id}
          selectedChannelId={ctx.selected.channelId}
          onSelectChannel={ctx.onSelectChannel}
          collapsed={!expanded}
          pokeUnread={wakeGate}
        />
      ) : null}
    </SidebarBranchLayout>
  );
}

function WorkspaceHeaderRow({
  workspace,
  ctx,
  expanded,
  onToggle,
}: {
  workspace: WorkspaceItem;
  ctx: RailRowContext;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const title = workspaceRowTitle(workspace, ctx);
  const icon = isAgentSpace(workspace) ? rowIconFor(workspace, ctx) : null;
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
      expanded={expanded}
      onToggle={onToggle}
      muted={workspace.muted}
    >
      <span className="flex shrink-0 items-center gap-1 pl-1">
        {!expanded && !(unread && unread > 0) && workspace.active ? (
          <span className="size-1.5 rounded-full bg-success" />
        ) : null}
        <span className={cn("flex items-center", hoverOnly)}>
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

  return (
    <WorkspaceContextMenu
      trigger={<div className="group/wsbranch">{row}</div>}
      muteWorkspaceId={canMuteWorkspace(workspace) ? workspace.id : null}
      leaveWorkspace={
        canLeaveWorkspaceRow(workspace) ? { id: workspace.id, name: workspace.name } : null
      }
    />
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
