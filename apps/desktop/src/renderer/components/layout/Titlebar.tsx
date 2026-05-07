import { Settings, MessageSquarePlus, Users, CheckSquare } from 'lucide-react';
import { ManageMembersPopover } from '@/features/workspaces/ManageMembersPopover';

type WorkspaceUiKind = 'regular' | 'dm';

interface TitlebarProps {
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceKind: WorkspaceUiKind | null;
  workspacePath: string | null;
  /** epoch ms when the workspace was archived; null for active workspaces.
   *  Drives the inline `Archived` pill so the user knows why this
   *  workspace is missing from the main sidebar list. */
  workspaceArchivedAt: number | null;
  onOpenWorkspaceSettings?: () => void;
  onCreateChannel?: () => void;
  /** Tasks panel trigger. Provided only when a chat workspace is selected.
   *  Click opens the workspace-wide tasks drawer (4-column kanban). */
  onOpenTasks?: () => void;
  /** Active-task count for the workspace — drives the small badge next to
   *  the Tasks button. Hidden when 0 / undefined. */
  taskCount?: number;
}

/**
 * Window-wide titlebar — drag region with the current workspace's name,
 * its primary actions (Settings, Manage Members, New Channel), and the
 * workspace path right-aligned with rtl ellipsis so the path tail
 * stays visible. Workspace info starts at `--sidebar-width` so it sits
 * directly above the ChannelsSidebar column it describes (the leftmost
 * Sidebar column gets an empty drag area that also doubles as the
 * macOS traffic-lights inset). Spans the full window so it doubles as
 * the native title bar (`titleBarStyle: 'hiddenInset'` on macOS — see
 * main/index.ts).
 */
export function Titlebar({
  workspaceId,
  workspaceName,
  workspaceKind,
  workspacePath,
  workspaceArchivedAt,
  onOpenWorkspaceSettings,
  onCreateChannel,
  onOpenTasks,
  taskCount,
}: TitlebarProps): JSX.Element {
  const hasWorkspace = workspaceName !== null;
  const showManageMembers = hasWorkspace && workspaceKind !== 'dm' && !!workspaceId;
  const showCreateChannel = hasWorkspace && !!onCreateChannel;
  const showSettings = hasWorkspace && !!onOpenWorkspaceSettings;
  const showTasks = hasWorkspace && !!onOpenTasks;
  const isArchived = workspaceArchivedAt !== null;

  return (
    <header
      className={
        'drag-region flex h-[var(--titlebar-height)] shrink-0 items-center ' +
        'gap-2 border-b text-xs ' +
        'bg-[var(--bg-app,var(--bg-primary))] ' +
        'border-[var(--titlebar-border,var(--border-subtle))]'
      }
    >
      {/* Spacer matches the leftmost NavRail + workspaces Sidebar (plus
        * the frame paddings/gaps in card mode) so the workspace info
        * that follows lines up with the ChannelsSidebar boundary. The
        * macOS traffic-lights sit inside this region. */}
      <div
        className="shrink-0"
        style={{
          width:
            'calc(var(--nav-rail-width) + var(--sidebar-width) ' +
            '+ var(--frame-padding, 0px) * 3)',
        }}
      />

      <span className="truncate font-serif text-sm font-semibold text-text-primary">
        {hasWorkspace ? workspaceName : '—'}
        {workspaceKind === 'dm' && hasWorkspace ? (
          <span className="ml-1 text-text-muted">· DM</span>
        ) : null}
      </span>

      {isArchived ? (
        <span className="rounded-full bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">
          archived
        </span>
      ) : null}

      {showCreateChannel ? (
        <button
          type="button"
          onClick={onCreateChannel}
          aria-label="新建 Channel"
          title="新建 Channel"
          className="no-drag flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <MessageSquarePlus className="size-3.5" />
        </button>
      ) : null}

      {showTasks ? (
        <button
          type="button"
          onClick={onOpenTasks}
          aria-label="Tasks"
          title="Tasks"
          className="no-drag relative flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <CheckSquare className="size-3.5" />
          {taskCount && taskCount > 0 ? (
            <span className="absolute -right-1 -top-1 min-w-[14px] rounded-full bg-accent px-1 text-[9px] font-medium leading-[14px] text-text-on-accent">
              {taskCount}
            </span>
          ) : null}
        </button>
      ) : null}

      {showManageMembers ? (
        <ManageMembersPopover workspaceId={workspaceId!}>
          <button
            type="button"
            aria-label="管理成员"
            title="管理成员"
            className="no-drag flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <Users className="size-3.5" />
          </button>
        </ManageMembersPopover>
      ) : null}

      {showSettings ? (
        <button
          type="button"
          onClick={onOpenWorkspaceSettings}
          aria-label="Workspace 设置"
          title="Workspace 设置"
          className="no-drag flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <Settings className="size-3.5" />
        </button>
      ) : null}

      {/* Workspace path sits inline right after the action icons —
        * not pushed to the far right. rtl ellipsis preserves the path
        * tail (the most useful segment) when space runs out. The bare
        * span is itself a drag handle since it lives in the .drag-region
        * header without an explicit .no-drag opt-out. */}
      {workspacePath ? (
        <div className="min-w-0 max-w-[40%] truncate text-text-muted">
          <span title={workspacePath} dir="rtl">
            {workspacePath}
          </span>
        </div>
      ) : null}

      {/* Trailing spacer keeps a small breathable margin at the right
        * edge of the window. */}
      <div className="ml-auto w-3 shrink-0" />
    </header>
  );
}
