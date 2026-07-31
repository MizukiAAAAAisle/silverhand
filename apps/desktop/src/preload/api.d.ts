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
import type { LocalHostWsAttachment } from '../backend-info-contract.js';

/**
 * #task:1630 — the daemon's outbound-WS attachment as seen from THIS
 * desktop process, made explicit about whether it can be seen at all.
 *
 * Declared once in `src/backend-info-contract.ts` (the rationale and the
 * three shipped regressions are documented there) and re-exported here
 * because the renderer's whole view of the preload surface is this file.
 * It used to be a third hand-copy kept "in lock-step" by comment — for a
 * discriminant whose entire purpose is to forbid a read, a dropped arm
 * would compile and run (Cindy's review of `e82f8a23`).
 */
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
  /**
   * D3.a Commit 4 — the daemon outbound WS attachment for
   * `local_host_id`, as reported by the backend's
   * `HostWsServerController.getAttachment`. See
   * {@link LocalHostWsAttachment}: `{ observable: false }` on the remote
   * arm (the registry is in the remote backend process, not here);
   * `{ observable: true, attached_at: null }` when this process CAN see
   * the registry and no attachment is live (pre-attach, post-revoke,
   * daemon down).
   *
   * Renderer may surface `attached_at` as "connected since" UI. It MUST
   * NOT be used to derive a new status word — the user-facing status
   * enum stays the 5-value `local_host_status` and nothing else.
   *
   * D3.b Commit 2 — `'failed'` value added: surfaced when the daemon
   * supervisor budget is exhausted. Single source of truth is the
   * `daemon.onExit` callback in `main/index.ts`; no other path may
   * flip into `failed`.
   */
  local_host_ws_attachment: LocalHostWsAttachment;
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

export type DesktopAuthState =
  | { status: 'authenticated'; signup_enabled: boolean; user: UserDto }
  | { status: 'unauthenticated'; signup_enabled: boolean }
  // D4.a Commit 5d-fixup (Cindy P1-2): typed backend-unreachable arm.
  // No `signup_enabled` — unknown when the server is unreachable.
  | { status: 'backend_unreachable'; server_url: string; message: string }
  // #task:1761 — desktop↔server API epoch hard gate arms; see main/index.ts.
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

/** Stage B.4 — see `apps/desktop/src/preload/index.ts` for the
 *  invariants. Token bytes never appear in this shape. */
