import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron';
import type {
  AuthLoginInput,
  AuthSignupInput,
  HostDto,
  RuntimeKind,
  ServerConnectionProfileView,
  ServerInfo,
  TlsErrorCode,
  UserDto,
} from '@silverhand/shared';
import {
  desktopBuildConfig,
  type DesktopBuildConfig,
} from '../build-flags.js';
import type { LocalHostWsAttachment } from '../backend-info-contract.js';

export type { LocalHostWsAttachment };

export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  /** Local comparison between the protocol compiled into this app's bundled
   * daemon and the exact outbound protocol accepted by the connected server. */
  outbound_protocol_compatibility:
    | {
        status:
          | 'compatible'
          | 'app_update_required'
          | 'server_update_required';
        app_protocol_version: number;
        server_protocol_version: number;
      }
    | {
        status: 'unknown';
        app_protocol_version: number;
        server_protocol_version: null;
      };
  local_host_id: string | null;
  local_host_status: 'unclaimed' | 'claimed' | 'revoked' | 'error' | 'failed';
  local_host_ws_attachment: LocalHostWsAttachment;
  local_host_server_url: string | null;
}

export type DesktopAuthState =
  | { status: 'authenticated'; signup_enabled: boolean; user: UserDto }
  | { status: 'unauthenticated'; signup_enabled: boolean }
  | { status: 'backend_unreachable'; server_url: string; message: string }
  | {
      status: 'app_update_required';
      server_api_epoch: number;
      minimum_client_epoch: number;
    }
  | {
      status: 'server_update_required';
      server_api_epoch: number;
      desktop_api_epoch: number;
    };

export type DesktopAuthResult =
  | { ok: true; user: UserDto }
  | { ok: false; status: number; statusText: string; bodyText: string };

export interface BackendProxyRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  responseType?: 'text' | 'arrayBuffer';
}

export interface BackendProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBytes?: Uint8Array;
}

export interface BackendUploadField {
  name: string;
  value: string;
}

