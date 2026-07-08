/**
 * `OutboundSupervisor` — daemon-side state machine for late-attach
 * outbound websocket lifecycle (Stage D3.a Commit 3).
 *
 * Background:
 *   Pre-D3.a, the daemon's outbound websocket was started from
 *   `runDaemon` directly when `opts.hostConfigPath` was passed at CLI
 *   spawn time. That coupling forced the desktop main process to
 *   either spawn the daemon late (after login) or spawn it with a
 *   pre-existing `daemon-config.json` left over from a previous user
 *   — neither is good.
 *
 *   D3.a separates "daemon is running" from "outbound is connected".
 *   The desktop launcher spawns the daemon at app boot WITHOUT
 *   `--host-config`, and the daemon does not open any outbound socket
 *   until it receives a `host_outbound_attach` IPC carrying an
 *   absolute path to the freshly-written `daemon-config.json`.
 *
 * What this module owns:
 *   - The "current `configPath` the daemon is bound to" state, and
 *     the live `OutboundDaemonClient` instance (or `null` when none).
 *   - The `attach(configPath)` decision tree: idempotent on same path,
 *     graceful swap on different path, fail-closed validation that
 *     never mutates the active client.
 *   - The CLI auto-start path (`runDaemon` calls `attach(cliConfig)`
 *     once at boot when `--host-config` is set) reuses the same
 *     decision tree.
 *
 * What this module does NOT own:
 *   - The protocol schema (`HostOutboundAttachParams` /
 *     `HostOutboundAttachResult` live in `protocol.ts`).
 *   - IPC frame plumbing (the dispatcher routes the intent here via
 *     the `hostOutboundAttachHandler` option in `DispatcherOptions`).
 *   - The websocket-level reconnect / heartbeat / write-buffer
 *     behavior — those stay in `OutboundDaemonClient` and are not
 *     touched by D3.a.
 *
 * Validation order (fail-closed, never mutate active client on error):
 *   1. `path_not_absolute`  — `!path.isAbsolute(configPath)`
 *   2. **same-path no-op short-circuit** — if `current.configPath ===
 *      configPath`, return `action: 'noop'` BEFORE any disk read.
 *      Path-binding-only contract: attach binds a path; byte changes
 *      go through `reload()`. A transient file-replaced-with-directory
 *      between two same-path attaches must NOT fail the second attach.
 *   3. `path_not_found`     — `statSync` throws ENOENT
 *   4. `path_not_a_file`    — `!statSync(...).isFile()` (rejects
 *                              directory, FIFO, socket, char/block
 *                              device — anything that isn't a regular
 *                              file). symlink-to-file is fine because
 *                              `statSync` follows symlinks.
 *   5. `parse_failed`       — `readHostConfig` returns non-ok
 *   6. `invalid_server_url` — `hostConnectWebSocketUrl` throws
 *
 * Idempotency:
 *   - same path + active client          → `action: 'noop'`
 *     (no disk read; see contract above)
 *   - same path + no client (e.g. after `stop()`) → `action: 'started'`
 *   - different valid path + active client → `stop()` + new client +
 *     `action: 'switched'`
 *   - different valid path + no client    → new client +
 *     `action: 'started'`
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { EventFrame, ResponseFrame } from '../protocol.js';
import type {
  HostOutboundAttachFailureReason,
  HostOutboundAttachParams,
  HostOutboundAttachResult,
  HostOutboundDetachResult,
  HostOutboundReloadFailureReason,
  HostOutboundReloadResult,
} from '../protocol.js';
import {
  OutboundDaemonClient,
  daemonHostConfigFingerprint,
  readHostConfig,
  hostConnectWebSocketUrl,
  type OutboundCommandDispatcher,
} from './outbound-client.js';
import type { DaemonLogger } from './logger.js';
import type { OwnerCleanup } from './outbound-frame-mapping.js';

export interface OutboundSupervisorDeps {
  logger: DaemonLogger;
  readyEvent: () => Extract<EventFrame, { event: 'ready' }>;
  dispatchCommand: OutboundCommandDispatcher;
  /** Owner-scoped deferred-queue cleanup (#task:1417 Stage 3, §11.4.1),
   *  threaded into the outbound WS client so a WS close/reconnect/stop
   *  discards that generation's queued deliveries. */
  cleanupDeferredForOwner: OwnerCleanup;
  /**
   * Test seam — overridden in unit tests to inject a fake
   * `OutboundDaemonClient`. Production callers leave it undefined to
   * use the real client. The factory takes the validated configPath
   * and must return a client object whose `start()` / `stop()` /
   * `sendEvent()` shape matches the real class.
   */
  outboundClientFactory?: (configPath: string, deps: {
    logger: DaemonLogger;
    readyEvent: () => Extract<EventFrame, { event: 'ready' }>;
    dispatchCommand: OutboundCommandDispatcher;
    cleanupDeferredForOwner: OwnerCleanup;
  }) => OutboundClientLike;
}

