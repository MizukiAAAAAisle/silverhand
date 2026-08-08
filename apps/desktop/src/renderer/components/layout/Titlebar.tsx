import {
  CheckSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Users,
} from 'lucide-react';
import { ManageMembersPopover } from '@/features/workspaces/ManageMembersPopover';

type WorkspaceUiKind = 'regular' | 'dm';

interface TitlebarProps {
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceKind: WorkspaceUiKind | null;
  /** epoch ms when the workspace was archived; null for active workspaces.
   *  Drives the inline `Archived` pill so the user knows why this
   *  workspace is missing from the main sidebar list. */
  workspaceArchivedAt: number | null;
  onOpenWorkspaceSettings?: () => void;
  /** Tasks panel trigger. Provided only when a chat workspace is selected.
   *  Click opens the workspace-wide tasks drawer (4-column kanban). */
  onOpenTasks?: () => void;
  /** Active-task count for the workspace — drives the small badge next to
   *  the Tasks button. Hidden when 0 / undefined, and equally when `null`: the
   *  counts face has not answered, and 16px of chrome has no honest way to say
   *  that (#task:1885). */
  taskCount?: number | null;
  workspaceSidebarVisible: boolean;
  onToggleWorkspaceSidebar: () => void;
  /** Which section's chrome the titlebar frames (#task:1394). `chat` shows the
   *  browse-sidebar toggle and offsets the workspace label by the COLLAPSIBLE
   *  sidebar. `activity` has no browse sidebar — the Activity list is the left
   *  column — so it hides the toggle and offsets the label by
   *  `NavRail + Activity-list` width, reading the SAME `--activity-list-width`
   *  var the list is sized from. That keeps chat-only UI state out of the Activity
   *  layout AND — because the offset tracks the one width source — the label stays
   *  aligned above the ChannelView column while the user drags the Activity list
   *  wider/narrower (no second computed offset). With no channel selected the route
   *  carries no workspace, so no label renders and the offset is inert. */
  chromeMode: 'chat' | 'activity';
}

/**
 * Window-wide titlebar — drag region with the current workspace's name
 * and its primary actions (Settings, Manage Members, New Channel).
 * Workspace info starts after the section-specific left
 * chrome (`chromeWidth`) so it sits directly above the first content
 * column it describes: in chat that's the (collapsible) sidebar;
 * in activity it's the `NavRail + Activity list` offset, which
 * tracks the (resizable) Activity-list width (see `chromeMode`). The leftmost region is an empty drag area that also
 * doubles as the macOS traffic-lights inset. Spans the full window so it
 * doubles as the native title bar (`titleBarStyle: 'hiddenInset'` on
 * macOS — see main/index.ts).
 */
export function Titlebar({
  workspaceId,
  workspaceName,
  workspaceKind,
  workspaceArchivedAt,
  onOpenWorkspaceSettings,
  onOpenTasks,
  taskCount,
  workspaceSidebarVisible,
  onToggleWorkspaceSidebar,
  chromeMode,
}: TitlebarProps): JSX.Element {
  const hasWorkspace = workspaceName !== null;
  const showManageMembers = hasWorkspace && workspaceKind !== 'dm' && !!workspaceId;
  const showSettings = hasWorkspace && workspaceKind !== 'dm' && !!onOpenWorkspaceSettings;
  const showTasks = hasWorkspace && !!onOpenTasks;
  const isArchived = workspaceArchivedAt !== null;
  // Activity has no browse sidebar — the Activity list IS the left column — so
  // its label offset is `NavRail + Activity-list` width, read from the SAME
  // `--activity-list-width` var the list is sized from (never the collapsible
  // chat sidebar). Reading the single width source is what keeps the
  // label aligned above ChannelView as the user drags the list (`app-layout.md
  // §1.1`, #task:1394). Fallback to `--sidebar-width` only guards the var being
  // unset before first layout. Chat keeps the collapsible offset.
  const showSidebarToggle = chromeMode === 'chat';
  const leftColumnWidth =
    chromeMode === 'activity'
      ? 'var(--activity-list-width, var(--sidebar-width))'
      : workspaceSidebarVisible
        ? 'var(--sidebar-width)'
        : '0px';
  const chromeWidth = `calc(var(--nav-rail-width) + ${leftColumnWidth} + var(--frame-padding, 0px) * 3)`;
  const toggleButton =
    'no-drag flex size-6 items-center justify-center rounded-[6px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus';

  return (
    <header
      data-titlebar="app"
      className={
        'drag-region flex h-[var(--titlebar-height)] shrink-0 items-center ' +
        'gap-2 border-b text-xs ' +
        'bg-[var(--bg-app,var(--bg-primary))] ' +
        'border-[var(--titlebar-border,var(--border-subtle))]'
      }
    >
      {/* Spacer matches the visible left chrome so the workspace info
        * lines up with the next column. The native macOS traffic-lights
        * and the sidebar toggle live inside this region. */}
      <div
        className="relative h-full shrink-0"
        style={{
          width: `max(var(--titlebar-controls-safe-width), ${chromeWidth})`,
        }}
      >
        <div className="absolute left-[var(--titlebar-sidebar-toggle-left)] top-1/2 flex -translate-y-1/2 items-center gap-1">
          {/* The browse-sidebar toggle is chat-only: Activity has no browse
            * sidebar (its list is a fixed column), so it's hidden there —
            * the empty region still reserves the traffic-lights inset via
            * `chromeWidth`/`--titlebar-controls-safe-width` (#task:1394).
            *
            * ONE toggle since #task:1889 merged the two browse columns into a
            * single tree. State is communicated by *icon shape*, not background
            * colour: the chevron points at what the click will do — close the
            * panel while it is visible, open it while it is hidden (#task:1904).
            * The retired channel toggle's Columns/Square family went with its
            * column — a second shape family for one pane would read as a
            * missing control. */}
          {showSidebarToggle ? (
            <button
              type="button"
              onClick={onToggleWorkspaceSidebar}
              aria-label={
                workspaceSidebarVisible ? 'Hide sidebar' : 'Show sidebar'
              }
              aria-pressed={workspaceSidebarVisible}
              title="Sidebar (⌘\\)"
              className={toggleButton}
            >
              {workspaceSidebarVisible ? (
                <PanelLeftClose className="size-3.5" />
              ) : (
                <PanelLeftOpen className="size-3.5" />
              )}
            </button>
          ) : null}
        </div>
      </div>

      {hasWorkspace ? (
        <span
          data-workspace-name
          className="truncate font-serif text-sm font-semibold text-text-primary"
        >
          {/* DM titlebars show only the bound agent's raw display name — no
            * `@`, no `· DM` marker (shiki 2026-08-01, #task:1768). Reads like
            * the person you're talking to; the icon + rail already convey it's
            * a DM. The name itself is resolved upstream via `dmRecognitionName`
            * (App.tsx), shared with the rail so the two can't drift. */}
          {workspaceName}
        </span>
      ) : null}

      {isArchived ? (
        <span className="rounded-full bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">
          archived
        </span>
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
            aria-label="Manage members"
            title="Manage members"
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
          aria-label="Workspace settings"
          title="Workspace settings"
          className="no-drag flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <Settings className="size-3.5" />
        </button>
      ) : null}

      {/* Trailing spacer keeps a small breathable margin at the right
        * edge of the window. */}
      <div className="ml-auto w-3 shrink-0" />
    </header>
  );
}