export interface BackendUploadFile {
  fieldName: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface BackendUploadRequest {
  path: string;
  fields: BackendUploadField[];
  files: BackendUploadFile[];
}

export interface DesktopHostProxyConfig {
  proxy_url: string | null;
  proxy_runtimes: RuntimeKind[];
}

export type DesktopHostProxyConfigResult =
  | { ok: true; config: DesktopHostProxyConfig }
  | {
      ok: false;
      code:
        | 'not_local_host'
        | 'unauthorized'
        | 'host_not_found'
        | 'host_not_active'
        | 'host_revoked'
        | 'computer_offline'
        | 'daemon_unavailable'
        | 'daemon_error'
        | 'invalid_input';
      message?: string;
    };

export type DesktopHostMutationResult =
  | {
      ok: true;
      host: HostDto;
      local_host_id: BackendInfo['local_host_id'];
      local_host_status: BackendInfo['local_host_status'];
      local_host_ws_attachment: BackendInfo['local_host_ws_attachment'];
      local_host_server_url: BackendInfo['local_host_server_url'];
    }
  | {
      ok: false;
      code:
        | 'unauthorized'
        | 'not_current_host'
        | 'host_not_found'
        | 'host_revoked'
        | 'kind_not_supported'
        | 'invalid_response'
        | 'network_error';
      message?: string;
    };

export type DesktopSaveServerUrlResult =
  | { ok: true; kind: 'reloaded'; elapsedMs: number; attachedAt: number }
  | { ok: true; kind: 'unchanged' }
  | { ok: true; kind: 'connectivity_unverified'; elapsedMs: number }
  | {
      ok: false;
      kind: 'classify_rejected';
      reason:
        | 'malformed_url'
        | 'unsupported_scheme'
        | 'non_origin_url'
        | 'insecure_remote_http_disallowed'
        | 'obfuscated_loopback_disallowed';
      message: string;
    }
  | { ok: false; kind: 'config_write_failed'; message: string }
  | {
      ok: false;
      kind: 'reload_rejected';
      reason:
        | 'not_attached'
        | 'config_unreadable'
        | 'parse_failed'
        | 'invalid_server_url';
      message: string;
    }
  | { ok: false; kind: 'no_attachment_controller'; message: string };

export type DesktopProbeServerInfoResult =
  | {
      ok: true;
      kind: 'system_ca_verified' | 'loopback_ok' | 'insecure_dev_remote';
      info: ServerInfo;
      originUrl: string;
    }
  | {
      ok: false;
      kind: 'classify_rejected';
      reason:
        | 'malformed_url'
        | 'unsupported_scheme'
        | 'non_origin_url'
        | 'insecure_remote_http_disallowed'
        | 'obfuscated_loopback_disallowed';
      message: string;
    }
  | { ok: false; kind: 'tls_failed'; code: TlsErrorCode; message: string }
  | {
      ok: false;
      kind: 'http_failed';
      status: number;
      statusText: string;
      bodyText: string;
    }
  | { ok: false; kind: 'network_failed'; message: string }
  | { ok: false; kind: 'invalid_response'; message: string };

export type DesktopProfileSaveWithTestResult =
  | {
      ok: true;
      test: DesktopProbeServerInfoResult & { ok: true };
      profile: ServerConnectionProfileView;
      phase2: DesktopProfilePhase2Outcome;
    }
  | {
      ok: false;
      phase: 'test';
      test: DesktopProbeServerInfoResult & { ok: false };
    }
  | {
      ok: false;
      phase: 'commit_guard';
      reason: 'remote_backend_not_yet_supported';
      message: string;
      test: DesktopProbeServerInfoResult & { ok: true };
    }
  | {
      ok: false;
      phase: 'write';
      reason: 'write_failed';
      detail?: string;
    };

export type DesktopProfilePhase2Outcome =
  | {
      kind: 'fully_applied';
      profileVersion: number;
      reloadKind: 'reloaded' | 'unchanged' | 'connectivity_unverified';
      elapsedMs: number;
    }
  | {
      kind: 'no_op_no_host_claim';
      profileVersion: number;
    }
  | {
      kind: 'partial_apply_pending';
      profileVersion: number;
      reason:
        | 'config_write_failed'
        | 'reload_rejected'
        | 'no_attachment_controller'
        | 'host_token_missing';
      reloadRejectionReason:
        | 'not_attached'
        | 'config_unreadable'
        | 'parse_failed'
        | 'invalid_server_url'
        | null;
      detail: string;
    };

export type DesktopPartialApplyState =
  | { kind: 'fully_applied' }
  | { kind: 'no_profile' }
  | {
      kind: 'unusable_profile';
      reason: 'parse_failed';
      detail: string;
      lastReadAt: number;
    }
  | {
      kind: 'partial_apply_pending';
      profileVersion: number;
      reason:
        | 'config_write_failed'
        | 'reload_rejected'
        | 'no_attachment_controller'
        | 'host_token_missing';
      reloadRejectionReason:
        | 'not_attached'
        | 'config_unreadable'
        | 'parse_failed'
        | 'invalid_server_url'
        | null;
      detail: string;
      lastAttemptAt: number;
    };

export type DesktopPartialApplyRetryResult =
  | {
      ok: true;
      outcome: DesktopProfilePhase2Outcome;
      state: DesktopPartialApplyState;
    }
  | { ok: false; reason: 'no_profile' }
  | { ok: false; reason: 'profile_unreadable'; detail: string };

export type DesktopClearProfileResult =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: 'unlink_failed'; detail: string };

export type DesktopEventWsDiagnosticKind =
  | 'socket_open'
  | 'socket_close'
  | 'authenticated'
  | 'subscribed'
  | 'message_event'
  | 'live_gap'
  | 'resume_sent'
  | 'snapshot_required'
  | 'orphan_frame'
  | 'markSatisfied_no_floor'
  | 'satisfied_pending_overflow';

export interface DesktopEventWsDiagnostic {
  kind: DesktopEventWsDiagnosticKind;
  scope?: string;
  eventKind?: string;
  seq?: number;
  lastSeq?: number;
  expectedSeq?: number;
  epoch?: string;
  reason?: string;
  code?: number;
  wasClean?: boolean;
}

let previewPinchZoomEnabled = false;

interface PinchWheelEvent {
  readonly ctrlKey: boolean;
  preventDefault(): void;
}

interface PreloadEventTarget {
  addEventListener(
    type: 'wheel',
    listener: (event: PinchWheelEvent) => void,
    options: { capture: true; passive: false },
  ): void;
  removeEventListener(
    type: 'wheel',
    listener: (event: PinchWheelEvent) => void,
    capture: true,
  ): void;
}

const preloadEventTarget = globalThis as unknown as PreloadEventTarget;

const preventPagePinchZoom = (event: PinchWheelEvent): void => {
  if (event.ctrlKey) event.preventDefault();
};

