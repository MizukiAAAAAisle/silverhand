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
   * D3.a Commit 4 — diagnostic timestamp of the daemon outbound WS
   * attachment for `local_host_id`, as reported by the backend's
   * `HostWsServerController.getAttachment`. `null` when no
   * attachment is live (pre-attach, post-revoke, daemon down).
   *
   * Renderer may surface this as "connected since" UI. It MUST NOT
   * be used to derive a new status word — the user-facing status
   * enum stays the 5-value `local_host_status` and nothing else.
   *
   * D3.b Commit 2 — `'failed'` value added: surfaced when the daemon
   * supervisor budget is exhausted. Single source of truth is the
   * `daemon.onExit` callback in `main/index.ts`; no other path may
   * flip into `failed`.
   */
  local_host_ws_attached_at: number | null;
  /**
   * D3.c Commit 4 — `server_url` currently persisted in
   * `daemon-config.json` (i.e. the address the daemon dials to
   * reach the backend). DISTINCT from `url` above, which is the
   * URL of the desktop's embedded backend; in V1 they happen to be
   * the same loopback address in the common case, but Settings'
   * "save server URL" path edits THIS value, not the embedded
   * backend URL.
   *
   * `null` when no daemon-config exists yet (pre-claim state). The
   * Settings pane falls back to `url` for display when this is null
   * so the user has a sensible hint at what would be used after
   * claim; the Save button still requires a real claim before it
   * can succeed (main's `saveServerUrlFromSettings` short-circuits
   * with `reload_rejected/not_attached` in unclaimed state).
   */
  local_host_server_url: string | null;
}

export interface ActiveConversationInfo {
  workspaceId: string | null;
  conversationId: string | null;
}

export type DesktopAuthState =
  | { status: 'authenticated'; signup_enabled: boolean; user: UserDto }
  | { status: 'unauthenticated'; signup_enabled: boolean };

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

/** Stage B.4 — see `apps/desktop/src/preload/index.ts` for the
 *  invariants. Token bytes never appear in this shape. */
export type DesktopHostMutationResult =
  | {
      ok: true;
      host: HostDto;
      local_host_id: BackendInfo['local_host_id'];
      local_host_status: BackendInfo['local_host_status'];
      local_host_ws_attached_at: BackendInfo['local_host_ws_attached_at'];
      /** D3.c Commit 4 — see `preload/index.ts` for the rationale.
       *  Built from `...snapshotLocalHostInfo()` so the typed surface
       *  must include it; renderer post-mutation refresh keys off this
       *  same field via `useBackendInfoSnapshot`. */
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

/**
 * D3.c Commit 3 — Settings "save server URL" outcome surfaced to
 * the renderer. Structural mirror of `OutboundReloadOutcome` in
 * `apps/desktop/src/main/outbound-reload.ts` — the orchestrator
 * already strips token bytes by construction (it reads
 * `daemon-config.json` server-side and only echoes back metadata),
 * so the renderer-facing shape is just a re-declaration here for
 * preload/IPC boundary purposes. Main's orchestrator type and
 * this type are kept in sync by hand (small surface; alternative
 * would be to hoist the type to `@silverhand/shared` which is
 * overkill for a renderer-only consumer).
 *
 * Success arms convey progressively weaker connectivity claims:
 *   - `reloaded`              — daemon swapped + fresh attachment observed
 *   - `unchanged`             — fingerprint match, no swap, no reconnect needed
 *   - `connectivity_unverified` — daemon swapped, watchdog budget exceeded
 *
 * Renderer rule (Cindy #task:634 note 1): `connectivity_unverified`
 * MUST NOT be rendered as "Connected". Copy keys off the discriminator
 * directly so the UI can't accidentally collapse the two success arms.
 */
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
        // D4.a Commit 2 fixup — server connection profile is
        // origin-only. See `packages/shared/src/server-url.ts`.
        | 'non_origin_url'
        // D4.a Commit 1 — replaces D3's `non_loopback_host`. Surfaced
        // when the user types a non-loopback http URL without the dev
        // env flag (`SILVERHAND_ALLOW_INSECURE_REMOTE=1`). The
        // user-facing message points at the two valid escape routes
        // (use https, or set the flag).
        | 'insecure_remote_http_disallowed'
        // D4.a Commit 1 review (Cindy 2026-05-28) — disguised
        // loopback form (`http://0x7f000001`, `http://127.000.000.001`,
        // `http://[0:0:0:0:0:0:0:1]`, etc.) where the raw authority
        // is not a literal loopback allowlist entry but the URL
        // parser would resolve it to one. Rejected outright
        // regardless of scheme or dev flag — keeps the visible URL
        // form aligned with the host the daemon would actually
        // connect to.
        | 'obfuscated_loopback_disallowed';
      message: string;
    }
  | {
      // D4.a Commit 1 — classifier admits non-loopback https (and
      // non-loopback http with the dev flag) as `kind: 'remote'`, but
      // the Settings → save pipeline is still loopback-only in this
      // build (daemon outbound-WS still rejects remote in
      // `outbound-client.ts` until Commit 5 / G2). Surface a typed
      // "not yet supported" outcome so the renderer can render an
      // honest banner instead of treating the URL as accepted.
      ok: false;
      kind: 'remote_backend_not_yet_supported';
      /** Honest insecure flag from the classifier: true when the
       *  input was http+dev-flag, false when the input was https. */
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

/**
 * D4.a Commit 2 — Setup Wizard / Settings server-connection-profile
 * IPC result types.
 *
 * Structural mirror of:
 *   - `ProbeServerInfoResult` in `main/server-connection-test.ts`
 *   - `ProfileSaveWithTestResult` in `main/index.ts`
 *
 * Kept here (not in `@silverhand/shared`) because they are
 * renderer-only consumers — the daemon and backend never see these
 * shapes. The mirror is tiny enough that hand-sync is cheaper than
 * hoisting to shared. If this surface grows beyond Commit 2 (e.g.
 * Commit 5 adds the phase-2 daemon-config bridge) the types should
 * move to shared at that point.
 */
export type DesktopProbeServerInfoResult =
  | {
      ok: true;
      kind: 'system_ca_verified' | 'loopback_ok' | 'insecure_dev_remote';
      info: ServerInfo;
    }
  | {
      ok: false;
      kind: 'classify_rejected';
      // The discriminator strings mirror `ServerUrlRejectionReason`
      // in `@silverhand/shared`. Kept inline so the preload doesn't
      // depend on a separate type re-export.
      reason:
        | 'malformed_url'
        | 'unsupported_scheme'
        // D4.a Commit 2 fixup — origin-only invariant. See shared
        // `server-url.ts` for the contract rationale.
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
      reason: 'storage_unavailable' | 'write_failed';
      detail?: string;
    };

/**
 * D4.a Commit 2 — `profile:clear` result. Idempotent; reports whether
 * a file was actually removed.
 */
export type DesktopClearProfileResult =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: 'unlink_failed'; detail: string };

