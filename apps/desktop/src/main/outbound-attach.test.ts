/**
 * Tests for `outbound-attach.ts` — the desktop-side helper that owns
 * the `host_outbound_attach` freshness contract (D3.a Commit 4).
 *
 * Two lenses:
 *   1. `attachmentSatisfies` pure predicate — fail-loud on hostId
 *      mismatch, accepts on either fresh connection-id OR
 *      attachedAt >= lower-bound; pre-existing stale attachment must
 *      not satisfy.
 *   2. `startAttachWatchdog` lifecycle — synchronous resolve when the
 *      attachment is already fresh, timed wait when not, timeout
 *      surfaces a diagnostic outcome (NOT a UI status enum), abort
 *      is idempotent.
 *
 * Background on the predicate (see Cindy review notes
 * `3crX9IRnMUbm7CFv` / `v0-84W8MIUybpBTz` / `pqxWjGdeUTaAkHBd`):
 *   - The daemon may attach BEFORE its `host_outbound_attach` IPC
 *     ack returns to main, so an "after IPC ack" timestamp would
 *     wrongly exclude the very attach we want.
 *   - Snapshot the previous connection-id BEFORE the IPC; either a
 *     new connection-id OR `attachedAt >= preIpcLowerBound` is proof
 *     the attach is fresh.
 *   - hostId equality guard is fail-loud against future controller
 *     interface evolution and test-fake typos.
 */
import { describe, expect, it } from 'vitest';
import type { HostWsAttachment } from '@silverhand/backend';
import {
  attachmentSatisfies,
  startAttachWatchdog,
  type ExpectedAttachWindow,
} from './outbound-attach.js';

function makeAttachment(over: Partial<HostWsAttachment> = {}): HostWsAttachment {
  return {
    hostId: 'host-local-1',
    connectionId: 'conn-A',
    attachedAt: 1_000_000,
    ...over,
  };
}

function makeWindow(over: Partial<ExpectedAttachWindow> = {}): ExpectedAttachWindow {
  return {
    expectedHostId: 'host-local-1',
    previousConnectionId: null,
    expectAttachSince: 1_000_000,
    ...over,
  };
}

describe('attachmentSatisfies — freshness predicate', () => {
  it('returns false when no attachment exists yet', () => {
    expect(attachmentSatisfies(null, makeWindow())).toBe(false);
  });

  it('CRITICAL hostId fail-loud: rejects an attachment whose hostId disagrees with the lookup key (controller-contract regression guard)', () => {
    const att = makeAttachment({ hostId: 'host-OTHER' });
    expect(attachmentSatisfies(att, makeWindow({ expectedHostId: 'host-local-1' }))).toBe(false);
  });

  it('accepts a brand-new attachment when no previous connection existed (previousConnectionId=null, fresh attachedAt)', () => {
    const att = makeAttachment({ connectionId: 'conn-new', attachedAt: 2_000_000 });
    expect(
      attachmentSatisfies(att, makeWindow({ previousConnectionId: null, expectAttachSince: 1_000_000 })),
    ).toBe(true);
  });

  it('CRITICAL no-previous-snapshot stale guard: previousConnectionId=null AND attachedAt < expectAttachSince → false (Cindy review Ofs303uqD1M22yWT)', () => {
    // First-claim / cold-start path: main has no prior snapshot of an
    // attachment. The OR-rewrite must still reject any registry value
    // whose `attachedAt` predates our lower bound — otherwise a stale
    // attachment left over from a previous boot would pass purely
    // because `previousConnectionId === null` short-circuits the
    // connection-id branch. The earlier rejection-list form had this
    // bug; this case pins the fix.
    const att = makeAttachment({
      connectionId: 'conn-leftover',
      attachedAt: 500_000,
    });
    expect(
      attachmentSatisfies(
        att,
        makeWindow({ previousConnectionId: null, expectAttachSince: 1_000_000 }),
      ),
    ).toBe(false);
  });

  it('CRITICAL fresh-connection-id branch: accepts an attachment whose connectionId differs from the snapshot even if attachedAt is < lower-bound (covers "daemon attached before IPC response")', () => {
    // Pre-IPC snapshot saw `conn-OLD` attached at t=1_500_000. Watchdog
    // captures expectAttachSince=t=2_000_000 right before sending IPC.
    // Daemon attaches a NEW connection (conn-NEW) but the controller's
    // attachedAt happens to be timestamped at t=1_999_999 — earlier
    // than expectAttachSince. The connection-id-change branch is what
    // keeps us from getting stuck waiting on the lower-bound.
    const att = makeAttachment({
      connectionId: 'conn-NEW',
      attachedAt: 1_999_999,
    });
    expect(
      attachmentSatisfies(
        att,
        makeWindow({
          previousConnectionId: 'conn-OLD',
          expectAttachSince: 2_000_000,
        }),
      ),
    ).toBe(true);
  });

  it('CRITICAL lower-bound branch: accepts an attachment whose connectionId equals the snapshot if its attachedAt jumped (defensive: should not happen with the connectionId-replacement-guard but locks the OR-semantics)', () => {
    const att = makeAttachment({
      connectionId: 'conn-SAME',
      attachedAt: 3_000_000,
    });
    expect(
      attachmentSatisfies(
        att,
        makeWindow({
          previousConnectionId: 'conn-SAME',
          expectAttachSince: 2_000_000,
        }),
      ),
    ).toBe(true);
  });

  it('CRITICAL rejects a stale pre-existing attachment (same connectionId AND attachedAt < lower-bound)', () => {
    // This is the exact case the freshness contract exists for: a
    // pre-existing attachment from a previous user session is still
    // sitting in the registry. We must NOT accept it as proof the
    // new host_outbound_attach IPC succeeded.
    const att = makeAttachment({
      connectionId: 'conn-STALE',
      attachedAt: 1_500_000,
    });
    expect(
      attachmentSatisfies(
        att,
        makeWindow({
          previousConnectionId: 'conn-STALE',
          expectAttachSince: 2_000_000,
        }),
      ),
    ).toBe(false);
  });
});