/** Subset of `OutboundDaemonClient` the supervisor relies on; lets
 *  tests inject a thin fake without reaching into ws internals. */
export interface OutboundClientLike {
  start(): void;
  stop(reason?: string): void;
  sendEvent(event: EventFrame): unknown;
}

/** D4.e-1 — the control-plane identity the daemon is currently attached
 *  to. Structurally identical to the workspace registry's
 *  `RegistryBinding` (origin + host id), kept local here to avoid a
 *  daemon→registry import cycle; `run.ts` consumes it directly. */
export interface OutboundBinding {
  server_origin: string;
  host_id: string;
}

/** Derive the registry binding from a validated host config. `server_url`
 *  is normalized to its URL origin so cosmetic differences (trailing
 *  slash, path, default port) never fork the namespace. */
function deriveOutboundBinding(config: { server_url: string; host_id: string }): OutboundBinding {
  return {
    server_origin: new URL(config.server_url).origin,
    host_id: config.host_id,
  };
}


export class OutboundSupervisor {
  private current: {
    configPath: string;
    /** Fingerprint of the config bytes most recently loaded for this
     *  client. Computed via `daemonHostConfigFingerprint` (same helper
     *  the outbound client uses internally) so reload's `unchanged`
     *  arm can NOT drift away from what the client treats as no-op. */
    fingerprint: string;
    /** D4.e-1 — the `{server_origin, host_id}` the daemon is currently
     *  bound to, derived from the live config. Drives the workspace
     *  registry namespace so the standalone registry tracks exactly the
     *  control plane the daemon is attached to. Recomputed on every
     *  client swap (attach/switch/reload). */
    binding: OutboundBinding;
    client: OutboundClientLike;
  } | null = null;
  private stopped = false;

  constructor(private readonly deps: OutboundSupervisorDeps) {}

