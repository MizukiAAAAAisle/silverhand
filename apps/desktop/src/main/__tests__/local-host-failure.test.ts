/**
 * Unit tests for `flipToFailedOnBudgetExhausted` (D3.b Commit 2).
 *
 * The helper is the inner mapping step inside the
 * `applyFatalExitToClaim` chokepoint — the SINGLE place
 * `local_host_status` flips to `'failed'`. These tests pin two
 * things:
 *
 *  1. The mapping itself for every input variant: preserve `hostId`
 *     when present, surface `null` when not.
 *  2. The strict source rule is a property of the call graph:
 *     `flipToFailedOnBudgetExhausted` has exactly one production
 *     caller (`applyFatalExitToClaim` in the same module), which in
 *     turn has exactly one production caller (the supervisor
 *     `daemon.onExit` handler in `main/index.ts`). Future commits
 *     that add a new failure surface must change THIS file to do
 *     so, which surfaces the gate question in the diff. The grep-
 *     based assertion in the README of `local-host-failure.ts`
 *     covers the call-site invariant (grep `applyFatalExitToClaim`
 *     for the production chokepoint) — these tests cover the pure
 *     mapping.
 */
import { describe, expect, it } from 'vitest';
import type { DaemonFatalExitInfo } from '@silverhand/host';
import type { LocalHostClaimStatus } from '../local-host-claim.js';
import {
  applyFatalExitToClaim,
  flipToFailedOnBudgetExhausted,
} from '../local-host-failure.js';

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

  it('LEAVES revoked unchanged — credential removal trumps daemon liveness', () => {
    // Cindy `#task:629` P1-B: revoked means the server-side credential
    // is gone and recovery is "re-claim via Hosts settings", NOT
    // "restart the daemon". Flipping to `failed` would route the user
    // to the wrong remediation surface. The supervisor's terminal
    // liveness signal and the credential lifecycle are two different
    // surfaces; if the product ever needs to express both at once,
    // that belongs in a separate diagnostic/overlay field.
    const current: LocalHostClaimStatus = { status: 'revoked', hostId: 'host-xyz' };
    const next = flipToFailedOnBudgetExhausted(current);
    expect(next).toBe(current);
    expect(next).toEqual({ status: 'revoked', hostId: 'host-xyz' });
  });

  it('LEAVES revoked unchanged even when hostId is null (post-revoke without id)', () => {
    const current: LocalHostClaimStatus = { status: 'revoked', hostId: null };
    expect(flipToFailedOnBudgetExhausted(current)).toBe(current);
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

describe('applyFatalExitToClaim — kind gate (Cindy #task:629 P1-A)', () => {
  const claimed: LocalHostClaimStatus = { status: 'claimed', hostId: 'host-abc' };

  it('flips claimed → failed on restart_budget_exhausted', () => {
    const info: DaemonFatalExitInfo = {
      kind: 'restart_budget_exhausted',
      reason: 'daemon crashed 6 times within 60000ms; giving up',
      code: 1,
    };
    expect(applyFatalExitToClaim(claimed, info)).toEqual({
      status: 'failed',
      hostId: 'host-abc',
    });
  });

  it('LEAVES claimed unchanged on respawn_handshake_failed', () => {
    // Strict source rule: handshake failure is recovery-surface
    // ambiguous (bad daemon binary path, stderr-only daemon, port
    // collision the user can fix). It must NOT lock UI into the
    // "supervisor gave up" end-state. Logged by caller; no mutation.
    const info: DaemonFatalExitInfo = {
      kind: 'respawn_handshake_failed',
      reason: 'daemon restart failed: daemon did not emit ready handshake within 10000ms',
      code: null,
    };
    const next = applyFatalExitToClaim(claimed, info);
    expect(next).toBe(claimed);
  });

  it('LEAVES revoked unchanged on restart_budget_exhausted (helper carve-out wins)', () => {
    // Even when the supervisor genuinely exhausted budget, a revoked
    // credential trumps daemon-liveness signal — recovery is re-claim.
    const revoked: LocalHostClaimStatus = { status: 'revoked', hostId: 'host-xyz' };
    const info: DaemonFatalExitInfo = {
      kind: 'restart_budget_exhausted',
      reason: 'giving up',
      code: 1,
    };
    expect(applyFatalExitToClaim(revoked, info)).toBe(revoked);
  });

  it('LEAVES revoked unchanged on respawn_handshake_failed (both rules concur)', () => {
    const revoked: LocalHostClaimStatus = { status: 'revoked', hostId: 'host-xyz' };
    const info: DaemonFatalExitInfo = {
      kind: 'respawn_handshake_failed',
      reason: 'whatever',
      code: null,
    };
    expect(applyFatalExitToClaim(revoked, info)).toBe(revoked);
  });
});