describe('startAttachWatchdog — lifecycle', () => {
  it('resolves synchronously (no timer fired) when the attachment is already fresh at startup', async () => {
    // The daemon raced the IPC response and the attachment is in
    // the registry before we even start the watchdog. We must NOT
    // wait an interval — same-microtask resolution.
    let getCalls = 0;
    let setTimeoutCalls = 0;
    const handle = startAttachWatchdog(
      makeWindow({ previousConnectionId: null, expectAttachSince: 100 }),
      {
        getAttachment: () => {
          getCalls += 1;
          return makeAttachment({ connectionId: 'conn-fresh', attachedAt: 200 });
        },
        setTimeoutImpl: (cb, ms) => {
          setTimeoutCalls += 1;
          return setTimeout(cb, ms);
        },
        now: () => 100,
      },
    );
    const outcome = await handle.promise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attachment.connectionId).toBe('conn-fresh');
      expect(outcome.elapsedMs).toBe(0);
    }
    expect(getCalls).toBe(1);
    expect(setTimeoutCalls).toBe(0);
  });

  it('polls until a fresh attachment appears, then resolves', async () => {
    const window_ = makeWindow({ previousConnectionId: 'conn-old', expectAttachSince: 1_000 });
    let probe = 0;
    const handle = startAttachWatchdog(window_, {
      getAttachment: () => {
        probe += 1;
        // Tick 1: stale (same conn-old, older attachedAt). Tick 2:
        // still stale. Tick 3: daemon attached fresh.
        if (probe < 3) {
          return makeAttachment({ connectionId: 'conn-old', attachedAt: 500 });
        }
        return makeAttachment({ connectionId: 'conn-new', attachedAt: 1_500 });
      },
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });
    const outcome = await handle.promise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.attachment.connectionId).toBe('conn-new');
    }
    expect(probe).toBe(3);
  });

  it('resolves with reason=timeout (NOT a UI status) when budget exhausted', async () => {
    // The contract says timeout is diagnostic only — UI stays
    // `connecting`. This test pins the outcome shape so a future
    // refactor cannot accidentally widen it into a status enum.
    const window_ = makeWindow({ previousConnectionId: 'conn-stale', expectAttachSince: 5_000 });
    const handle = startAttachWatchdog(window_, {
      getAttachment: () =>
        makeAttachment({ connectionId: 'conn-stale', attachedAt: 1 }),
      pollIntervalMs: 5,
      timeoutMs: 30,
    });
    const outcome = await handle.promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('timeout');
  });

  it('abort() during polling resolves with reason=aborted', async () => {
    const window_ = makeWindow({ previousConnectionId: 'conn-old', expectAttachSince: 1_000 });
    const handle = startAttachWatchdog(window_, {
      getAttachment: () =>
        makeAttachment({ connectionId: 'conn-old', attachedAt: 500 }),
      pollIntervalMs: 20,
      timeoutMs: 5_000,
    });
    // Abort before any timer fires.
    setTimeout(() => handle.abort(), 5);
    const outcome = await handle.promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('aborted');
  });

  it('abort() after terminal outcome is a no-op (idempotent, no double resolve)', async () => {
    const handle = startAttachWatchdog(
      makeWindow({ previousConnectionId: null, expectAttachSince: 0 }),
      {
        getAttachment: () => makeAttachment(),
      },
    );
    const outcome = await handle.promise;
    expect(outcome.ok).toBe(true);
    // Call abort post-terminal; promise should already have settled
    // and no second resolution must leak.
    handle.abort();
    handle.abort();
    // Re-await to confirm the original outcome is unchanged.
    const again = await handle.promise;
    expect(again).toBe(outcome);
  });
});
