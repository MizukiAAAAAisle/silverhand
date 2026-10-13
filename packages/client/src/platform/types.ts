import type {
  ConnectionPolicy,
  ConnectionInfo,
  ProfileSaveWithTestResult,
  ClearProfileResult,
} from "../connection/types.js";
import type { ClientAuthState, ClientAuthResult } from "../session/types.js";
import type {
  AuthSignupInput,
  AuthLoginInput,
  ServerConnectionProfileView,
} from "@silverhand/shared";
import type {
  BackendProxyRequest,
  BackendProxyResponse,
  BackendUploadRequest,
  EventWsDiagnostic,
  EventSocket,
} from "../transport/types.js";
import type { LocalHostCapability } from "../platform/local-host.js";

export interface ClientAdapter {
  getConnectionPolicy(): Promise<ConnectionPolicy>;
  getConnectionInfo(): Promise<ConnectionInfo | null>;
  getAuthState(): Promise<ClientAuthState>;
  signup(input: AuthSignupInput): Promise<ClientAuthResult>;
  login(input: AuthLoginInput): Promise<ClientAuthResult>;
  logout(): Promise<{ ok: true }>;
  backendRequest(input: BackendProxyRequest): Promise<BackendProxyResponse>;
  backendUpload(input: BackendUploadRequest): Promise<BackendProxyResponse>;
  recordEventWsDiagnostic(input: EventWsDiagnostic): Promise<void>;
  getServerConnectionProfile(): Promise<ServerConnectionProfileView | null>;
  saveServerConnectionProfile(input: { serverUrl: string }): Promise<ProfileSaveWithTestResult>;
  clearServerConnectionProfile(): Promise<ClearProfileResult>;
  onEpochUpdateRequired(handler: () => void): () => void;
  openEventSocket(url: string): EventSocket;
}

export interface ShellCapability {
  setPinchZoom(enabled: boolean): void;
  onShutdownProgress(handler: (step: string) => void): () => void;
  onNavigateSettings(handler: () => void): () => void;
  onContextualClose(handler: (reqId: string) => void): () => void;
  respondContextualClose(reqId: string, outcome: "closed-panel" | "background-app"): void;
}

export interface NotificationCapability {
  showSystemNotification(opts: {
    title: string;
    body: string;
    force?: boolean;
    notificationId?: string;
  }): Promise<void>;
  onNotificationClicked(handler: (notificationId: string) => void): () => void;
  dismissSystemNotifications(notificationIds: string[]): Promise<void>;
  setBadgeCount(count: number): Promise<void>;
}

