import {
  CheckSquare,
  Columns2,
  PanelLeft,
  PanelLeftDashed,
  Settings,
  Users,
} from 'lucide-react';
import { ManageMembersPopover } from '@/features/workspaces/ManageMembersPopover';

type WorkspaceUiKind = 'regular' | 'dm';

/**
 * Mirror of `Columns2` with the central divider drawn as four short
 * dashes — same stylistic family as lucide's `PanelLeftDashed`. Used as
 * the "channel sidebar hidden" glyph so the channel toggle communicates
 * its state through the same solid-vs-dashed-divider vocabulary as the
 * workspace toggle (PanelLeft ↔ PanelLeftDashed), just with the divider
 * placed at the center to indicate the SECOND column instead of the
 * first.
 */
function Columns2Dashed(props: React.SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      {/* Dashed divider at x=12 — segment positions copied from
        * `PanelLeftDashed` so the visual rhythm matches. */}
      <path d="M12 3v2" />
      <path d="M12 9v1" />
      <path d="M12 14v1" />
      <path d="M12 19v2" />
    </svg>
  );
}

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
  /** Tasks panel trigger. Provided only when a chat workspace is selected.
   *  Click opens the workspace-wide tasks drawer (4-column kanban). */
  onOpenTasks?: () => void;
  /** Active-task count for the workspace — drives the small badge next to
   *  the Tasks button. Hidden when 0 / undefined. */
  taskCount?: number;
  workspaceSidebarVisible: boolean;
  channelSidebarVisible: boolean;
  onToggleWorkspaceSidebar: () => void;
  onToggleChannelSidebar: () => void;
  /** Which section's chrome the titlebar frames (#task:1394). `chat` shows the
   *  two browse-sidebar toggles and offsets the workspace label by the
   *  COLLAPSIBLE workspace sidebar. `activity` has no browse sidebars — the
   *  Activity list is the left column — so it hides the toggles and offsets the
   *  label by `NavRail + Activity-list` width, reading the SAME
   *  `--activity-list-width` var the list is sized from. That keeps chat-only UI
   *  state out of the Activity layout AND — because the offset tracks the one
   *  width source — the label stays aligned above the ChannelView column while
   *  the user drags the Activity list wider/narrower (no second computed
   *  offset). With no channel selected the route carries no workspace, so no
   *  label renders and the offset is inert. */
  chromeMode: 'chat' | 'activity';
}

/**
 * Window-wide titlebar — drag region with the current workspace's name,
 * its primary actions (Settings, Manage Members, New Channel), and the
 * workspace path right-aligned with rtl ellipsis so the path tail
 * stays visible. Workspace info starts after the section-specific left
 * chrome (`chromeWidth`) so it sits directly above the first content
 * column it describes: in chat that's the (collapsible) workspace
 * sidebar; in activity it's the `NavRail + Activity list` offset, which
 * tracks the (resizable) Activity-list width (see `chromeMode`). The leftmost region is an empty drag area that also
 * doubles as the macOS traffic-lights inset. Spans the full window so it
 * doubles as the native title bar (`titleBarStyle: 'hiddenInset'` on
 * macOS — see main/index.ts).
 */
export function Titlebar({
  workspaceId,
  workspaceName,
  workspaceKind,
  workspacePath,
  workspaceArchivedAt,
  onOpenWorkspaceSettings,
  onOpenTasks,
  taskCount,
  workspaceSidebarVisible,
  channelSidebarVisible,
  onToggleWorkspaceSidebar,
  onToggleChannelSidebar,
  chromeMode,
}: TitlebarProps): JSX.Element {
  const hasWorkspace = workspaceName !== null;
  const showManageMembers = hasWorkspace && workspaceKind !== 'dm' && !!workspaceId;
  const showSettings = hasWorkspace && workspaceKind !== 'dm' && !!onOpenWorkspaceSettings;
  const showTasks = hasWorkspace && !!onOpenTasks;
  const isArchived = workspaceArchivedAt !== null;
  // Activity has no browse sidebars — the Activity list IS the left column — so
  // its label offset is `NavRail + Activity-list` width, read from the SAME
  // `--activity-list-width` var the list is sized from (never the collapsible
  // chat workspace sidebar). Reading the single width source is what keeps the
  // label aligned above ChannelView as the user drags the list (`app-layout.md
  // §1.1`, #task:1394). Fallback to `--sidebar-width` only guards the var being
  // unset before first layout. Chat keeps the collapsible offset.
  const showSidebarToggles = chromeMode === 'chat';
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
        * and sidebar toggles live inside this region. */}
      <div
        className="relative h-full shrink-0"
        style={{
          width: `max(var(--titlebar-controls-safe-width), ${chromeWidth})`,
        }}
      >
        <div className="absolute left-[var(--titlebar-sidebar-toggle-left)] top-1/2 flex -translate-y-1/2 items-center gap-1">
          {/* Browse-sidebar toggles are chat-only: Activity has no browse
            * sidebars (its list is a fixed column), so they're hidden there —
            * the empty region still reserves the traffic-lights inset via
            * `chromeWidth`/`--titlebar-controls-safe-width` (#task:1394). */}
          {showSidebarToggles ? (
            <>
              {/* Workspace toggle uses the Panel-* family so it's visually
                * distinct from the Channel toggle's Columns/Square family.
                * State is communicated by *icon shape*, not background colour:
                * solid panel = visible; dashed panel = hidden. */}
              <button
                type="button"
                onClick={onToggleWorkspaceSidebar}
                aria-label={
                  workspaceSidebarVisible
                    ? 'Hide workspace sidebar'
                    : 'Show workspace sidebar'
                }
                aria-pressed={workspaceSidebarVisible}
                title="Workspace sidebar (⌘⇧\\)"
                className={toggleButton}
              >
                {workspaceSidebarVisible ? (
                  <PanelLeft className="size-3.5" />
                ) : (
                  <PanelLeftDashed className="size-3.5" />
                )}
              </button>
              {/* Channel toggle mirrors the workspace toggle's vocabulary:
                * solid divider = visible, dashed divider = hidden. The
                * difference is divider POSITION — workspace's lives at x=9
                * (first column boundary), channel's lives at x=12 (second
                * column boundary), so the two toggles read as "first / second
                * sidebar" without needing a label. */}
              <button
                type="button"
                onClick={onToggleChannelSidebar}
                aria-label={
                  channelSidebarVisible
                    ? 'Hide channel sidebar'
                    : 'Show channel sidebar'
                }
                aria-pressed={channelSidebarVisible}
                title="Channel sidebar (⌘\\)"
                className={toggleButton}
              >
                {channelSidebarVisible ? (
                  <Columns2 className="size-3.5" />
                ) : (
                  <Columns2Dashed className="size-3.5" />
                )}
              </button>
            </>
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
