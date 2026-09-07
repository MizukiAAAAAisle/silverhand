import { ShutdownOverlay } from '@/features/app-shell/shutdown-overlay';
import { ChatShell } from '@/features/chat-shell/chat-shell';
import { ActivityShell } from '@/features/activity-shell/activity-shell';
import { TaskShell } from '@/features/task-shell/task-shell';
import { useConversationShell } from '@/features/conversation-shell/use-conversation-shell';
import { renderConversationPanes } from '@/features/conversation-shell/conversation-content';
import { useApplicationSignals } from '@/features/app-shell/application-signals';
import { AgentShell } from '@/features/agent-shell/agent-shell';
import { ComputerShell } from '@/features/computer-shell/computer-shell';
import { Toaster } from 'sonner';
import { NavRail } from '@/components/layout/NavRail';
import { SectionLayer } from '@/components/layout/SectionLayer';
import { Titlebar } from '@/components/layout/Titlebar';
import { useAppearance } from '@/hooks/useAppearance';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useRuntimeEpochPromotion,
  useViewerUser,
} from '@/features/me/hooks';
import { RegistrationGate } from '@/features/me/RegistrationGate';
import { BackendUnreachableGate } from '@/features/me/BackendUnreachableGate';
import { UpdateRequiredGate } from '@/features/me/UpdateRequiredGate';
import { AppStatusBanner } from '@/features/me/AppStatusBanner';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { shouldSecondaryFullscreen } from '@/lib/secondary-pane';
import { LAST_CHANNEL_KEY, clearPlaceMemory } from '@/lib/place-memory';
import { toasterTypedIcons } from '@/lib/toast-icons';

export { LAST_CHANNEL_KEY, clearPlaceMemory };

export function App(): JSX.Element {
  const { appearance } = useAppearance();

  useRuntimeEpochPromotion();

  const viewer = useViewerUser();

  // Three-way render: loading → registration gate → registered shell.
  // Critical: each branch returns BEFORE any further hooks, and the
  // shell lives in a separate component (`RegisteredAppShell`) so the
  // hook order is stable inside `App` across re-renders. If we kept
  // the shell hooks inline here, the post-registration render would
  // call dozens more hooks than the pre-registration render and React
  // would crash with "Rendered more hooks than during the previous
  // render".
  if (!viewer.data) {
    return (
      <div className="grid h-screen w-screen place-items-center bg-bg-base text-xs text-text-muted">
        Loading
      </div>
    );
  }

  if (isBackendUnreachable(viewer.data)) {
    return (
      <BackendUnreachableGate
        serverUrl={viewer.data.server_url}
        message={viewer.data.message}
        onRetry={() => {
          void viewer.refetch();
        }}
      />
    );
  }

  if (isUpdateRequired(viewer.data)) {
    return (
      <UpdateRequiredGate
        direction={viewer.data.direction}
        serverApiEpoch={viewer.data.server_api_epoch}
        onRetry={() => {
          void viewer.refetch();
        }}
      />
    );
  }
  if (isRegistrationRequired(viewer.data)) {
    return <RegistrationGate signupEnabled={viewer.data.signup_enabled} />;
  }
  // slack-dark is our only dark theme; studio-light / forza6 are light. sonner
  // then picks the matching default scale for the parts our token overrides in
  // global.css don't cover (e.g. any action/close button greys).
  return <RegisteredAppShell toasterTheme={appearance.theme === 'slack-dark' ? 'dark' : 'light'} />;
}

/**
 * Toast viewport insets (#task:1824 — notifications moved from the bottom-right
 * to the top-right).
 *
 * Top clears `--titlebar-height` instead of sitting on it: the titlebar is a
 * window-DRAG region, and a float parked over it both reads as "on top of the
 * chrome" and hands its own clicks to the window drag unless it opts out
 * (`AppStatusBanner` has to). Starting below the bar avoids that whole class,
 * and top-right of the CONTENT area is what "in-app" means anyway. Right inset
 * matches the titlebar's trailing spacer so the toast's edge lines up with the
 * chrome above it.
 *
 * `mobileOffset` is spelled out because the main window has no `minWidth`:
 * under 600px sonner swaps to its mobile insets (default 16px all round) and
 * would land back on the titlebar. All four keys are set in both objects —
 * sonner only writes the keys it is given, and its mobile rules compute
 * `width: calc(100% - var(--mobile-offset-left) * 2)`, which breaks on an
 * unset var.
 */