export interface FileCapability {
  openExternal(url: string): Promise<void>;
  /** Omitted when the host cannot hand attachment files to external apps. */
  openAttachmentExternal?(input: {
    attachmentId: string;
    filename: string;
    bytes: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  saveAttachment(input: {
    filename: string;
    bytes: Uint8Array;
  }): Promise<
    { ok: true; path?: string } | { ok: false; canceled: true } | { ok: false; reason: string }
  >;
  sharePngExport?(input: {
    pngBytes: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; canceled: true } | { ok: false; error: string }>;
  savePngExport(input: {
    pngBytes: Uint8Array;
    suggestedName: string;
  }): Promise<
    { ok: true; path?: string } | { ok: false; canceled: true } | { ok: false; error: string }
  >;
  copyPngExport(input: {
    pngBytes: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
}

export type AppUpdateInstallMode = "now" | "on-quit";

/** One app-wide update state; every entry point reads it and acts through the same capability. */
export type AppUpdateState =
  /** `currentVersion` is the running build, so "up to date" can say which one. */
  | { status: "idle"; currentVersion: string; lastCheckedAt: number | null }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; transferred: number; total: number | null }
  | { status: "downloaded"; version: string }
  /** Staging the downloaded bundle for install (signature check happens here). */
  | { status: "installing"; version: string }
  /** Staged; the next normal quit installs it. */
  | { status: "scheduled"; version: string }
  | { status: "error"; message: string; version: string | null };

export interface AppUpdateCapability {
  /** Null when this build has no update channel. */
  getState(): Promise<AppUpdateState | null>;
  subscribe(handler: (state: AppUpdateState) => void): () => void;
  check(): Promise<void>;
  download(): Promise<void>;
  /** `now` restarts into the update; `on-quit` installs on the next normal quit. */
  install(mode: AppUpdateInstallMode): Promise<void>;
  /** Main asks the UI to show the update dialog (e.g. the app menu's Check for Updates). */
  onShowDialog(handler: () => void): () => void;
}

/** Installed once by an application entry point, before mounting the UI. */
export interface ClientPlatform {
  client: ClientAdapter;
  files: FileCapability;
  localHost?: LocalHostCapability;
  shell?: ShellCapability;
  notifications?: NotificationCapability;
  navigation?: NavigationCapability;
  titlebar?: TitlebarCapability;
  pageBar?: PageBarCapability;
  /** Present only where the app can update itself. */
  appUpdate?: AppUpdateCapability;
  /** The running build's release version; omitted where the host has none. */
  getAppVersion?(): Promise<string>;
}

/** Optional native presentation. Navigation history, the page stack and its
 * transitions remain owned by the shared UI; native draws the tab bar and
 * reports tab selection. */
export interface NativeNavigationState {
  blocked: boolean;
  modalVersion: number;
  session: string;
  key: string;
  tab: "chat" | "activity" | "tasks" | "me";
  visible: boolean;
}
export interface NativeNavigationIntent {
  modalVersion: number;
  session: string;
  kind: "tab";
  target: string;
}
/**
 * Native bars render what the shared UI declares and report taps back as
 * events; every state, rule and string comes from the declaration.
 */
/** The window titlebar's controls; the shared UI owns their state. */
export interface TitlebarState {
  /** The browse sidebar toggle; null hides it. */
  sidebar: { shown: boolean; label: string } | null;
  /** A status label beside the toggle, such as an archived workspace's. */
  status: string | null;
  searchPlaceholder: string;
  /** The search shortcut's name in the keyboard shortcut list. */
  searchShortcut: string;
  /** The window frame behind the panes is dark, so the bars and status bar
   *  over it take the dark appearance. */
  dark: boolean;
}
export type TitlebarSearchKey = "up" | "down" | "tab" | "backtab" | "enter" | "escape";
export type TitlebarEvent =
  | { kind: "toggleSidebar" }
  | { kind: "searchFocus" }
  | { kind: "searchQuery"; query: string }
  | { kind: "searchKey"; key: TitlebarSearchKey };
/** A native window titlebar with a search field. Results stay in the shared UI. */
export interface TitlebarCapability {
  /** Shows the titlebar with this state; null removes it. */
  sync(state: TitlebarState | null): Promise<void>;
  /** Leaves the search field, clearing it when a search has completed. */
  endSearch(input: { clear: boolean }): Promise<void>;
  subscribe(handler: (event: TitlebarEvent) => void): Promise<() => void>;
}
/** A control the native page bar draws. `icon` is SVG markup on a 24px grid, drawn as a template. */
export interface PageBarItem {
  id: string;
  label: string;
  /** Spoken in place of `label`, when they differ. */
  accessibilityLabel?: string;
  icon: string;
  selected?: boolean;
  /** Shows the unread dot. */
  dot?: boolean;
  /** The action destroys something; a menu marks it so. */
  destructive?: boolean;
  /** The page's main action, which a bar keeps out of its overflow menu. */
  primary?: boolean;
}
export interface PageBarTab extends PageBarItem {
  /** The menu item that closes the tab; null when it cannot close. */
  closeLabel: string | null;
}
/** The compact layout's page header, as the shared UI declares it. Fields
 * are semantic; the native bar decides how they look. iOS decodes each field
 * by name (`SilverhandClientPlugin.swift`), so one it does not read is
 * dropped without error. */
export interface PageBarState {
  title: string;
  subtitle?: string;
  /** What tapping the title does, as its accessibility hint; null when it is not a button. */
  titleAction: string | null;
  /** The identity a tappable title wears: a glyph (SVG markup, drawn as a
   * template) or a picture (an image URL, drawn as it is). */
  titleIcon?: { glyph: string } | { image: string };
  /** The page paints its own backdrop under the bar, which shows through
   * in place of the system's edge fade. */
  backdrop?: boolean;
  /** A Tab's root page shows its title large, beside the bar's buttons at
   * the bar's own height. */
  largeTitle?: boolean;
  /** Back's label; null hides it. Back runs the shared navigation. */
  back: string | null;
  /** One glass capsule per group. */
  actions: PageBarItem[][];
  /** The button a horizontal bar gathers the actions behind, all but the
   * primary ones, opening them as a menu; a vertical bar, with room for them,
   * lays them out. */
  overflow?: { label: string; icon: string };
  /** View tabs under the bar; null shows none. */
  tabs: PageBarTab[] | null;
  /** The tab strip's add menu; null shows none. */
  addTabs: { label: string; items: PageBarItem[] } | null;
}
export type PageBarEvent =
  | { kind: "back" }
  | { kind: "title" }
  | { kind: "action"; id: string }
  | { kind: "tab"; id: string }
  | { kind: "closeTab"; id: string }
  | { kind: "moveTab"; id: string; to: number }
  | { kind: "addTab"; id: string };
/** A native navigation bar for the compact page header. The page owns state and behaviour. */
export interface PageBarCapability {
  /** Shows the bar with this state; null removes it. */
  sync(state: PageBarState | null): Promise<void>;
  /** How far an edge swipe has carried the page off screen, from 0 to 1; the
   * bar fades with it. Null ends the swipe, after any bar synced before it. */
  backProgress(progress: number | null): Promise<void>;
  subscribe(handler: (event: PageBarEvent) => void): Promise<() => void>;
}
export interface NavigationCapability {
  badges(input: {
    session: string;
    chat?: boolean;
    activity?: boolean;
    tasks?: boolean;
  }): Promise<void>;
  /** Draws the tab bar for the entry on screen; resolves with the bar's
   * height in the compact layout, which pages showing it scroll clear of. */
  sync(state: NativeNavigationState): Promise<{ tabBarHeight: number }>;
  /** The viewer's avatar for the Me tab, as base64 image bytes; absent clears it. */
  avatar(base64?: string): Promise<void>;
  reset(session: string): Promise<void>;
  subscribe(handler: (intent: NativeNavigationIntent) => void): Promise<() => void>;
}
