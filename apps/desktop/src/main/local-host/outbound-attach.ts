/** Desktop observation needed to prove a fresh outbound attachment.
 * No backend registry internals or daemon capability payload are required. */
export interface OutboundAttachmentSnapshot {
  hostId: string;
  connectionId: string;
  attachedAt: number;
}

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
 * Attachment freshness relative to the pre-write snapshot.
 * Semantics:
 *   accept ⇔ attachment is non-null
 *            AND attachment.hostId === expectedHostId
 *            AND ( attachedAt >= expectAttachSince
 *                  OR ( previousConnectionId !== null
 *                       AND connectionId !== previousConnectionId ) )
 */
function attachmentSatisfies(
  attachment: OutboundAttachmentSnapshot | null,
  window: ExpectedAttachWindow,
): boolean {
  if (attachment === null) return false;
  // hostId fail-loud guard: see file header rationale.
  if (attachment.hostId !== window.expectedHostId) return false;
  // Primary branch: a fresh `attachedAt` proves the attachment was
  // written to the registry AFTER we captured the lower bound, so it
  // cannot be a stale pre-existing value.
  if (attachment.attachedAt >= window.expectAttachSince) return true;
  // Secondary branch: covers "daemon attached before its IPC ack
  // returned to main, so attachedAt got stamped before
  // expectAttachSince". A different `connectionId` from the pre-IPC
  // snapshot proves the WS was actually re-attached, regardless of
  // the clock. Requires `previousConnectionId !== null` — if we had
  // no prior snapshot, a connection-id-difference is meaningless and
  // we MUST fall back to the attachedAt lower bound.
  if (
    window.previousConnectionId !== null &&
    attachment.connectionId !== window.previousConnectionId
  ) {
    return true;
  }
  return false;
}

export interface AttachWatchdogDeps {
  /** Returns the current attachment snapshot for `hostId`, or null. */
  getAttachment(hostId: string): OutboundAttachmentSnapshot | null;
}

export type AttachWatchdogOutcome =
  | { ok: true; attachment: OutboundAttachmentSnapshot; elapsedMs: number }
  | { ok: false; reason: "timeout"; elapsedMs: number }
  | {
      ok: false;
      reason: "aborted";
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
  const startedAt = Date.now();
  let terminated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveOutcome: (o: AttachWatchdogOutcome) => void = () => {};
  const promise = new Promise<AttachWatchdogOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const tick = (): void => {
    if (terminated) return;
    const elapsed = Date.now() - startedAt;
    const att = deps.getAttachment(window.expectedHostId);
    if (attachmentSatisfies(att, window)) {
      terminated = true;
      // `att` is non-null by the predicate.
      resolveOutcome({ ok: true, attachment: att!, elapsedMs: elapsed });
      return;
    }
    if (elapsed >= 10_000) {
      terminated = true;
      resolveOutcome({ ok: false, reason: "timeout", elapsedMs: elapsed });
      return;
    }
    timer = setTimeout(tick, 250);
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
      if (timer !== null) clearTimeout(timer);
      resolveOutcome({ ok: false, reason: "aborted", elapsedMs: Date.now() - startedAt });
    },
  };
}