declare global {
  interface Window {
    agentHub: {
      getBackendInfo(): Promise<BackendInfo | null>;
      getAuthState(): Promise<DesktopAuthState>;
      signup(input: AuthSignupInput): Promise<DesktopAuthResult>;
      login(input: AuthLoginInput): Promise<DesktopAuthResult>;
      logout(): Promise<{ ok: true }>;
      backendRequest(input: BackendProxyRequest): Promise<BackendProxyResponse>;
      backendUpload(input: BackendUploadRequest): Promise<BackendProxyResponse>;
      rotateHostToken(input: { hostId: string }): Promise<DesktopHostMutationResult>;
      revokeHost(input: { hostId: string }): Promise<DesktopHostMutationResult>;
      /**
       * D3.c Commit 3 — Settings "save server URL" entry point. The
       * renderer hands a raw URL string; main classifies, atomically
       * rewrites `daemon-config.json`, calls `host_outbound_reload`,
       * and (on `action: 'reloaded'`) awaits a fresh attachment via
       * the same predicate the post-login attach uses. Token bytes
       * NEVER flow through this IPC — main pulls the current
       * `host_token` from `daemon-config.json` itself.
       */
      saveServerUrl(input: { serverUrl: string }): Promise<DesktopSaveServerUrlResult>;
      /**
       * D4.a Commit 2 — read the persisted server connection profile,
       * if any. Returns the renderer-safe redacted view (just
       * `server_url + updated_at`); encrypted bytes never cross IPC.
       * Null when no profile is persisted (pre-Wizard state) or when
       * the on-disk blob failed to decrypt — the renderer should
       * surface a "reset profile" affordance in the failure case
       * (and the storage layer logs the diagnostic so an operator
       * can correlate).
       */
      getServerConnectionProfile(): Promise<ServerConnectionProfileView | null>;
      /**
       * D4.a Commit 2 — Setup Wizard / Settings save pipeline. Runs
       * `classifyServerUrl` → test connect against
       * `GET /api/server/info` → commit to disk. Returns a typed
       * outcome with `phase` discriminator when it fails so the
       * renderer can render the right copy ("URL invalid" vs
       * "TLS cert expired" vs "couldn't write profile"). Token bytes
       * are never involved — the profile is pre-auth.
       */
      saveServerConnectionProfile(input: {
        serverUrl: string;
      }): Promise<DesktopProfileSaveWithTestResult>;
      /**
       * D4.a Commit 2 — explicit reset / disconnect affordance.
       * Idempotent — reports whether it actually removed a file. Used
       * for both the "disconnect from remote backend" UX and recovery
       * from a wedged on-disk blob.
       */
      clearServerConnectionProfile(): Promise<DesktopClearProfileResult>;
      pickDirectory(options?: { defaultPath?: string }): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      openAttachmentExternal(input: {
        filename: string;
        bytes: Uint8Array;
      }): Promise<{ ok: true } | { ok: false; reason: string }>;
      showItemInFolder(path: string): Promise<void>;
      setWindowAlwaysOnTop(pinned: boolean): Promise<void>;
      setActiveConversation(active: ActiveConversationInfo): Promise<void>;
      onActiveConversation(handler: (active: ActiveConversationInfo) => void): () => void;
      showSystemNotification(opts: {
        title: string;
        body: string;
        force?: boolean;
        notificationId?: string;
      }): Promise<void>;
      onNotificationClicked(handler: (notificationId: string) => void): () => void;
      setBadgeCount(count: number): Promise<void>;
      onShutdownProgress(handler: (step: string) => void): () => void;
      onNavigateSettings(handler: () => void): () => void;
      /**
       * D4.a Commit 2 — fired by the App menu's "Connect to backend…"
       * item so the renderer can mount the Setup Wizard modal/route.
       * Main focuses the window before emitting; the handler only
       * needs to open the Wizard UI.
       */
      onNavigateSetupWizard(handler: () => void): () => void;
      savePngExport(input: {
        pngBytes: Uint8Array;
        suggestedName: string;
      }): Promise<
        | { ok: true; path: string }
        | { ok: false; canceled: true }
        | { ok: false; error: string }
      >;
      copyPngExport(input: {
        pngBytes: Uint8Array;
      }): Promise<{ ok: true } | { ok: false; error: string }>;
    };
  }
}

export {};