/**
 * Expose trackpad pinch events while a previewer is open, but never let
 * Chromium apply them to the page viewport. The previewer consumes the same
 * cancelable wheel event to update its own content scale.
 */
function setPreviewPinchZoom(enabled: boolean): void {
  if (enabled === previewPinchZoomEnabled) return;
  previewPinchZoomEnabled = enabled;

  if (enabled) {
    preloadEventTarget.addEventListener('wheel', preventPagePinchZoom, {
      capture: true,
      passive: false,
    });
    webFrame.setVisualZoomLevelLimits(1, 3);
    return;
  }

  webFrame.setVisualZoomLevelLimits(1, 1);
  preloadEventTarget.removeEventListener('wheel', preventPagePinchZoom, true);
}

const api = {
  getDesktopBuildConfig: async (): Promise<DesktopBuildConfig> =>
    desktopBuildConfig(),
  getBackendInfo: (): Promise<BackendInfo | null> => ipcRenderer.invoke('backend:info'),
  getAuthState: (): Promise<DesktopAuthState> => ipcRenderer.invoke('auth:getState'),
  signup: (input: AuthSignupInput): Promise<DesktopAuthResult> =>
    ipcRenderer.invoke('auth:signup', input),
  login: (input: AuthLoginInput): Promise<DesktopAuthResult> =>
    ipcRenderer.invoke('auth:login', input),
  logout: (): Promise<{ ok: true }> => ipcRenderer.invoke('auth:logout'),
  backendRequest: (input: BackendProxyRequest): Promise<BackendProxyResponse> =>
    ipcRenderer.invoke('backend:request', input),
  backendUpload: (input: BackendUploadRequest): Promise<BackendProxyResponse> =>
    ipcRenderer.invoke('backend:upload', input),
  recordEventWsDiagnostic: (input: DesktopEventWsDiagnostic): Promise<void> =>
    ipcRenderer.invoke('eventWs:diagnostic', input),
  rotateHostToken: (input: { hostId: string }): Promise<DesktopHostMutationResult> =>
    ipcRenderer.invoke('hosts:rotate', input),
  revokeHost: (input: { hostId: string }): Promise<DesktopHostMutationResult> =>
    ipcRenderer.invoke('hosts:revoke', input),
  getHostProxyConfig: (input: {
    hostId: string;
  }): Promise<DesktopHostProxyConfigResult> =>
    ipcRenderer.invoke('hosts:proxyConfig:get', input),
  saveHostProxyConfig: (input: {
    hostId: string;
    config: DesktopHostProxyConfig;
  }): Promise<DesktopHostProxyConfigResult> =>
    ipcRenderer.invoke('hosts:proxyConfig:set', input),
  saveServerUrl: (input: { serverUrl: string }): Promise<DesktopSaveServerUrlResult> =>
    ipcRenderer.invoke('settings:saveServerUrl', input),
  getServerConnectionProfile: (): Promise<ServerConnectionProfileView | null> =>
    ipcRenderer.invoke('profile:get'),
  saveServerConnectionProfile: (input: {
    serverUrl: string;
  }): Promise<DesktopProfileSaveWithTestResult> =>
    ipcRenderer.invoke('profile:saveWithTest', input),
  clearServerConnectionProfile: (): Promise<DesktopClearProfileResult> =>
    ipcRenderer.invoke('profile:clear'),
  getPartialApplyState: (): Promise<DesktopPartialApplyState> =>
    ipcRenderer.invoke('partialApply:get'),
  retryPartialApply: (): Promise<DesktopPartialApplyRetryResult> =>
    ipcRenderer.invoke('partialApply:retry'),
  pickDirectory: (options?: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickDirectory', options),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  setPinchZoom: setPreviewPinchZoom,
  /** Materialize attachment bytes to ONE stable per-id scratch file and
   *  hand it off to the OS default handler (e.g. open `.html` in the
   *  user's browser). The renderer fetches current bytes through the
   *  main-owned backend proxy on every open, then hands them here with the
   *  attachment id; main overwrites the same path so reopening shows the
   *  latest bytes instead of spawning a new temp file each time. */
  openAttachmentExternal: (input: {
    attachmentId: string;
    filename: string;
    bytes: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('attachment:openExternal', input),
  /** Save attachment bytes to a user-chosen path via the OS save-as
   *  dialog. The renderer stays out of `fs` and `dialog`; main owns
   *  the write. `canceled: true` is the "user dismissed the picker"
   *  case (not an error) so the caller can stay silent. */
  saveAttachment: (input: {
    filename: string;
    bytes: Uint8Array;
  }): Promise<
    | { ok: true; path: string }
    | { ok: false; canceled: true }
    | { ok: false; reason: string }
  > => ipcRenderer.invoke('attachment:save', input),
  /** Subscribe to shutdown progress steps emitted by the main process
   *  just before and during graceful shutdown. Drives the in-app overlay
   *  so the user sees what's happening instead of a frozen window. */
  onShutdownProgress: (handler: (step: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, step: string) => handler(step);
    ipcRenderer.on('shutdown:progress', listener);
    return () => ipcRenderer.off('shutdown:progress', listener);
  },
  onEpochUpdateRequired: (handler: () => void): (() => void) => {
    const listener = (_event: IpcRendererEvent) => handler();
    ipcRenderer.on('epoch:update-required', listener);
    return () => ipcRenderer.off('epoch:update-required', listener);
  },
  /** Fired by the App menu's "Settings…" item (Cmd+,) so the renderer
   *  can navigate to the Settings page. The main process also focuses
   *  the window before emitting, so the handler only needs to navigate. */
  onNavigateSettings: (handler: () => void): (() => void) => {
    const listener = (_event: IpcRendererEvent) => handler();
    ipcRenderer.on('navigate:settings', listener);
    return () => ipcRenderer.off('navigate:settings', listener);
  },
  /** ⌘W contextual close. Main is the single interception owner
   *  (a menu accelerator fires before any renderer keydown), so it sends a
   *  per-keypress request; the renderer resolves its close ladder and answers
   *  via `respondContextualClose` with the SAME `reqId`. Positional args match
   *  the house style (`onNotificationClicked` etc.) and the main handler in
   *  `main/index.ts`. Named "contextual close", not "close window", because the
   *  command does NOT always background the app (`closed-panel` peels a panel
   *  instead). */
  onContextualClose: (handler: (reqId: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, reqId: string) => handler(reqId);
    ipcRenderer.on('shortcut:contextual-close', listener);
    return () => ipcRenderer.off('shortcut:contextual-close', listener);
  },
  respondContextualClose: (
    reqId: string,
    outcome: 'closed-panel' | 'background-app',
  ): void => {
    ipcRenderer.send('shortcut:contextual-close-result', reqId, outcome);
  },
  showSystemNotification: (opts: {
    title: string;
    body: string;
    force?: boolean;
    /** Opaque id echoed back via `onNotificationClicked` so the renderer
     *  can route the click to the right navigation target. Fire-and-
     *  forget if omitted (the notification is just informational). */
    notificationId?: string;
  }): Promise<void> =>
    ipcRenderer.invoke('notification:show', opts),
  /** Subscribe to native-notification click events. Main fires this
   *  when the user clicks an OS-level Silverhand notification, after
   *  focusing the window. The id matches what the renderer originally
   *  passed to `showSystemNotification`. */
  onNotificationClicked: (handler: (notificationId: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, notificationId: string) => {
      handler(notificationId);
    };
    ipcRenderer.on('notification:clicked', listener);
    return () => ipcRenderer.off('notification:clicked', listener);
  },
  /** Dismiss OS-level notifications by the ids originally passed to
   *  `showSystemNotification`. Fired when the backend reports those
   *  notifications were read (viewer-scoped `unread_updated`), so the
   *  system notification center clears in step with in-app read state.
   *  Unknown / already-closed ids are ignored by main. */
  dismissSystemNotifications: (notificationIds: string[]): Promise<void> =>
    ipcRenderer.invoke('notification:dismiss', notificationIds),
  setBadgeCount: (count: number): Promise<void> =>
    ipcRenderer.invoke('badge:setCount', count),
  /** Save a PNG snapshot to disk via the native save dialog. The
   *  renderer hands over raw bytes; main owns the dialog + writeFile.
   *  See `export:savePng` in main. */
  savePngExport: (input: {
    pngBytes: Uint8Array;
    suggestedName: string;
  }): Promise<
    | { ok: true; path: string }
    | { ok: false; canceled: true }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('export:savePng', input),
  /** Copy PNG snapshot bytes to the OS clipboard. Main constructs a
   *  NativeImage so Electron handles pasteboard format negotiation —
   *  renderer-side `ClipboardItem` for images is brittle on macOS. */
  copyPngExport: (input: {
    pngBytes: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('export:copyPng', input),
};

contextBridge.exposeInMainWorld('silverhand', api);
