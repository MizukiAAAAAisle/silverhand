import { type SidebarPane, useSidebarPane } from "./use-sidebar-pane";

/**
 * Top-level layout preferences. The sidebar owns its animated visibility (see
 * `useSidebarPane`); persistence is delegated to that hook so the
 * storage shape stays per-key (one bool per pane) instead of a monolithic
 * `silverhand:layout-settings` blob — small, additive, and trivially
 * forward-compatible.
 *
 * ONE browse pane since #task:1889: channels became children of the workspace
 * rows in the single merged tree, so the second column — and with it
 * `silverhand:layout.channel-sidebar-visible` and the ⌘⇧\ chord — retired. The
 * stale key is left unread rather than migrated: it only ever encoded "is the
 * second column open", and there is no second column to open.
 */

const WORKSPACE_SIDEBAR_KEY = "silverhand:layout.workspace-sidebar-visible";

export interface LayoutSettings {
  workspaceSidebar: SidebarPane;
}

export function useLayoutSettings(): {
  layout: LayoutSettings;
  toggleWorkspaceSidebar: () => void;
} {
  const workspaceSidebar = useSidebarPane({
    storageKey: WORKSPACE_SIDEBAR_KEY,
    defaultVisible: true,
  });

  return {
    layout: { workspaceSidebar },
    toggleWorkspaceSidebar: workspaceSidebar.toggle,
  };
}
