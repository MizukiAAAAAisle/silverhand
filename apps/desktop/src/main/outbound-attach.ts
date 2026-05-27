/**
 * Desktop-side helpers that drive the post-login `host_outbound_attach`
 * IPC and verify the resulting outbound WS attachment landed back at
 * the backend's `HostWsServerController` registry (D3.a Commit 4).
 *
 * Background: in D3.a Commit 3 the daemon stopped consuming
 * `daemon-config.json` automatically; it now waits for an explicit
 * `host_outbound_attach { config_path }` IPC. The desktop main
 * process owns the trigger, but "IPC ack" alone is not proof the
 * outbound WS is actually attached at the backend end — the daemon
 * might still be mid-connect or its connect might race the IPC
 * response either way. The watchdog below closes that loop by
 * polling the `HostWsServerController` until a *fresh* attachment
 * for our local host appears.
 *
 * The "fresh" predicate is the subtle bit (see Cindy review on
 * #task:623): we cannot anchor freshness purely on a wall-clock
 * lower bound because the daemon may open the WS *before* the IPC
 * response returns to main — using an "after IPC ack" timestamp as
 * the lower bound would then exclude the very attach we're waiting
 * for. The contract is:
 *
 *   freshness = `connectionId` is new since the snapshot we took
 *               BEFORE writing the config
 *               OR
 *               `attachedAt >= expectAttachSince` (the timestamp we
 *               captured BEFORE writing the config)
 *
 * Either branch is sufficient, both branches are necessary:
 *   - `connectionId` change catches the "WS connected before IPC
 *     response" race.
 *   - `attachedAt` lower-bound catches the case where no prior
 *     attachment existed (`previousConnectionId === null`) — in that
 *     world the connection-id branch alone trivially fires for any
 *     non-null attachment which would risk accepting a stale fake
 *     in test seams.
 *
 * Additionally we require `attachment.hostId === expectedHostId`
 * even though the controller already keys by hostId — that's a
 * fail-loud guard against future controller-interface evolution or
 * test-fake typos where the value's `hostId` drifts from the lookup
 * key. Per Cindy `pqxWjGdeUTaAkHBd`.
 */
import type { HostWsAttachment } from '@silverhand/backend';

/** Snapshot taken BEFORE writing daemon-config + sending the
 *  `host_outbound_attach` IPC. The watchdog uses this to distinguish
 *  the fresh post-login attach from any pre-existing one. */
export interface ExpectedAttachWindow {
  /**
   * The expected host id whose attachment we want to observe. Echoed
   * verbatim in the predicate as a key-vs-value sanity guard.
   */
  expectedHostId: string;
  /**
   * `connectionId` of any attachment that existed BEFORE we sent the
   * IPC, or `null` if none. A subsequent attachment with a different
   * (or non-null when this is null) `connectionId` is by definition
   * the fresh one.
   */
  previousConnectionId: string | null;
  /**
   * Lower bound on `attachedAt` for an attachment that may have been
   * created by the IPC. Must be captured BEFORE the IPC is sent (so
   * any attachedAt the daemon writes during/after the IPC is
   * guaranteed to be `>=` it).
   */
  expectAttachSince: number;
}

/**
 * Pure predicate — keep this synchronous and side-effect-free so the
 * unit test for the freshness contract does not need a fake clock,
 * fake controller, or fake IPC. The polling loop simply re-evaluates
 * this against the latest controller snapshot.
 */
export function attachmentSatisfies(
  attachment: HostWsAttachment | null,
  window: ExpectedAttachWindow,
): boolean {
  if (attachment === null) return false;
  // hostId fail-loud guard: see file header rationale.
  if (attachment.hostId !== window.expectedHostId) return false;
  // EITHER a new connection-id OR an `attachedAt` >= the pre-IPC
  // lower bound. The OR is load-bearing: see file header.
  if (
    window.previousConnectionId !== null &&
    attachment.connectionId === window.previousConnectionId &&
    attachment.attachedAt < window.expectAttachSince
  ) {
    return false;
  }
  return true;
}

export interface AttachWatchdogDeps {
  /** Returns the current attachment snapshot for `hostId`, or null. */
  getAttachment(hostId: string): HostWsAttachment | null;
  /**
   * Poll interval in ms. Default 250. Kept injectable so tests can
   * drive the loop deterministically with a fake scheduler.
   */
  pollIntervalMs?: number;
  /**
   * Overall budget before the watchdog gives up. Default 10_000.
   * Timeout is a *diagnostic* signal only — UI-facing status stays
   * `connecting` (per Cindy `EDu21iazTBvFqXHJ`/`HAdYZRVoogy852Qt`,
   * we do NOT introduce a `connecting_timeout` enum).
   */
  timeoutMs?: number;
  /**
   * Optional scheduler hook for tests. Defaults to `setTimeout`.
   */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  /**
   * Clock hook. Defaults to `Date.now`.
   */
  now?: () => number;
}

export type AttachWatchdogOutcome =
  | { ok: true; attachment: HostWsAttachment; elapsedMs: number }
  | { ok: false; reason: 'timeout'; elapsedMs: number }
  | {
      ok: false;
      reason: 'aborted';
      elapsedMs: number;
    };

export interface AttachWatchdogHandle {
  /** Resolves when the watchdog reaches a terminal state. */
  promise: Promise<AttachWatchdogOutcome>;
  /** Abort the watchdog early (e.g. on logout / app quit). Idempotent. */
  abort(): void;
}

/**
 * Spawn a watchdog that polls until the freshness predicate is true,
 * or until the timeout budget is exhausted. The returned promise
 * always resolves (no reject path) so the caller can attach to it
 * without an unhandled-rejection footgun.
 *
 * Lifecycle invariants:
 *  - Initial probe happens synchronously BEFORE the first timer
 *    arms; if the attachment is already fresh we resolve in the
 *    same microtask without waiting a poll interval.
 *  - On any terminal outcome the active timer is cleared.
 *  - `abort()` after terminal outcome is a no-op.
 */
export function startAttachWatchdog(
  window: ExpectedAttachWindow,
  deps: AttachWatchdogDeps,
): AttachWatchdogHandle {
  const interval = deps.pollIntervalMs ?? 250;
  const budget = deps.timeoutMs ?? 10_000;
  const setT = deps.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = deps.clearTimeoutImpl ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());

  const startedAt = now();
  let terminated = false;
  let timer: unknown = null;
  let resolveOutcome: (o: AttachWatchdogOutcome) => void = () => {};
  const promise = new Promise<AttachWatchdogOutcome>(resolve => {
    resolveOutcome = resolve;
  });

  const tick = (): void => {
    if (terminated) return;
    const elapsed = now() - startedAt;
    const att = deps.getAttachment(window.expectedHostId);
    if (attachmentSatisfies(att, window)) {
      terminated = true;
      // `att` is non-null by the predicate.
      resolveOutcome({ ok: true, attachment: att!, elapsedMs: elapsed });
      return;
    }
    if (elapsed >= budget) {
      terminated = true;
      resolveOutcome({ ok: false, reason: 'timeout', elapsedMs: elapsed });
      return;
    }
    timer = setT(tick, interval);
  };

  // Initial synchronous probe: catches the case where the attachment
  // has already landed by the time the watchdog starts (e.g. daemon
  // raced the IPC response).
  tick();

  return {
    promise,
    abort: () => {
      if (terminated) return;
      terminated = true;
      if (timer !== null) clearT(timer);
      resolveOutcome({ ok: false, reason: 'aborted', elapsedMs: now() - startedAt });
    },
  };
}