export type DesktopHostMutationResult =
  | {
      ok: true;
      host: HostDto;
      local_host_id: BackendInfo['local_host_id'];
      local_host_status: BackendInfo['local_host_status'];
      local_host_ws_attachment: BackendInfo['local_host_ws_attachment'];
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
 *   - `reloaded_remote`       — remote backend: daemon swapped, but the
 *                               in-process attachment registry is absent
 *                               (#task:1021); connectivity is shown live
 *                               by the connection indicator (host-status
 *                               `availability`, #task:1010), not verified here
 *
 * Renderer rule (Cindy #task:634 note 1): `connectivity_unverified`
 * MUST NOT be rendered as "Connected". Copy keys off the discriminator
 * directly so the UI can't accidentally collapse the two success arms.
 */
export type DesktopSaveServerUrlResult =
  | { ok: true; kind: 'reloaded'; elapsedMs: number; attachedAt: number }
  | { ok: true; kind: 'unchanged' }
  | { ok: true; kind: 'connectivity_unverified'; elapsedMs: number }
  | { ok: true; kind: 'reloaded_remote' }
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
      /**
       * D4.a Commit 5 — canonical origin form of the URL the user
       * typed. Source: `new URL(serverUrl).origin` after the §7.1
       * origin-only classifier admitted the input. Renderer surfaces
       * may show this back to the user (so they see what was actually
       * persisted), but the actual write happens in main —
       * the renderer does NOT pass this back through `profile:saveWithTest`.
       */
      originUrl: string;
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
      /**
       * D4.a Commit 5c-2 — phase-2 outcome from `performProfilePhase2`
       * after the profile commit. Renderer keys copy off `kind`:
       *   - `fully_applied` — daemon's running config is at
       *     `profileVersion`; sub-arms `reloaded` / `unchanged` /
       *     `connectivity_unverified` differentiate the IPC action
       *     and post-IPC connectivity observation. All three mean
       *     "config + daemon in sync at this generation".
       *   - `no_op_no_host_claim` — Setup Wizard pre-auth path. The
       *     next sign-in stamps `profile_version` into daemon-config
       *     naturally; no Retry needed.
       *   - `partial_apply_pending` — phase-2 failed at write / IPC
       *     ack. Profile committed; daemon on old config. Renderer
       *     surfaces a banner + Retry button via `partialApply:get`
       *     / `partialApply:retry`.
       */
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

/**
 * D4.a Commit 5c-2 — phase-2 outcome surfaced to the renderer.
 * Structural mirror of `ProfilePhase2Outcome` in
 * `main/profile-phase2.ts`. See `phase2` field on
 * {@link DesktopProfileSaveWithTestResult} for usage.
 *
 * `reloadRejectionReason` is the daemon's typed reason — passed
 * through verbatim so the renderer can branch on the exact same set
 * the daemon defines.
 */
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
        // D4.a Commit 5c-2 fixup (Cindy P1) — claimed host but no
        // token in daemon-config (missing / corrupt). Distinct from
        // `no_op_no_host_claim` (genuine pre-auth) because the
        // profile commit upstream landed and the daemon is now on
        // the previous-generation config.
        | 'host_token_missing';
      reloadRejectionReason:
        | 'not_attached'
        | 'config_unreadable'
        | 'parse_failed'
        | 'invalid_server_url'
        | null;
      detail: string;
    };

/**
 * D4.a Commit 5c-3 — in-memory partial-apply state mirror. Renderer
 * reads via `partialApply:get` and renders a banner + Retry button
 * when `kind === 'partial_apply_pending'`, a "reset profile"
 * affordance when `kind === 'unusable_profile'`, and no banner
 * for `fully_applied` / `no_profile`.
 *
 * NOT serialized to disk in main (the source of truth is
 * `profile.version` vs `daemon-config.profile_version`); 5c-3 boot
 * reconciliation re-derives this on launch. NOT crossed into the
 * wire / daemon protocol per §7.6 (R4 boundary — local desktop UX
 * concept, not a backend-observable fact).
 */
export type DesktopPartialApplyState =
  | { kind: 'fully_applied' }
  | { kind: 'no_profile' }
  | {
      kind: 'unusable_profile';
      // D4.a Commit 5c-3 (Cindy 5c-1 review note) — profile file
      // exists but the storage layer could not return it. Distinct
      // from `no_profile` (file absent) — renderer surfaces "reset
      // profile" affordance, not "configure backend".
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

/**
 * D4.a Commit 5c-2 — `partialApply:retry` outcome. See
 * `handlePartialApplyRetry` in `main/index.ts` for the per-arm
 * semantics. `profile_unreadable` is the typed repair-state stub —
 * 5c-3 boot reconciliation owns full repair; for 5c-2 the renderer
 * surfaces the failure with a "reset profile" affordance keyed off
 * the existing `profile:clear` IPC.
 */
export type DesktopPartialApplyRetryResult =
  | {
      ok: true;
      outcome: DesktopProfilePhase2Outcome;
      state: DesktopPartialApplyState;
    }
  | { ok: false; reason: 'no_profile' }
  | { ok: false; reason: 'profile_unreadable'; detail: string };

/**
 * D4.a Commit 2 — `profile:clear` result. Idempotent; reports whether
 * a file was actually removed.
 */
export type DesktopClearProfileResult =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: 'unlink_failed'; detail: string };

export interface DesktopBuildConfig {
  remote_only: boolean;
  allow_insecure_remote: boolean;
  default_server_url: string;
}

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

declare global {
  interface Window {
    silverhand: {
      getDesktopBuildConfig(): Promise<DesktopBuildConfig>;
      getBackendInfo(): Promise<BackendInfo | null>;
      getAuthState(): Promise<DesktopAuthState>;
      signup(input: AuthSignupInput): Promise<DesktopAuthResult>;
      login(input: AuthLoginInput): Promise<DesktopAuthResult>;
      logout(): Promise<{ ok: true }>;
      backendRequest(input: BackendProxyRequest): Promise<BackendProxyResponse>;
      backendUpload(input: BackendUploadRequest): Promise<BackendProxyResponse>;
      recordEventWsDiagnostic(input: DesktopEventWsDiagnostic): Promise<void>;
      /** Toggle trackpad pinch-to-zoom for this frame (see preload impl). */
      setPinchZoom(enabled: boolean): void;
      rotateHostToken(input: { hostId: string }): Promise<DesktopHostMutationResult>;
      revokeHost(input: { hostId: string }): Promise<DesktopHostMutationResult>;
      getHostProxyConfig(input: {
        hostId: string;
      }): Promise<DesktopHostProxyConfigResult>;
      saveHostProxyConfig(input: {
        hostId: string;
        config: DesktopHostProxyConfig;
      }): Promise<DesktopHostProxyConfigResult>;
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
       * `server_url + updated_at`); raw profile contents never cross IPC.
       * Null when no profile is persisted (pre-Wizard state) or when
       * the on-disk profile failed to parse — the renderer should
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
       * from a wedged on-disk profile.
       */
      clearServerConnectionProfile(): Promise<DesktopClearProfileResult>;
      /**
       * D4.a Commit 5c-2 — read the in-memory partial-apply state.
       * Renderer reads on Settings-pane mount + after every relevant
       * mutation to decide whether to render the banner + Retry
       * button. NOT durable — boot reconciliation (5c-3) re-derives
       * from `profile.version` vs `daemon-config.profile_version`.
       */
      getPartialApplyState(): Promise<DesktopPartialApplyState>;
      /**
       * D4.a Commit 5c-2 — re-run phase-2 against the on-disk
       * profile. Reads the profile fresh (it may have changed since
       * the last attempt), runs phase-2, returns the new outcome +
       * state. Profile read failures surface as a typed
       * `profile_unreadable` outcome that does NOT mutate the
       * in-memory state — 5c-3 owns the full typed repair state.
       */
      retryPartialApply(): Promise<DesktopPartialApplyRetryResult>;
      pickDirectory(options?: { defaultPath?: string }): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      openAttachmentExternal(input: {
        filename: string;
        bytes: Uint8Array;
      }): Promise<{ ok: true } | { ok: false; reason: string }>;
      saveAttachment(input: {
        filename: string;
        bytes: Uint8Array;
      }): Promise<
        | { ok: true; path: string }
        | { ok: false; canceled: true }
        | { ok: false; reason: string }
      >;
      showItemInFolder(path: string): Promise<void>;
      showSystemNotification(opts: {
        title: string;
        body: string;
        force?: boolean;
        notificationId?: string;
      }): Promise<void>;
      onNotificationClicked(handler: (notificationId: string) => void): () => void;
      dismissSystemNotifications(notificationIds: string[]): Promise<void>;
      setBadgeCount(count: number): Promise<void>;
      onShutdownProgress(handler: (step: string) => void): () => void;
      onNavigateSettings(handler: () => void): () => void;
      /**
       * ⌘W contextual close. Main is the single interception owner
       * (a menu accelerator fires before any renderer keydown): on each ⌘W it
       * sends a request with a fresh `reqId` bound to the window that had focus,
       * and the renderer answers via `respondContextualClose` with the same
       * `reqId`. Main hides the app (macOS Hide) ONLY on `background-app`,
       * fail-closed otherwise. Wire channels (`shortcut:contextual-close`
       * request / `shortcut:contextual-close-result` outcome) and the positional
       * arg shape are the main↔renderer contract — keep in sync with
       * `apps/desktop/src/main/index.ts`.
       */
      onContextualClose(handler: (reqId: string) => void): () => void;
      /** Renderer's authoritative answer to one `onContextualClose` request.
       *  `outcome` mirrors `ContextualCloseOutcome` in the renderer's
       *  `features/app-shell/keyboard-shortcuts.ts` (the SSOT). */
      respondContextualClose(
        reqId: string,
        outcome: 'closed-panel' | 'background-app',
      ): void;
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
