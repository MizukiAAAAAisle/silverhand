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

/** Installed once by an application entry point, before mounting the UI. */
export interface ClientPlatform {
  client: ClientAdapter;
  files: FileCapability;
  localHost?: LocalHostCapability;
  shell?: ShellCapability;
  notifications?: NotificationCapability;
  navigation?: NavigationCapability;
}

/** Optional native presentation. Navigation history remains owned by the shared UI. */
export interface NativeNavigationState {
  blocked: boolean;
  modalVersion: number;
  session: string;
  key: string;
  tab: "chat" | "activity" | "tasks" | "more";
  visible: boolean;
  backKey?: string;
  backVisible: boolean;
}
export interface NativeNavigationIntent {
  modalVersion: number;
  session: string;
  kind: "tab" | "more" | "back";
  key?: string;
  target?: string;
  request?: string;
}
export interface NavigationCapability {
  badges(input: {
    session: string;
    chat?: boolean;
    activity?: boolean;
    tasks?: boolean;
  }): Promise<void>;
  sync(state: NativeNavigationState): Promise<{ bottomInset: number }>;
  capture(input: { session: string; key: string }): Promise<void>;
  finish(input: { session: string; request: string; accepted: boolean }): Promise<void>;
  reset(session: string): Promise<void>;
  subscribe(handler: (intent: NativeNavigationIntent) => void): Promise<() => void>;
}
