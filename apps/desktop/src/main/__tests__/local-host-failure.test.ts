/**
 * Unit tests for `flipToFailedOnBudgetExhausted` (D3.b Commit 2).
 *
 * The helper is the SINGLE chokepoint where `local_host_status`
 * flips to `'failed'`. These tests pin two things:
 *
 *  1. The mapping itself for every input variant: preserve `hostId`
 *     when present, surface `null` when not.
 *  2. The strict source rule is a property of the call graph: this
 *     helper has only one production call site (the supervisor
 *     `daemon.onExit` handler in `main/index.ts`). Future commits
 *     that add a new failure surface must change THIS file to do
 *     so, which surfaces the gate question in the diff. The grep-
 *     based assertion in the README of `local-host-failure.ts`
 *     covers the call-site invariant — these tests cover the pure
 *     mapping.
 */
import { describe, expect, it } from 'vitest';
import type { LocalHostClaimStatus } from '../local-host-claim.js';
import { flipToFailedOnBudgetExhausted } from '../local-host-failure.js';

describe('flipToFailedOnBudgetExhausted', () => {
  it('maps unclaimed → failed with hostId=null (no host ever existed)', () => {
    const current: LocalHostClaimStatus = { status: 'unclaimed', hostId: null };
    expect(flipToFailedOnBudgetExhausted(current)).toEqual({
      status: 'failed',
      hostId: null,
    });
  });

  it('maps claimed → failed preserving hostId for diagnostic surface', () => {
    const current: LocalHostClaimStatus = { status: 'claimed', hostId: 'host-abc' };
    expect(flipToFailedOnBudgetExhausted(current)).toEqual({
      status: 'failed',
      hostId: 'host-abc',
    });
  });

  it('maps revoked → failed preserving hostId (supervisor crash trumps revoke surface)', () => {
    // Edge case: if the daemon dies in the moments after a revoke
    // landed but before the user dismissed the revoke notice, we
    // want the more recent failure to win so the user sees the
    // actionable "daemon stopped" message. hostId is preserved so
    // the renderer can still reference the host row by id.
    const current: LocalHostClaimStatus = { status: 'revoked', hostId: 'host-xyz' };
    expect(flipToFailedOnBudgetExhausted(current)).toEqual({
      status: 'failed',
      hostId: 'host-xyz',
    });
  });

  it('maps error → failed preserving hostId', () => {
    const current: LocalHostClaimStatus = { status: 'error', hostId: 'host-err' };
    expect(flipToFailedOnBudgetExhausted(current)).toEqual({
      status: 'failed',
      hostId: 'host-err',
    });
  });

  it('is idempotent against an already-failed state', () => {
    // Defensive: if `daemon.onExit` somehow fires twice (it
    // shouldn't — supervisor only emits fatal exit once) the second
    // application must not introduce new state.
    const current: LocalHostClaimStatus = { status: 'failed', hostId: 'host-stuck' };
    expect(flipToFailedOnBudgetExhausted(current)).toEqual({
      status: 'failed',
      hostId: 'host-stuck',
    });
  });

  it('does not mutate the input (returns a fresh object)', () => {
    const current: LocalHostClaimStatus = { status: 'claimed', hostId: 'host-frozen' };
    const next = flipToFailedOnBudgetExhausted(current);
    expect(next).not.toBe(current);
    expect(current).toEqual({ status: 'claimed', hostId: 'host-frozen' });
  });
});