  /**
   * Attempt to attach the outbound channel to `configPath`. Returns a
   * typed result; never throws for input errors (only for genuinely
   * unexpected internal failures, which the dispatcher's catch arm
   * surfaces as `internal_error`).
   *
   * On any validation failure, the currently-active client (if any)
   * is left running unchanged — a bad caller request must NOT take
   * down a working outbound.
   */
  attach(params: HostOutboundAttachParams): HostOutboundAttachResult {
    if (this.stopped) {
      // The supervisor was torn down (daemon shutting down); refuse
      // late attach attempts rather than spawning a doomed client.
      return failure('parse_failed', 'supervisor stopped');
    }

    const { config_path: configPath } = params;

    if (!isAbsolute(configPath)) {
      return failure('path_not_absolute', `config_path must be absolute: ${configPath}`);
    }

    // **Path-binding-only short-circuit** (Cindy `#task:633` D3.c
    // Commit 2 P2 round 2): same-path attach returns `noop` BEFORE
    // any disk read / URL validation. The contract is "attach binds
    // a path; byte changes must go via reload", so a redundant
    // re-attach with the same path MUST be a pure no-op regardless
    // of what happened to the file in the meantime. If we ran the
    // validation pipeline first (stat → readHostConfig → URL classify)
    // a transient file-replace-with-directory or rotate-mid-write
    // would return `path_not_a_file` / `parse_failed` /
    // `invalid_server_url` instead of `noop` — which contradicts the
    // contract and tears down callers that re-attach defensively.
    //
    // The check is purely in-memory (string equality against
    // `current.configPath`, which was already absolute-validated at
    // its own attach time). It runs AFTER `isAbsolute` so that
    // obviously malformed input is still rejected uniformly, never
    // silently accepted just because it happens to string-match.
    //
    // Callers that need to consume new bytes for the same path MUST
    // call `host_outbound_reload` — that's the verb that's
    // fingerprint-aware and validates-first-then-swaps. Splitting
    // the two verbs makes intent explicit:
    //   - Bootstrap a new attachment → `attach(path)`.
    //   - Apply byte changes (Settings save / rotate-token) →
    //     `reload()`.
    if (this.current && this.current.configPath === configPath) {
      return success(configPath, 'noop');
    }

    // statSync throws ENOENT for missing paths; catch and translate
    // to a typed reason so callers don't have to inspect errno.
    let stat;
    try {
      stat = statSync(configPath);
    } catch (err) {
      return failure(
        'path_not_found',
        (err as NodeJS.ErrnoException).message,
      );
    }
    if (!stat.isFile()) {
      // Rejects directory, FIFO, socket, char/block device, and any
      // other non-regular file. The FIFO case is the dangerous one:
      // a later `readFileSync` on a FIFO would block the daemon
      // event loop indefinitely, which would freeze the IPC
      // dispatcher and break the "bad attach request must not take
      // down a working daemon" contract. `statSync` follows symlinks
      // so symlink-to-file is accepted; symlink-to-directory /
      // symlink-to-FIFO are rejected here (the target stat decides).
      return failure(
        'path_not_a_file',
        `config_path is not a regular file: ${configPath}`,
      );
    }

    // Parse + schema-validate the JSON. `readHostConfig` returns
    // `{ ok: false, reason }` for both unreadable JSON and shape
    // mismatch; we fold both into `parse_failed` (the message keeps
    // the granular reason for debug).
    const probe = readHostConfig(configPath);
    if (!probe.ok) {
      return failure('parse_failed', probe.reason);
    }

    // Verify the URL is acceptable to the WS layer before we tear
    // down the old client. This catches "loopback http -> ws OK,
    // remote https -> wss OK, non-loopback http -> tls_required" and
    // unsupported schemes.
    try {
      hostConnectWebSocketUrl(probe.config.server_url, {
        allowInsecureRemote: probe.config.allow_insecure_remote === true,
      });
    } catch (err) {
      return failure(
        'invalid_server_url',
        (err as Error).message,
      );
    }

    // ── At this point all validation has passed. Decide the action.
    //
    // The same-path noop was short-circuited above before any disk
    // I/O. The only remaining cases are: (a) a fresh attach with no
    // current client, or (b) a different valid path swapping the old
    // client out. Both consume the just-validated `probe.config` and
    // record its fingerprint as the new baseline for reload's
    // `unchanged` comparison.

    const fingerprint = daemonHostConfigFingerprint(probe.config);

    if (this.current) {
      // Different path → graceful stop, then start fresh.
      this.current.client.stop('config_path_changed');
      this.current = null;
      const next = this.spawnClient(configPath);
      this.current = { configPath, fingerprint, binding: deriveOutboundBinding(probe.config), client: next };
      next.start();
      this.deps.logger.info(
        {
          kind: 'outbound_supervisor',
          action: 'switched',
          config_path: redactPath(configPath),
        },
        'daemon outbound switched to new config path',
      );
      return success(configPath, 'switched');
    }

    // No existing client: fresh start. Covers both first-time attach
    // and recovery (e.g. supervisor restart after daemon process
    // restart). Tests for "same path, no client" exercise this arm.
    const fresh = this.spawnClient(configPath);
    this.current = { configPath, fingerprint, binding: deriveOutboundBinding(probe.config), client: fresh };
    fresh.start();
    this.deps.logger.info(
      {
        kind: 'outbound_supervisor',
        action: 'started',
        config_path: redactPath(configPath),
      },
      'daemon outbound started from host config',
    );
    return success(configPath, 'started');
  }