const TOAST_OFFSET = {
  top: 'calc(var(--titlebar-height) + 8px)',
  right: '12px',
  bottom: '24px',
  left: '24px',
} as const;
const TOAST_MOBILE_OFFSET = {
  top: 'calc(var(--titlebar-height) + 8px)',
  right: '16px',
  bottom: '16px',
  left: '16px',
} as const;

function RegisteredAppShell({ toasterTheme }: { toasterTheme: 'light' | 'dark' }): JSX.Element {
  const signals = useApplicationSignals();
  const { navRailDots } = signals;
  const conversation = useConversationShell(signals);
  const {
    toggleWorkspaceSidebar,
    nav,
    appSection,
    workspaceSidebarVisible,
    selectedWorkspace,
    titlebarWorkspaceName,
    openAgentConversation,
    deferredSection,
    handleJumpToMessage,
    handleMessageAgent,
  } = conversation.app;
  const content = renderConversationPanes(conversation.panes);
  const fullscreen = shouldSecondaryFullscreen(
    conversation.app.secondaryDescriptor,
    conversation.app.routeFullscreen,
  );

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={{
        backgroundImage: 'var(--app-paper, none)',
        backgroundSize: '100vw 100vh',
        backgroundRepeat: 'no-repeat',
      }}
    >
      <Titlebar
        workspaceName={titlebarWorkspaceName}
        workspaceArchivedAt={selectedWorkspace?.archived_at ?? null}
        workspaceSidebarVisible={workspaceSidebarVisible}
        onToggleWorkspaceSidebar={toggleWorkspaceSidebar}
        chromeMode={appSection === 'activity' ? 'activity' : 'chat'}
      />
      <div
        className="flex min-w-0 flex-1 overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-app, transparent)',
          padding: '0 var(--frame-padding, 0) var(--frame-padding, 0)',
          gap: 'var(--frame-padding, 0)',
        }}
      >
        <NavRail
          current={appSection}
          dots={navRailDots}
          onChange={(section) => {
            if (section === 'chat') {
              nav.toChat();
            } else if (section === 'activity') {
              nav.toActivity();
            } else if (section === 'tasks') {
              nav.toTasks();
            } else if (section === 'members') {
              nav.toMembers();
            } else if (section === 'settings') {
              nav.toSettings();
            } else {
              nav.toComputers();
            }
          }}
        />
        <div
          data-section-sheet=""
          className="flex min-w-0 flex-1"
          style={{ gap: 'var(--pane-gap)' }}
        >
          {deferredSection === 'settings' && (
            <SectionLayer visible={appSection !== 'chat'}>
              <SettingsPage />
            </SectionLayer>
          )}
          {deferredSection === 'tasks' && (
            <SectionLayer visible={appSection !== 'chat'}>
              <TaskShell onJump={handleJumpToMessage} />
            </SectionLayer>
          )}
          <AgentShell
            mounted={deferredSection === 'members'}
            visible={appSection !== 'chat'}
            onMessageAgent={handleMessageAgent}
            onOpenConversation={openAgentConversation}
          />
          <ComputerShell
            mounted={deferredSection === 'computers'}
            visible={appSection !== 'chat'}
          />
          <ActivityShell model={conversation.activity} content={content} fullscreen={fullscreen} />
          <ChatShell model={conversation.chat} content={content} fullscreen={fullscreen} />
        </div>
      </div>

      {/* Toast surface follows the active theme: `theme` picks sonner's
       * light/dark default scale, and global.css maps its fill / text /
       * border / radius onto our tokens (forza6 gets the ink frame). No
       * `richColors` — that paints the whole toast in sonner's own hue
       * palette; instead the surface stays neutral and the type icon carries
       * the semantic, matching AppStatusBanner. Icons come from the shared
       * lib/toast-icons authority; only sonner's typed levels have map slots
       * here — neutral `toast()` calls pass their own icon from the same
       * table. */}
      <Toaster
        position="top-right"
        theme={toasterTheme}
        icons={toasterTypedIcons}
        offset={TOAST_OFFSET}
        mobileOffset={TOAST_MOBILE_OFFSET}
      />

      <AppStatusBanner />

      <ShutdownOverlay />
    </div>
  );
}
