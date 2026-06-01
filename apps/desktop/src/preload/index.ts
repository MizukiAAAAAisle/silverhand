import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AuthLoginInput,
  AuthSignupInput,
  HostDto,
  ServerConnectionProfileView,
  ServerInfo,
  TlsErrorCode,
  UserDto,
} from '@silverhand/shared';

export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  local_host_id: string | null;
  local_host_status: 'unclaimed' | 'claimed' | 'revoked' | 'error' | 'failed';
  /**
   * D3.a Commit 4 — diagnostic timestamp from
   * `HostWsServerController.getAttachment(local_host_id)?.attachedAt`.
   * `null` when no live outbound WS attachment for this host.
   * Renderer can surface as "connected since" but must NOT derive a
   * new status word — the user-facing status enum stays
   * `local_host_status` and nothing else.
   *
   * D3.b Commit 2 — `'failed'` value added: surfaced when the daemon
   * supervisor budget is exhausted (see `local-host-failure.ts`).
   * `local_host_ws_attached_at` stays a separate diagnostic field;
   * renderer must not derive status from it.
   */
  local_host_ws_attached_at: number | null;
  /**
   * D3.c Commit 4 — `server_url` currently persisted in
   * `daemon-config.json` (the address the daemon dials to reach the
   * backend). DISTINCT from `url` above, which is the URL of the
   * desktop's embedded backend listener. In V1 they're typically the
   * same loopback address, but Settings' "save server URL" path edits
   * THIS value; the post-save invalidation refetches `BackendInfo`
   * and the Settings pane re-seeds from this field, so the structural
   * twin in `api.d.ts` MUST stay in sync.
   *
   * `null` when no daemon-config exists yet (pre-claim).
   */
  local_host_server_url: string | null;
}

export interface ActiveConversationInfo {
  workspaceId: string | null;
  conversationId: string | null;
}

export type DesktopAuthState =
  | { status: 'authenticated'; signup_enabled: boolean; user: UserDto }
  | { status: 'unauthenticated'; signup_enabled: boolean }
  // D4.a Commit 5d-fixup (Cindy P1-2): when the active backend is
  // unreachable (remote profile, server down / DNS fail / TLS fail
  // / etc.), `desktopAuthState()` returns this typed arm instead of
  // letting the underlying `fetchServerInfo()` rejection propagate
  // through IPC. Carries `serverUrl` so the renderer can show
  // "can't reach <url>". **Intentionally does NOT carry
  // `signup_enabled`** — when the server is unreachable we DO NOT
  // know whether signup is open, and defaulting to true/false would
  // leak a guess into the gate UI. Renderer must treat it as
  // unknown and avoid rendering signup CTAs until the next
  // re-fetch.
  | { status: 'backend_unreachable'; server_url: string; message: string };

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

/** Stage B.4 — return shape exposed to the renderer for both
 *  `rotateHostToken` and `revokeHost`. Token bytes are deliberately
 *  absent: the main IPC consumes them on-the-spot (writing
 *  `daemon-config.json` on rotate, dropping it on revoke) and only
 *  echoes the updated host metadata + the post-mutation local-claim
 *  fields (mirroring `BackendInfo`'s `local_host_id` / `local_host_status`
 *  so the renderer can refresh without a follow-up `getBackendInfo`). */
