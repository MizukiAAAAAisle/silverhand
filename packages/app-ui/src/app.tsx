import { MobileHeaderProvider, MobileHeaderScope } from "@/components/layout/mobile-header-slot";
import { useAppOptions } from "./app-options";
import { NavigationLaunch } from "@/navigation/launch";
import { NavigationProvider } from "@/navigation/provider";
import { useCompactLayout } from "@/navigation/layout";
import { getPlatform } from "@/platform";
import { MobileHeader, MobileTabBar } from "@/components/layout/mobile-shell";
import { useEffect, useState } from "react";
import { ShutdownOverlay } from "@/features/app-shell/shutdown-overlay";
import { ChatShell, isChatSidebarPage } from "@/pages/chat/chat-shell";
import { ActivityShell } from "@/pages/activity/activity-shell";
import { TaskShell } from "@/pages/task/task-shell";
import { useConversationShell } from "@/features/conversation-shell/use-conversation-shell";
import { renderConversationPanes } from "@/features/conversation-shell/conversation-content";
import { useApplicationSignals } from "@/features/app-shell/application-signals";
import { AgentShell } from "@/pages/agent/agent-shell";
import { ComputerShell } from "@/pages/computer/computer-shell";
import { Toaster } from "sonner";
import { NavRail } from "@/components/layout/nav-rail";
import { SectionLayer } from "@/components/layout/section-layer";
import { Titlebar } from "@/components/layout/titlebar";
import { TitlebarSearch } from "@/features/search/titlebar-search";
import { useAppearance } from "@/features/appearance/use-appearance";
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useRuntimeEpochPromotion,
  useViewerUser,
} from "@/features/session/hooks";
import { EmbeddedProfileSetupGate } from "@/features/app-shell/embedded-profile-setup-gate";
import { RegistrationGate } from "@/features/app-shell/registration-gate";
import { BackendUnreachableGate } from "@/features/app-shell/backend-unreachable-gate";
import { UpdateRequiredGate } from "@/features/app-shell/update-required-gate";
import { AppStatusBanner } from "@/features/app-shell/app-status-banner";
import { SettingsShell } from "@/pages/settings/settings-shell";
import { shouldSecondaryFullscreen } from "@/features/conversation-shell/model/secondary-pane";
import { LAST_CHANNEL_KEY, clearPlaceMemory } from "@/features/app-shell/place-memory";
import { toasterTypedIcons } from "@/lib/toast-icons";

export { LAST_CHANNEL_KEY, clearPlaceMemory };

export function App({
  initialNavigationUrl = "/chat",
}: { initialNavigationUrl?: string } = {}): JSX.Element {
  const { appearance } = useAppearance();
  const { loginFirst, showServerAddress = false } = useAppOptions();

  useRuntimeEpochPromotion();

  const viewer = useViewerUser();
  const [navigationLaunch] = useState(() => new NavigationLaunch(initialNavigationUrl));
  const [hasSignedIn, setHasSignedIn] = useState(false);
  const authenticated = Boolean(viewer.data && "id" in viewer.data);
  useEffect(() => {
    if (authenticated) setHasSignedIn(true);
  }, [authenticated]);

  // Three-way render: loading → registration gate → registered shell.
  // Critical: each branch returns BEFORE any further hooks, and the
  // shell lives in a separate component (`RegisteredAppShell`) so the
  // hook order is stable inside `App` across re-renders. If we kept
  // the shell hooks inline here, the post-registration render would
  // call dozens more hooks than the pre-registration render and React
  // would crash with "Rendered more hooks than during the previous
  // render".
  // A relaunch (the OS reclaims the WebView in the background) starts with no
  // session answer. Until it arrives, paint the bare canvas the native launch
  // screen already shows: a signed-in user must not see the login form flash.
  if (loginFirst && !viewer.data) {
    return <div className="h-screen w-screen bg-bg-base" />;
  }
  if (
    loginFirst &&
    viewer.data &&
    (isBackendUnreachable(viewer.data) || isRegistrationRequired(viewer.data))
  ) {
    const registration = isRegistrationRequired(viewer.data) ? viewer.data : null;
    const ready = registration !== null;
    return (
      <RegistrationGate
        signupEnabled={registration?.signup_enabled ?? false}
        preferLogin
        autoFocus={false}
        connectionStatus={isBackendUnreachable(viewer.data) ? viewer.data.message : undefined}
        connectionChecking={viewer.isFetching}
        connectionReady={ready}
        showServerAddress={showServerAddress}
        onRetry={() => {
          void viewer.refetch();
        }}
      />
    );
  }
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
    return (
      <RegistrationGate
        signupEnabled={viewer.data.signup_enabled}
        preferLogin={hasSignedIn}
        showServerAddress={showServerAddress}
        onRetry={() => {
          void viewer.refetch();
        }}
      />
    );
  }
  // slack-dark is our only dark theme; studio-light / poster are light. sonner
  // then picks the matching default scale for the parts our token overrides in
  // chrome.css don't cover (e.g. any action/close button greys).
  return (
    <EmbeddedProfileSetupGate key={viewer.data.id} viewerId={viewer.data.id}>
      <NavigationProvider launch={navigationLaunch}>
        <RegisteredAppShell toasterTheme={appearance.theme === "slack-dark" ? "dark" : "light"} />
      </NavigationProvider>
    </EmbeddedProfileSetupGate>
  );
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
  top: "calc(var(--titlebar-row-height, var(--titlebar-height)) + var(--titlebar-inset-top, env(safe-area-inset-top, 0px)) + 8px)",
  right: "12px",
  bottom: "24px",
  left: "24px",
} as const;
const TOAST_MOBILE_OFFSET = {
  top: "calc(var(--titlebar-row-height, var(--titlebar-height)) + var(--titlebar-inset-top, env(safe-area-inset-top, 0px)) + 8px)",
  right: "16px",
  bottom: "16px",
  left: "16px",
} as const;

