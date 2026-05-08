import { type SidebarPane, useSidebarPane } from './useSidebarPane';

/**
 * Top-level layout preferences. Each sidebar owns its own animated
 * visibility state machine (see `useSidebarPane`); persistence is
 * delegated to that hook so the storage shape stays per-key (one bool
 * per sidebar) instead of a monolithic `silverhand:layout-settings`
 * blob — small, additive, and trivially forward-compatible.
 */

const WORKSPACE_SIDEBAR_KEY = 'silverhand:layout.workspace-sidebar-visible';
const CHANNEL_SIDEBAR_KEY = 'silverhand:layout.channel-sidebar-visible';

export interface LayoutSettings {
  workspaceSidebar: SidebarPane;
  channelSidebar: SidebarPane;
}

export function useLayoutSettings(): {
  layout: LayoutSettings;
  toggleWorkspaceSidebar: () => void;
  toggleChannelSidebar: () => void;
} {
  const workspaceSidebar = useSidebarPane({
    storageKey: WORKSPACE_SIDEBAR_KEY,
    defaultVisible: true,
  });
  const channelSidebar = useSidebarPane({
    storageKey: CHANNEL_SIDEBAR_KEY,
    defaultVisible: true,
  });

  return {
    layout: { workspaceSidebar, channelSidebar },
    toggleWorkspaceSidebar: workspaceSidebar.toggle,
    toggleChannelSidebar: channelSidebar.toggle,
  };
}
