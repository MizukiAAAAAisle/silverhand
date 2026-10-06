import { SidebarCloseIcon, SidebarOpenIcon } from "@/icons";
import type { ReactNode } from "react";

interface TitlebarProps {
  /** epoch ms when the workspace was archived; null for active workspaces.
   *  Drives the inline `Archived` pill so the user knows why this
   *  workspace is missing from the main sidebar list. */
  workspaceArchivedAt: number | null;
  workspaceSidebarVisible: boolean;
  onToggleWorkspaceSidebar: () => void;
  /** Which section's chrome the titlebar frames (#task:1394). `chat` shows the
   *  browse-sidebar toggle and offsets the archive status by the COLLAPSIBLE
   *  sidebar. `activity` has no browse sidebar — the Activity list is the left
   *  column — so it hides the toggle and offsets the status by
   *  `NavRail + Activity-list` width, reading the SAME `--activity-list-width`
   *  var the list is sized from. That keeps chat-only UI state out of the Activity
   *  layout AND — because the offset tracks the one width source — the status stays
   *  aligned above the ChannelView column while the user drags the Activity list
   *  wider/narrower (no second computed offset). With no channel selected the route
   *  carries no workspace, so no status renders and the offset is inert. */
  chromeMode: "chat" | "activity";
  /** Global-search pill (#task:2557), centered on the window. */
  search?: ReactNode;
}

/**
 * Window-wide drag region with sidebar controls and archive status.
 * Archive status starts after the section-specific left
 * chrome (`chromeWidth`) so it sits directly above the first content
 * column it describes: in chat that's the (collapsible) sidebar;
 * in activity it's the `NavRail + Activity list` offset, which
 * tracks the (resizable) Activity-list width (see `chromeMode`). The leftmost region is an empty drag area that also
 * doubles as the macOS traffic-lights inset. Spans the full window so it
 * doubles as the native title bar (`titleBarStyle: 'hiddenInset'` on
 * macOS — see main/index.ts).
 */
export function Titlebar({
  workspaceArchivedAt,
  workspaceSidebarVisible,
  onToggleWorkspaceSidebar,
  chromeMode,
  search,
}: TitlebarProps): JSX.Element {
  const isArchived = workspaceArchivedAt !== null;
  // Activity has no browse sidebar — the Activity list IS the left column — so
  // its status offset is `NavRail + Activity-list` width, read from the SAME
  // `--activity-list-width` var the list is sized from (never the collapsible
  // chat sidebar). Reading the single width source is what keeps the
  // status aligned above ChannelView as the user drags the list (`app-layout.md
  // §1.1`, #task:1394). Fallback to `--sidebar-width` only guards the var being
  // unset before first layout. Chat keeps the collapsible offset.
  const showSidebarToggle = chromeMode === "chat";
  const leftColumnWidth =
    chromeMode === "activity"
      ? "var(--activity-list-width, var(--sidebar-width))"
      : workspaceSidebarVisible
        ? "var(--sidebar-width)"
        : "0px";
  // Three gutters sit left of the next column: the frame's own left padding,
  // the frame gap between rail and section sheet (both `--frame-padding`), and
  // the sheet's INNER gap between left column and main — that third one is
  // `--pane-gap`, which iris takes to 0 (#task:1965). Every theme declares it
  // explicitly (#task:1972), so no fallback here.
  const chromeWidth =
    `calc(var(--nav-rail-width) + ${leftColumnWidth} + var(--frame-padding, 0px) * 2` +
    ` + var(--pane-gap))`;
  const toggleButton =
    "no-drag flex size-(--titlebar-control-size,1.5rem) items-center justify-center rounded-[var(--control-radius)] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-outline";

  return (
    <header
      data-titlebar="app"
      // The iOS shell sets the inset, row height and control sizes in iPad
      // windowed mode so the row centres on the system window controls;
      // otherwise the bar clears the top safe area (0 on desktop).
      className={
        "drag-region relative box-content flex shrink-0 items-center " +
        "h-(--titlebar-row-height,var(--titlebar-height)) " +
        "pt-(--titlebar-inset-top,env(safe-area-inset-top,0px)) " +
        "gap-2 border-b text-xs " +
        "bg-(--bg-app,var(--bg-primary)) " +
        "border-(--titlebar-border,var(--border-subtle))"
      }
    >
      {/* Spacer matches the visible left chrome so the archive status
       * lines up with the next column. The native macOS traffic-lights
       * and the sidebar toggle live inside this region. */}
      <div
        className="relative h-full shrink-0"
        style={{
          width: `max(var(--titlebar-controls-safe-width), ${chromeWidth})`,
        }}
      >
        <div className="absolute left-(--titlebar-sidebar-toggle-left) top-1/2 flex -translate-y-1/2 items-center gap-1">
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
              aria-label={workspaceSidebarVisible ? "Hide sidebar" : "Show sidebar"}
              aria-pressed={workspaceSidebarVisible}
              title="Sidebar (⌘\\)"
              className={toggleButton}
            >
              {workspaceSidebarVisible ? (
                <SidebarCloseIcon className="size-(--titlebar-icon-size,0.875rem)" />
              ) : (
                <SidebarOpenIcon className="size-(--titlebar-icon-size,0.875rem)" />
              )}
            </button>
          ) : null}
        </div>
      </div>

      {isArchived ? (
        <span className="rounded-full bg-bg-elevated px-1.5 py-0.5 text-(length:--text-badge) uppercase tracking-wider text-text-muted">
          archived
        </span>
      ) : null}

      {/* Centered on the whole window (no-drag so the pill takes clicks). The
       * box spans only the content row, so a top inset never shifts it off
       * the row's centre line. */}
      {search ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-(--titlebar-row-height,var(--titlebar-height)) items-center justify-center">
          <div className="no-drag pointer-events-auto w-[clamp(420px,52vw,720px)]">{search}</div>
        </div>
      ) : null}

      {/* Trailing spacer keeps a small breathable margin at the right
       * edge of the window. */}
      <div className="ml-auto w-3 shrink-0" />
    </header>
  );
}