export type DesktopHostMutationResult =
  | {
      ok: true;
      host: HostDto;
      local_host_id: BackendInfo['local_host_id'];
      local_host_status: BackendInfo['local_host_status'];
      local_host_ws_attached_at: BackendInfo['local_host_ws_attached_at'];
      /** D3.c Commit 4 — same field as `BackendInfo.local_host_server_url`.
       *  Mutation success payloads are built via
       *  `...snapshotLocalHostInfo()`, so this field is structurally
       *  guaranteed to be present alongside the other `local_host_*`
       *  fields and must be reflected in the typed surface. */
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

/** D3.c Commit 3 — Settings "save server URL" result. See
 *  `api.d.ts` for the per-arm semantics; structural twin of
 *  `OutboundReloadOutcome` in `main/outbound-reload.ts` so the
 *  IPC boundary stays typed end-to-end. Token bytes deliberately
 *  absent — main pulls `host_token` from `daemon-config.json`,
 *  renderer only supplies `serverUrl`. */
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
        // D4.a Commit 2 fixup — see shared `server-url.ts`.
        | 'non_origin_url'
        // D4.a Commit 1 — replaces D3's `non_loopback_host`. See
        // `api.d.ts` for the user-facing rationale.
        | 'insecure_remote_http_disallowed'
        // D4.a Commit 1 review — disguised loopback rejection.
        // See `api.d.ts` for rationale.
        | 'obfuscated_loopback_disallowed';
      message: string;
    }
  | {
      // D4.a Commit 1 — see `api.d.ts` for rationale. Removed when
      // Commit 5 lands remote daemon acceptance.
      ok: false;
      kind: 'remote_backend_not_yet_supported';
      insecure: boolean;
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

/** D4.a Commit 2 — server connection profile probe + save outcome
 *  types. Structural mirror of `api.d.ts`; see the JSDoc there for
 *  the per-arm semantics. Kept here so `contextBridge.exposeInMainWorld`
 *  can be typed against the same shape the renderer consumes. */
export type DesktopProbeServerInfoResult =
  | {
      ok: true;
      kind: 'system_ca_verified' | 'loopback_ok' | 'insecure_dev_remote';
      info: ServerInfo;
      // D4.a Commit 5 — canonical origin string. See `api.d.ts` for
      // the contract; written into the persisted profile in main.
      originUrl: string;
    }
  | {
      ok: false;
      kind: 'classify_rejected';
      reason:
        | 'malformed_url'
        | 'unsupported_scheme'
        // D4.a Commit 2 fixup — origin-only invariant.
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
      /** D4.a Commit 5c-2 — phase-2 outcome. See `api.d.ts`. */
      phase2: DesktopProfilePhase2Outcome;
    }
  | {
      ok: false;
      phase: 'test';
      test: DesktopProbeServerInfoResult & { ok: false };
    }
  | {
      // D4.a Commit 3 review fixup (Cindy P1-A) — probe succeeded
      // but the main-side commit guard refused the URL because
      // remote-mode bootstrap is not yet wired (Commit 5 lifts this).
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

/** D4.a Commit 5c-2 — phase-2 outcome. Structural twin of
 *  `ProfilePhase2Outcome` in `main/profile-phase2.ts`. See
 *  `api.d.ts` for per-arm semantics. */
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
        // D4.a Commit 5c-2 fixup (Cindy P1) — claimed host with no
        // daemon-config token. See `api.d.ts` for rationale.
        | 'host_token_missing';
      reloadRejectionReason:
        | 'not_attached'
        | 'config_unreadable'
        | 'parse_failed'
        | 'invalid_server_url'
        | null;
      detail: string;
    };

/** D4.a Commit 5c-3 — in-memory partial-apply state. Mirrors
 *  `PartialApplyState` in `main/profile-phase2.ts`. Four arms:
 *  `fully_applied` / `no_profile` / `unusable_profile` /
 *  `partial_apply_pending`. See `api.d.ts` for per-arm semantics. */
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

/** D4.a Commit 5c-2 — `partialApply:retry` outcome. */
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

const api = {
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
  /** Stage B.4 host management. Both calls are routed through
   *  dedicated main IPCs (NOT the generic backend proxy) because:
   *  rotate's HTTP response carries a cleartext `host_token` that
   *  belongs in `daemon-config.json` and must never reach the
   *  renderer; revoke has a local-config side-effect that only main
   *  performs. The renderer return shapes never include token bytes
   *  — main strips them before replying. See
   *  {@link DesktopHostMutationResult}. */
  rotateHostToken: (input: { hostId: string }): Promise<DesktopHostMutationResult> =>
    ipcRenderer.invoke('hosts:rotate', input),
  revokeHost: (input: { hostId: string }): Promise<DesktopHostMutationResult> =>
    ipcRenderer.invoke('hosts:revoke', input),
  /** D3.c Commit 3 — Settings "save server URL". Main owns the
   *  full pipeline: classify raw input → atomic write
   *  `daemon-config.json` → `host_outbound_reload` IPC to daemon →
   *  fresh-attach watchdog. Renderer NEVER sees `host_token`. The
   *  result discriminator carries progressively weaker connectivity
   *  claims on the success arm — see `DesktopSaveServerUrlResult`. */
  saveServerUrl: (input: { serverUrl: string }): Promise<DesktopSaveServerUrlResult> =>
    ipcRenderer.invoke('settings:saveServerUrl', input),
  /** D4.a Commit 2 — read the persisted server connection profile or
   *  null. Renderer-safe redacted view; raw profile contents never cross. */
  getServerConnectionProfile: (): Promise<ServerConnectionProfileView | null> =>
    ipcRenderer.invoke('profile:get'),
  /** D4.a Commit 2 — Setup Wizard / Settings full save pipeline. Test
   *  connect runs first; on success the profile commits and the
   *  redacted view comes back. On failure the `phase` discriminator
   *  tells the renderer where to render the error copy. */
  saveServerConnectionProfile: (input: {
    serverUrl: string;
  }): Promise<DesktopProfileSaveWithTestResult> =>
    ipcRenderer.invoke('profile:saveWithTest', input),
  /** D4.a Commit 2 — explicit reset of the persisted profile. */
  clearServerConnectionProfile: (): Promise<DesktopClearProfileResult> =>
    ipcRenderer.invoke('profile:clear'),
  /** D4.a Commit 5c-2 — read in-memory partial-apply state. The
   *  renderer renders a banner + Retry button when
   *  `kind === 'partial_apply_pending'`. */
  getPartialApplyState: (): Promise<DesktopPartialApplyState> =>
    ipcRenderer.invoke('partialApply:get'),
  /** D4.a Commit 5c-2 — re-run phase-2 against the on-disk profile.
   *  Profile read failures surface as a typed `profile_unreadable`
   *  outcome that does NOT mutate state — 5c-3 owns full repair. */
  retryPartialApply: (): Promise<DesktopPartialApplyRetryResult> =>
    ipcRenderer.invoke('partialApply:retry'),
  pickDirectory: (options?: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickDirectory', options),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  /** Save attachment bytes to a per-app temp dir and hand the file off
   *  to the OS default handler (e.g. open `.html` in the user's
   *  browser). The renderer fetches the bytes through the main-owned
   *  backend proxy, then hands them here for the OS boundary. */
  openAttachmentExternal: (input: {
    filename: string;
    bytes: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('attachment:openExternal', input),
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', path),
  setWindowAlwaysOnTop: (pinned: boolean): Promise<void> =>
    ipcRenderer.invoke('window:setAlwaysOnTop', pinned),
  setActiveConversation: (active: ActiveConversationInfo): Promise<void> =>
    ipcRenderer.invoke('active-conversation:set', active),
  onActiveConversation: (handler: (active: ActiveConversationInfo) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, active: ActiveConversationInfo) => {
      handler(active);
    };
    ipcRenderer.on('active-conversation:update', listener);
    return () => ipcRenderer.off('active-conversation:update', listener);
  },
  /** Subscribe to shutdown progress steps emitted by the main process
   *  just before and during graceful shutdown. Drives the in-app overlay
   *  so the user sees what's happening instead of a frozen window. */
  onShutdownProgress: (handler: (step: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, step: string) => handler(step);
    ipcRenderer.on('shutdown:progress', listener);
    return () => ipcRenderer.off('shutdown:progress', listener);
  },
  /** Fired by the App menu's "Settings…" item (Cmd+,) so the renderer
   *  can navigate to the Settings page. The main process also focuses
   *  the window before emitting, so the handler only needs to navigate. */
  onNavigateSettings: (handler: () => void): (() => void) => {
    const listener = (_event: IpcRendererEvent) => handler();
    ipcRenderer.on('navigate:settings', listener);
    return () => ipcRenderer.off('navigate:settings', listener);
  },
  /** D4.a Commit 2 — fired by the App menu's "Connect to backend…"
   *  item. Renderer mounts the Setup Wizard modal in response. */
  onNavigateSetupWizard: (handler: () => void): (() => void) => {
    const listener = (_event: IpcRendererEvent) => handler();
    ipcRenderer.on('navigate:setupWizard', listener);
    return () => ipcRenderer.off('navigate:setupWizard', listener);
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

contextBridge.exposeInMainWorld('agentHub', api);