function RegisteredAppShell({ toasterTheme }: { toasterTheme: "light" | "dark" }): JSX.Element {
  const compact = useCompactLayout();
  const signals = useApplicationSignals();
  const { navRailDots } = signals;
  const conversation = useConversationShell(signals);
  const {
    toggleWorkspaceSidebar,
    nav,
    appSection,
    workspaceSidebarVisible,
    selectedWorkspace,
    openAgentConversation,
    deferredSection,
    handleJumpToMessage,
    handleMessageAgent,
    resolveNavWorkspaceId,
  } = conversation.app;
  const content = renderConversationPanes(conversation.panes);
  const fullscreen = shouldSecondaryFullscreen(
    conversation.app.secondaryDescriptor,
    conversation.app.routeFullscreen,
  );

  return (
    <MobileHeaderProvider section={appSection}>
      <div
        className="app-shell flex h-screen w-screen flex-col overflow-hidden"
        style={{
          backgroundImage: "var(--app-paper, none)",
          backgroundSize: "100vw 100vh",
          backgroundRepeat: "no-repeat",
        }}
      >
        {compact ? (
          <MobileHeader
            hideFallback={appSection === "chat" && isChatSidebarPage(conversation.chat, content)}
          />
        ) : (
          <Titlebar
            workspaceArchivedAt={selectedWorkspace?.archived_at ?? null}
            workspaceSidebarVisible={workspaceSidebarVisible}
            onToggleWorkspaceSidebar={toggleWorkspaceSidebar}
            chromeMode={appSection === "activity" ? "activity" : "chat"}
            search={
              <TitlebarSearch
                nav={{
                  onJumpMessage: handleJumpToMessage,
                  onOpenConversation: (workspaceId, channelId) => {
                    const navWorkspaceId = resolveNavWorkspaceId(workspaceId, channelId);
                    if (navWorkspaceId) nav.toChannel(navWorkspaceId, channelId);
                  },
                  onOpenWorkspace: nav.toWorkspace,
                  onOpenDirectPair: nav.toDirect,
                  onOpenDirectDraft: nav.toDirectDraft,
                  onOpenAdvanced: (query) => nav.toChatSearch(query ? { q: query } : undefined),
                }}
              />
            }
          />
        )}
        <div
          data-app-frame
          className="flex min-w-0 flex-1 overflow-hidden"
          style={{
            padding: "0 var(--frame-padding, 0) var(--frame-padding, 0)",
            gap: "var(--frame-padding, 0)",
          }}
        >
          {!compact && (
            <NavRail
              current={appSection}
              dots={navRailDots}
              onChange={(section) => {
                if (section === "chat") {
                  nav.toChat();
                } else if (section === "activity") {
                  nav.toActivity();
                } else if (section === "tasks") {
                  nav.toTasks();
                } else if (section === "members") {
                  nav.toMembers();
                } else if (section === "settings") {
                  nav.toSettings();
                } else {
                  nav.toComputers();
                }
              }}
            />
          )}
          <div
            data-section-sheet=""
            className="flex min-w-0 flex-1"
            style={{ gap: "var(--pane-gap)" }}
          >
            {deferredSection === "settings" && (
              <SectionLayer visible={appSection !== "chat"}>
                <MobileHeaderScope section="settings">
                  <SettingsShell />
                </MobileHeaderScope>
              </SectionLayer>
            )}
            <MobileHeaderScope section="tasks">
              <TaskShell
                mounted={deferredSection === "tasks"}
                visible={appSection !== "chat"}
                onJump={handleJumpToMessage}
              />
            </MobileHeaderScope>
            <MobileHeaderScope section="members">
              <AgentShell
                mounted={deferredSection === "members"}
                visible={appSection !== "chat"}
                onMessageAgent={handleMessageAgent}
                onOpenConversation={openAgentConversation}
              />
            </MobileHeaderScope>
            <MobileHeaderScope section="computers">
              <ComputerShell
                mounted={deferredSection === "computers"}
                visible={appSection !== "chat"}
              />
            </MobileHeaderScope>
            <MobileHeaderScope section="activity">
              <ActivityShell
                model={conversation.activity}
                content={content}
                fullscreen={fullscreen}
              />
            </MobileHeaderScope>
            <MobileHeaderScope section="chat">
              <ChatShell model={conversation.chat} content={content} fullscreen={fullscreen} />
            </MobileHeaderScope>
          </div>
        </div>

        {(compact || getPlatform().navigation) && <MobileTabBar dots={navRailDots} />}

        {/* Toast surface follows the active theme: `theme` picks sonner's
         * light/dark default scale, and chrome.css maps its fill / text /
         * border / radius onto our tokens (poster gets the ink frame). No
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
    </MobileHeaderProvider>
  );
}