  /**
   * D3.c Commit 2 — re-read the SAME `daemon-config.json` the daemon
   * is currently attached to and swap to the new bytes if and only if
   * everything validates. Used by the desktop main process from its
   * Settings save path AFTER it has atomically rewritten the config
   * file (write-temp + fsync + rename → reload IPC).
   *
   * Strict invariants:
   *   - **Hard-rejects `not_attached`** when there is no current
   *     client. MUST NOT silently fall through to "attach" — the
   *     caller (desktop main) explicitly chose `reload` vs `attach`
   *     and silent fallback hides logout-races and stale-state bugs.
   *   - **Validate-first-then-swap**: read + parse + URL-classify
   *     fully BEFORE stopping the old client. Any failure leaves the
   *     existing client running untouched (failure arm returned to
   *     caller; old client keeps streaming). A bad Settings save must
   *     not take down a working outbound.
   *   - **`unchanged` keeps the old client** when the new bytes
   *     fingerprint identically to the in-memory ones. No WS bounce
   *     for a no-op write (e.g. user opened Settings, made no edit,
   *     hit Save).
   *   - **Returns business state, not transport errors**: typed
   *     `reason` arms (`not_attached` / `config_unreadable` /
   *     `parse_failed` / `invalid_server_url`) live in the result
   *     discriminator. `ResponseError` codes are reserved for
   *     transport / dispatcher failures.
   *
   * Note that `action: 'reloaded'` only means the daemon started a
   * new client with the new bytes — WS handshake / backend attachment
   * freshness is a separate signal the caller verifies via backend's
   * `HostWsServerController.getAttachment(hostId)` (Commit 3 concern).
   * The reload intent's job is to hand the new bytes to the daemon;
   * waiting for connected is not.
   */
  reload(): HostOutboundReloadResult {
    if (this.stopped) {
      // Supervisor is terminal (daemon shutting down). Reject reload
      // for symmetry with attach's stopped-path; classify as
      // `not_attached` because the caller's recovery is the same —
      // there is no active client to refresh.
      return reloadFailure('not_attached', 'supervisor stopped');
    }

    const current = this.current;
    if (!current) {
      // Hard reject: caller must explicitly use `host_outbound_attach`
      // when no client is attached. Reload MUST NOT silently bootstrap.
      return reloadFailure(
        'not_attached',
        'no current outbound client; use host_outbound_attach to bootstrap',
      );
    }

    // Re-read the CURRENT path. Reload cannot swap to a different
    // config file — that's by design (`host_outbound_attach`'s job).
    // `readHostConfig` is the safe-read chokepoint (Cindy `#task:633`
    // P1): it stat-checks for regular file BEFORE opening so a FIFO
    // substituted for the path can't block `readFileSync` and hang
    // the dispatcher event loop, and a directory at the path produces
    // a clean `not_a_file` reason instead of an EISDIR throw that
    // would mis-categorize as `invalid_json` → `parse_failed`. Every
    // reader of `daemon-config.json` shares this contract.
    const probe = readHostConfig(current.configPath);
    if (!probe.ok) {
      // Map readHostConfig's typed reasons to our two failure arms.
      // I/O class (missing / not-a-file / io_error) → `config_unreadable`;
      // bytes-arrived-but-bad (invalid_json / invalid_shape) →
      // `parse_failed`. Reason string preserved in `message` for
      // diagnostics.
      const reason: HostOutboundReloadFailureReason =
        probe.reason === 'missing' ||
        probe.reason === 'not_a_file' ||
        probe.reason === 'io_error'
          ? 'config_unreadable'
          : 'parse_failed';
      return reloadFailure(reason, probe.reason);
    }

    // Validate the new server_url before deciding swap-or-keep. This
    // catches the case where the user (or a stale field) wrote an
    // insecure remote URL straight into the file, bypassing the
    // Settings UI validation. Delegates to `classifyServerUrl` via
    // `hostConnectWebSocketUrl` so the daemon WS policy applies here
    // just as it does at attach time.
    try {
      hostConnectWebSocketUrl(probe.config.server_url, {
        allowInsecureRemote: probe.config.allow_insecure_remote === true,
      });
    } catch (err) {
      return reloadFailure('invalid_server_url', (err as Error).message);
    }

    // Fingerprint decision. Computed via the shared helper so
    // "unchanged" here is byte-for-byte the same predicate the
    // outbound client's internal poll uses for its own no-op gate.
    const nextFingerprint = daemonHostConfigFingerprint(probe.config);
    if (nextFingerprint === current.fingerprint) {
      // No-op write — leave the active client running. Caller can
      // skip the attachment-freshness poll because nothing reconnected.
      this.deps.logger.info(
        {
          kind: 'outbound_supervisor',
          action: 'reload_unchanged',
          config_path: redactPath(current.configPath),
          host_id: probe.config.host_id,
        },
        'daemon outbound reload no-op (config bytes unchanged)',
      );
      return {
        reloaded: true,
        action: 'unchanged',
        config_path: current.configPath,
        host_id: probe.config.host_id,
      };
    }

    // ── Validation passed AND config differs → validate-first-then-
    //    swap. Stop the old client THEN start the new one. Order is
    //    strict: if any of the validation steps above had failed we
    //    would have returned without touching the old client.

    current.client.stop('config_reload');
    this.current = null;
    const next = this.spawnClient(current.configPath);
    this.current = {
      configPath: current.configPath,
      fingerprint: nextFingerprint,
      binding: deriveOutboundBinding(probe.config),
      client: next,
    };
    next.start();
    this.deps.logger.info(
      {
        kind: 'outbound_supervisor',
        action: 'reload_swapped',
        config_path: redactPath(current.configPath),
        host_id: probe.config.host_id,
      },
      'daemon outbound reloaded with fresh config bytes',
    );
    return {
      reloaded: true,
      action: 'reloaded',
      config_path: current.configPath,
      host_id: probe.config.host_id,
    };
  }

  /**
   * Forward an unsolicited daemon event to the active outbound
   * client, if any. No-op when no client is attached — embedded
   * desktop daemons spend their first seconds in this state, so
   * dropping events here is the normal pre-attach behavior, not a
   * bug.
   */
  sendEvent(event: EventFrame): void {
    this.current?.client.sendEvent(event);
  }

