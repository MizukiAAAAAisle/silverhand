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
 *   2. `path_not_found`     — `statSync` throws ENOENT
 *   3. `path_not_a_file`    — `statSync(...).isDirectory()`
 *   4. `parse_failed`       — `readHostConfig` returns non-ok
 *   5. `invalid_server_url` — `hostConnectWebSocketUrl` throws
 *
 * Idempotency:
 *   - same path + active client          → `action: 'noop'`
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
} from '../protocol.js';
import {
  OutboundDaemonClient,
  readHostConfig,
  hostConnectWebSocketUrl,
  type OutboundCommandDispatcher,
} from './outbound-client.js';
import type { DaemonLogger } from './logger.js';

export interface OutboundSupervisorDeps {
  logger: DaemonLogger;
  readyEvent: () => Extract<EventFrame, { event: 'ready' }>;
  dispatchCommand: OutboundCommandDispatcher;
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
  }) => OutboundClientLike;
}

/** Subset of `OutboundDaemonClient` the supervisor relies on; lets
 *  tests inject a thin fake without reaching into ws internals. */
export interface OutboundClientLike {
  start(): void;
  stop(reason?: string): void;
  sendEvent(event: EventFrame): unknown;
}

export class OutboundSupervisor {
  private current: { configPath: string; client: OutboundClientLike } | null = null;
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
    if (stat.isDirectory()) {
      return failure(
        'path_not_a_file',
        `config_path is a directory: ${configPath}`,
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
    // non-loopback http -> tls_required" and unsupported schemes.
    try {
      hostConnectWebSocketUrl(probe.config.server_url);
    } catch (err) {
      return failure(
        'invalid_server_url',
        (err as Error).message,
      );
    }

    // ── At this point all validation has passed. Decide the action.

    if (this.current) {
      if (this.current.configPath === configPath) {
        // Same path + live client → no-op. We intentionally do NOT
        // re-read the file contents here: rotate-token already keeps
        // the in-memory config fresh, and a defensive re-read on every
        // attach would let a partial write between rotate and a
        // redundant attach desync the in-memory state from disk.
        return success(configPath, 'noop');
      }
      // Different path → graceful stop, then start fresh.
      this.current.client.stop('config_path_changed');
      this.current = null;
      const next = this.spawnClient(configPath);
      this.current = { configPath, client: next };
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
    this.current = { configPath, client: fresh };
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
   * Forward an unsolicited daemon event to the active outbound
   * client, if any. No-op when no client is attached — embedded
   * desktop daemons spend their first seconds in this state, so
   * dropping events here is the normal pre-attach behavior, not a
   * bug.
   */
  sendEvent(event: EventFrame): void {
    this.current?.client.sendEvent(event);
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
      });
    }
    return new OutboundDaemonClient({
      configPath,
      logger: this.deps.logger,
      readyEvent: this.deps.readyEvent,
      dispatchCommand: this.deps.dispatchCommand,
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

function redactPath(path: string): string {
  // Reuse the same heuristic as outbound-client.ts: keep the
  // filename, redact the parent directory tail. Avoids leaking full
  // home-dir paths into daemon logs without losing the "which
  // daemon-config file" signal.
  const idx = path.lastIndexOf('/');
  if (idx < 0) return path;
  return `…/${path.slice(idx + 1)}`;
}
