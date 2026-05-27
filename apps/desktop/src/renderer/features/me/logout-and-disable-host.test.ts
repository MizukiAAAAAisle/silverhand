/**
 * D3.e tests — pin every sequence arm of the logout-and-disable
 * orchestration. The hook itself is a thin wrapper around
 * `runLogoutAndDisableHost`; testing the pure function with injected
 * deps lets us pin every failure path without spinning up React Query
 * or stubbing `window.agentHub` globally.
 *
 * Cindy review gates (#task:636):
 *   1. Plain logout MUST NOT touch the host record (covered in
 *      `me/hooks.ts` design — `useLogout` is unchanged and
 *      `runLogoutAndDisableHost` is the only orchestration that
 *      calls revoke). Tests below cover the disable path's
 *      sequencing.
 *   2. Revoke failure (`ok: false` OR throw) MUST stop before
 *      logout. Covered by `does NOT call logout when revoke
 *      returns ok:false / throws`.
 *   3. Half-success: logout failure AFTER successful revoke leaves
 *      a revoked host + stale local session — recoverable, and
 *      surfaced as `logout_failed` so the UI can prompt retry.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runLogoutAndDisableHost,
  type LogoutAndDisableHostDeps,
} from './hooks';

interface FakeOptions {
  revokeResult?:
    | Awaited<ReturnType<LogoutAndDisableHostDeps['revokeHost']>>
    | { throw: Error };
  logoutResult?: { throw: Error };
}

function makeFakeDeps(opts: FakeOptions = {}) {
  const revokeHost = vi.fn(async () => {
    const r = opts.revokeResult ?? { ok: true as const, host: {} as never, local_host_id: null, local_host_status: 'revoked' as const, local_host_ws_attached_at: null, local_host_server_url: null };
    if ('throw' in r) throw r.throw;
    return r;
  });
  const logout = vi.fn(async () => {
    if (opts.logoutResult && 'throw' in opts.logoutResult) {
      throw opts.logoutResult.throw;
    }
    return { ok: true as const };
  });
  const onLogoutSuccess = vi.fn();
  return {
    revokeHost,
    logout,
    onLogoutSuccess,
  } satisfies LogoutAndDisableHostDeps;
}

describe('runLogoutAndDisableHost — happy path', () => {
  it('revokes then logs out then runs cleanup', async () => {
    const deps = makeFakeDeps();
    const result = await runLogoutAndDisableHost({ hostId: 'host-1' }, deps);
    expect(result).toEqual({ ok: true });
    expect(deps.revokeHost).toHaveBeenCalledWith({ hostId: 'host-1' });
    expect(deps.logout).toHaveBeenCalledTimes(1);
    expect(deps.onLogoutSuccess).toHaveBeenCalledTimes(1);
    // Critical ordering: revoke MUST land before logout. We assert
    // the call order via mock.invocationCallOrder so a future
    // refactor that parallelizes the two surfaces the regression.
    const revokeOrder = deps.revokeHost.mock.invocationCallOrder[0]!;
    const logoutOrder = deps.logout.mock.invocationCallOrder[0]!;
    const cleanupOrder = (deps.onLogoutSuccess as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0]!;
    expect(revokeOrder).toBeLessThan(logoutOrder);
    expect(logoutOrder).toBeLessThan(cleanupOrder);
  });
});

describe('runLogoutAndDisableHost — Cindy gate 2 (no logout without successful revoke)', () => {
  it('returns no_current_host without calling either IPC when hostId is null', async () => {
    const deps = makeFakeDeps();
    const result = await runLogoutAndDisableHost({ hostId: null }, deps);
    expect(result).toEqual({
      ok: false,
      kind: 'no_current_host',
      message: expect.stringContaining('No current local host'),
    });
    expect(deps.revokeHost).not.toHaveBeenCalled();
    expect(deps.logout).not.toHaveBeenCalled();
    expect(deps.onLogoutSuccess).not.toHaveBeenCalled();
  });

  it('does NOT call logout when revoke returns ok:false (typed mutation failure)', async () => {
    // The user might click the button while the server has already
    // revoked the host out-of-band. We surface the typed error and
    // leave the user signed in — the next mutation attempt will
    // see the same `host_revoked` and the user can switch to plain
    // Log out.
    const deps = makeFakeDeps({
      revokeResult: {
        ok: false,
        code: 'host_revoked',
        message: 'Host has already been revoked.',
      },
    });
    const result = await runLogoutAndDisableHost({ hostId: 'host-1' }, deps);
    expect(result).toEqual({
      ok: false,
      kind: 'revoke_failed',
      message: 'Host has already been revoked.',
    });
    expect(deps.revokeHost).toHaveBeenCalledTimes(1);
    expect(deps.logout).not.toHaveBeenCalled();
    expect(deps.onLogoutSuccess).not.toHaveBeenCalled();
  });

  it('does NOT call logout when revoke throws (transport / IPC failure)', async () => {
    const deps = makeFakeDeps({
      revokeResult: { throw: new Error('network down') },
    });
    const result = await runLogoutAndDisableHost({ hostId: 'host-1' }, deps);
    expect(result).toEqual({
      ok: false,
      kind: 'revoke_failed',
      message: 'network down',
    });
    expect(deps.revokeHost).toHaveBeenCalledTimes(1);
    expect(deps.logout).not.toHaveBeenCalled();
    expect(deps.onLogoutSuccess).not.toHaveBeenCalled();
  });

  it('falls back to code when revoke result message is undefined', async () => {
    // `network_error` may surface without a message; the orchestrator
    // still has to return something the UI can render. We chose the
    // code over a generic "Revoke failed" to give the user a hint
    // they can match against the matrix in HostsPane.
    const deps = makeFakeDeps({
      revokeResult: {
        ok: false,
        code: 'network_error',
      },
    });
    const result = await runLogoutAndDisableHost({ hostId: 'host-1' }, deps);
    expect(result).toEqual({
      ok: false,
      kind: 'revoke_failed',
      message: 'network_error',
    });
    expect(deps.logout).not.toHaveBeenCalled();
  });
});

describe('runLogoutAndDisableHost — Cindy gate 3 (half-success: logout fails AFTER revoke)', () => {
  it('returns logout_failed but does NOT call cleanup; host stays revoked', async () => {
    // After revoke succeeds the host is server-side dead. If logout
    // fails (network blip) we still want the UI to show the typed
    // error so the user can retry — but cleanup MUST NOT fire,
    // because the local session is still considered live by the
    // main process. Re-running the disable button would hit
    // `revoke_failed` (host already revoked), but plain Log out
    // would work.
    const deps = makeFakeDeps({
      logoutResult: { throw: new Error('logout transport timeout') },
    });
    const result = await runLogoutAndDisableHost({ hostId: 'host-1' }, deps);
    expect(result).toEqual({
      ok: false,
      kind: 'logout_failed',
      message: 'logout transport timeout',
    });
    expect(deps.revokeHost).toHaveBeenCalledTimes(1);
    expect(deps.logout).toHaveBeenCalledTimes(1);
    expect(deps.onLogoutSuccess).not.toHaveBeenCalled();
  });
});

describe('runLogoutAndDisableHost — anti-collapse pins', () => {
  it('non-Error throws stringify safely', async () => {
    // `Promise.reject('weird string')` from a faulty driver should
    // not crash the mutation; surface as best-effort message.
    const deps = makeFakeDeps({
      revokeResult: { throw: 'string-not-error' as unknown as Error },
    });
    const result = await runLogoutAndDisableHost({ hostId: 'host-1' }, deps);
    expect(result).toEqual({
      ok: false,
      kind: 'revoke_failed',
      message: 'string-not-error',
    });
  });
});