  /**
   * D4.e-1 — the control-plane binding the daemon is currently attached
   * to, or `null` when no outbound client is active (pre-attach, or
   * after detach/stop). The workspace registry uses this to namespace
   * its managed root + registry file per `{server_origin, host_id}`, so
   * a standalone daemon's registry follows the exact control plane it is
   * bound to. Embedded daemons never attach an outbound client, so this
   * stays `null` for them and `run.ts` falls back to the local-embedded
   * binding.
   */
  currentBinding(): OutboundBinding | null {
    return this.current ? { ...this.current.binding } : null;
  }

  /**
   * D3.b Commit 3 — gracefully detach the current outbound client
   * without making the supervisor terminal. Used by the desktop
   * main process from its `before-quit` cleanup as a latency
   * optimization: a clean WS close lets the backend drop the
   * attachment immediately rather than waiting for heartbeat /
   * socket-timeout detection.
   *
   * Strict distinction from {@link stop}:
   *   - `detach()` clears the active client and returns; the
   *     supervisor remains usable for a future
   *     `host_outbound_attach` call in the same daemon process
   *     (e.g. log-out → log-in-as-different-user; or any future
   *     UI affordance that detaches without quitting the daemon).
   *   - `stop()` marks the supervisor terminal — subsequent attach
   *     calls are rejected. Production callers: only `runDaemon`
   *     shutdown path.
   *
   * Best-effort by contract — never throws for absence of client
   * (returns `noop` instead) and never reports config-shape
   * failures (there is no config to read). Transport / dispatcher
   * errors are handled by the caller's response-frame envelope,
   * not by this method.
   *
   * Idempotency: detach after detach returns `noop`; detach after
   * `stop()` also returns `noop` (client already torn down).
   */
  detach(): HostOutboundDetachResult {
    if (this.current) {
      // 'host_outbound_detach' as the stop reason gives downstream
      // log readers / outbound-client diagnostics a grep-friendly
      // signal that this teardown was a deliberate hint, not a
      // crash / heartbeat-driven close.
      this.current.client.stop('host_outbound_detach');
      this.current = null;
      this.deps.logger.info(
        {
          kind: 'outbound_supervisor',
          action: 'detached',
        },
        'daemon outbound detached on host_outbound_detach hint',
      );
      return { detached: true, action: 'detached' };
    }
    // No active client (pre-attach state, or previously detached /
    // stopped). The hint is harmless either way — caller logs the
    // action and moves on.
    return { detached: true, action: 'noop' };
  }

  /** Tear down the active client (if any) on daemon shutdown.
   *  Idempotent. After `stop()`, further `attach()` calls return
   *  `attached: false` with reason `parse_failed`/'supervisor stopped'. */
  stop(reason = 'daemon_shutdown'): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.current) {
      this.current.client.stop(reason);
      this.current = null;
    }
  }

  /** Test-only inspection. */
  currentConfigPath(): string | null {
    return this.current?.configPath ?? null;
  }

  private spawnClient(configPath: string): OutboundClientLike {
    const factory = this.deps.outboundClientFactory;
    if (factory) {
      return factory(configPath, {
        logger: this.deps.logger,
        readyEvent: this.deps.readyEvent,
        dispatchCommand: this.deps.dispatchCommand,
        cleanupDeferredForOwner: this.deps.cleanupDeferredForOwner,
      });
    }
    return new OutboundDaemonClient({
      configPath,
      logger: this.deps.logger,
      readyEvent: this.deps.readyEvent,
      dispatchCommand: this.deps.dispatchCommand,
      cleanupDeferredForOwner: this.deps.cleanupDeferredForOwner,
    });
  }
}

function success(
  configPath: string,
  action: 'started' | 'switched' | 'noop',
): HostOutboundAttachResult {
  return { attached: true, config_path: configPath, action };
}

function failure(
  reason: HostOutboundAttachFailureReason,
  message: string,
): HostOutboundAttachResult {
  return { attached: false, reason, message };
}

function reloadFailure(
  reason: HostOutboundReloadFailureReason,
  message: string,
): HostOutboundReloadResult {
  return { reloaded: false, reason, message };
}

function redactPath(path: string): string {
  // Reuse the same heuristic as outbound-client.ts: keep the
  // filename, redact the parent directory tail. Avoids leaking full
  // home-dir paths into daemon logs without losing the "which
  // daemon-config file" signal.
  const idx = path.lastIndexOf('/');
  if (idx < 0) return path;
  return `…/${path.slice(idx + 1)}`;
}
