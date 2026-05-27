/**
 * D4.a Commit 5d-fixup (Cindy P1-1) — seam tests for the
 * `executeBackendStartup` adapter.
 *
 * Cindy's tighter constraint (msg `N_XhNsao4iY2Tagx`) said:
 *
 *   > P1-1 的 pin 不要只靠 grep 字符串，最好同时有一个小的
 *   > seam/unit test：remote/refuse plan 不执行 injected
 *   > `loadOrCreateServerConfig`，embedded plan 才执行。
 *
 * These tests pin the load-bearing invariant of the §4.2 hard gate:
 * a remote (or refuse) BackendStartupPlan MUST NOT touch the embedded
 * server-config artifact. The whole point of the 5d-fixup is that on
 * a remote profile boot the legacy `loadOrCreateServerConfig()` side
 * effect (it creates the file if missing) NEVER runs.
 *
 * The adapter is generic so we can substitute opaque sentinels for
 * `RunningBackend` / `RemoteBackendHandle` and observe purely through
 * spy call counts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  executeBackendStartup,
  type BackendStartupPlan,
  type ExecuteBackendStartupDeps,
} from '../backend-boot-mode.js';

// Opaque sentinels used in place of the production types. The seam
// test cares about WHICH dep was called, not what shape the result has.
type FakeRunning = { __fake: 'running' };
type FakeRemote = { __fake: 'remote'; serverUrl: string; insecure: boolean };

function makeDeps(
  overrides?: Partial<ExecuteBackendStartupDeps<FakeRunning, FakeRemote>>,
): {
  deps: ExecuteBackendStartupDeps<FakeRunning, FakeRemote>;
  spies: {
    loadOrCreateServerConfig: ReturnType<typeof vi.fn>;
    startEmbeddedAndPersistConfig: ReturnType<typeof vi.fn>;
    buildRemoteHandle: ReturnType<typeof vi.fn>;
    refuse: ReturnType<typeof vi.fn>;
  };
} {
  const loadOrCreateServerConfig = vi.fn(async () => ({
    __fake: 'config',
  }));
  const startEmbeddedAndPersistConfig = vi.fn(
    async (_config: unknown): Promise<FakeRunning> => ({ __fake: 'running' }),
  );
  const buildRemoteHandle = vi.fn(
    (input: { serverUrl: string; insecure: boolean }): FakeRemote => ({
      __fake: 'remote',
      serverUrl: input.serverUrl,
      insecure: input.insecure,
    }),
  );
  const refuse = vi.fn(
    (plan: Extract<BackendStartupPlan, { mode: 'refuse' }>): never => {
      throw new Error(
        `refuse() called with profileUrl=${plan.profileUrl} message=${plan.classifyMessage}`,
      );
    },
  );
  const deps: ExecuteBackendStartupDeps<FakeRunning, FakeRemote> = {
    loadOrCreateServerConfig,
    startEmbeddedAndPersistConfig,
    buildRemoteHandle,
    refuse,
    ...overrides,
  };
  return {
    deps,
    spies: {
      loadOrCreateServerConfig,
      startEmbeddedAndPersistConfig,
      buildRemoteHandle,
      refuse,
    },
  };
}

describe('executeBackendStartup — embedded plan (legacy server-config artifact MAY be touched)', () => {
  it('embedded plan calls loadOrCreateServerConfig + startEmbeddedAndPersistConfig, NOT buildRemoteHandle / refuse', async () => {
    const { deps, spies } = makeDeps();
    const plan: BackendStartupPlan = {
      mode: 'embedded',
      embeddedReason: 'no_profile',
    };
    const handle = await executeBackendStartup(plan, deps);
    expect(spies.loadOrCreateServerConfig).toHaveBeenCalledTimes(1);
    expect(spies.startEmbeddedAndPersistConfig).toHaveBeenCalledTimes(1);
    expect(spies.buildRemoteHandle).not.toHaveBeenCalled();
    expect(spies.refuse).not.toHaveBeenCalled();
    expect(handle).toEqual({ kind: 'embedded', running: { __fake: 'running' } });
  });

  it('embedded plan threads the loaded config through to the start helper', async () => {
    // Pin the invariant: whatever `loadOrCreateServerConfig` returns
    // is the EXACT object handed to `startEmbeddedAndPersistConfig`.
    // A regression where bootstrap reloads the config inside the
    // start helper (e.g. via a stale module-scoped cache) would
    // break this expectation.
    const sentinel = { __fake: 'config-sentinel' };
    const { deps, spies } = makeDeps({
      loadOrCreateServerConfig: vi.fn(async () => sentinel),
    });
    const plan: BackendStartupPlan = {
      mode: 'embedded',
      embeddedReason: 'profile_is_loopback',
    };
    await executeBackendStartup(plan, deps);
    expect(spies.startEmbeddedAndPersistConfig).toHaveBeenCalledWith(sentinel);
  });

  it.each([
    'no_profile',
    'forced_by_env',
    'profile_is_loopback',
  ] as const)(
    'embedded/%s arm always invokes both embedded helpers',
    async embeddedReason => {
      const { deps, spies } = makeDeps();
      const plan: BackendStartupPlan = {
        mode: 'embedded',
        embeddedReason,
      };
      await executeBackendStartup(plan, deps);
      expect(spies.loadOrCreateServerConfig).toHaveBeenCalledTimes(1);
      expect(spies.startEmbeddedAndPersistConfig).toHaveBeenCalledTimes(1);
    },
  );
});

describe('executeBackendStartup — remote plan (§4.2 hard gate: NO embedded artifact touched)', () => {
  it('remote plan calls ONLY buildRemoteHandle — loadOrCreateServerConfig / startEmbeddedAndPersistConfig / refuse never run', async () => {
    // This is the load-bearing pin for Cindy's 5d-fixup P1-1: the
    // legacy `~/.silverhand/server-config.json` artifact MUST NOT be
    // created on a remote-profile boot. The boot path passes through
    // `executeBackendStartup` for every arm, so if the embedded
    // helpers fire on a remote plan, the §4.2 hard gate is broken.
    const { deps, spies } = makeDeps();
    const plan: BackendStartupPlan = {
      mode: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    };
    const handle = await executeBackendStartup(plan, deps);
    expect(spies.loadOrCreateServerConfig).not.toHaveBeenCalled();
    expect(spies.startEmbeddedAndPersistConfig).not.toHaveBeenCalled();
    expect(spies.refuse).not.toHaveBeenCalled();
    expect(spies.buildRemoteHandle).toHaveBeenCalledTimes(1);
    expect(spies.buildRemoteHandle).toHaveBeenCalledWith({
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
    expect(handle).toEqual({
      __fake: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    });
  });

  it('remote/insecure=true (dev-flag http remote) also keeps embedded artifacts untouched', async () => {
    const { deps, spies } = makeDeps();
    const plan: BackendStartupPlan = {
      mode: 'remote',
      serverUrl: 'http://10.0.0.5:8080',
      insecure: true,
    };
    await executeBackendStartup(plan, deps);
    expect(spies.loadOrCreateServerConfig).not.toHaveBeenCalled();
    expect(spies.startEmbeddedAndPersistConfig).not.toHaveBeenCalled();
    expect(spies.buildRemoteHandle).toHaveBeenCalledWith({
      serverUrl: 'http://10.0.0.5:8080',
      insecure: true,
    });
  });

  it('remote plan flows serverUrl + insecure through buildRemoteHandle verbatim (no rewrite)', async () => {
    // The adapter does NOT re-canonicalize the URL — the planner
    // already did. Pin that the executor preserves the plan values.
    const captured: Array<{ serverUrl: string; insecure: boolean }> = [];
    const { deps } = makeDeps({
      buildRemoteHandle: vi.fn(input => {
        captured.push({ ...input });
        return { __fake: 'remote', ...input };
      }),
    });
    const plan: BackendStartupPlan = {
      mode: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    };
    await executeBackendStartup(plan, deps);
    expect(captured).toEqual([
      { serverUrl: 'https://backend.example.test', insecure: false },
    ]);
  });
});

describe('executeBackendStartup — refuse plan (profile_invalid: throws, embedded artifacts untouched)', () => {
  it('refuse plan calls ONLY refuse — embedded helpers never run', async () => {
    const { deps, spies } = makeDeps();
    const plan: BackendStartupPlan = {
      mode: 'refuse',
      reason: 'profile_invalid',
      profileUrl: 'http://10.0.0.5:8080',
      classifyMessage:
        'http remote requires SILVERHAND_ALLOW_INSECURE_REMOTE=1',
    };
    await expect(executeBackendStartup(plan, deps)).rejects.toThrow();
    expect(spies.loadOrCreateServerConfig).not.toHaveBeenCalled();
    expect(spies.startEmbeddedAndPersistConfig).not.toHaveBeenCalled();
    expect(spies.buildRemoteHandle).not.toHaveBeenCalled();
    expect(spies.refuse).toHaveBeenCalledTimes(1);
    expect(spies.refuse).toHaveBeenCalledWith(plan);
  });

  it('if a buggy refuse() returns instead of throwing, executeBackendStartup throws an explicit unreachable error (defense in depth)', async () => {
    // Production `refuse` is typed `(plan) => never` and always
    // throws. But TypeScript can't prevent a future refactor from
    // accidentally letting it return; pin that the adapter still
    // fails loudly so a remote-arm boot never silently completes
    // through the refuse branch.
    const refuseReturnsBuggy = vi.fn(
      (_plan: Extract<BackendStartupPlan, { mode: 'refuse' }>) => {
        // Don't throw. This simulates a regression.
        return undefined as never;
      },
    );
    const { deps } = makeDeps({ refuse: refuseReturnsBuggy });
    const plan: BackendStartupPlan = {
      mode: 'refuse',
      reason: 'profile_invalid',
      profileUrl: 'http://10.0.0.5:8080',
      classifyMessage: 'oops',
    };
    await expect(executeBackendStartup(plan, deps)).rejects.toThrow(
      /refuse\(\) returned/,
    );
  });
});

describe('executeBackendStartup — cross-arm invariants (regression bait)', () => {
  it('one call resolves with exactly one arm of the result union — no double dispatch', async () => {
    // If a regression accidentally fell-through cases (e.g. by
    // omitting `return`/`break`), we'd see e.g. both `buildRemoteHandle`
    // AND `startEmbeddedAndPersistConfig` get called on a remote plan.
    // Pin that arms are mutually exclusive per call.
    const { deps, spies } = makeDeps();
    const plan: BackendStartupPlan = {
      mode: 'remote',
      serverUrl: 'https://backend.example.test',
      insecure: false,
    };
    await executeBackendStartup(plan, deps);
    const total =
      spies.loadOrCreateServerConfig.mock.calls.length +
      spies.startEmbeddedAndPersistConfig.mock.calls.length +
      spies.buildRemoteHandle.mock.calls.length +
      spies.refuse.mock.calls.length;
    // Remote arm: exactly one dep call (buildRemoteHandle).
    expect(total).toBe(1);
    expect(spies.buildRemoteHandle).toHaveBeenCalledTimes(1);
  });

  it('embedded arm: exactly two dep calls (load + start), no others', async () => {
    const { deps, spies } = makeDeps();
    const plan: BackendStartupPlan = {
      mode: 'embedded',
      embeddedReason: 'no_profile',
    };
    await executeBackendStartup(plan, deps);
    const total =
      spies.loadOrCreateServerConfig.mock.calls.length +
      spies.startEmbeddedAndPersistConfig.mock.calls.length +
      spies.buildRemoteHandle.mock.calls.length +
      spies.refuse.mock.calls.length;
    expect(total).toBe(2);
  });

  it('refuse arm: exactly one dep call (refuse), no others', async () => {
    const { deps, spies } = makeDeps();
    const plan: BackendStartupPlan = {
      mode: 'refuse',
      reason: 'profile_invalid',
      profileUrl: 'http://10.0.0.5:8080',
      classifyMessage: 'oops',
    };
    await expect(executeBackendStartup(plan, deps)).rejects.toThrow();
    const total =
      spies.loadOrCreateServerConfig.mock.calls.length +
      spies.startEmbeddedAndPersistConfig.mock.calls.length +
      spies.buildRemoteHandle.mock.calls.length +
      spies.refuse.mock.calls.length;
    expect(total).toBe(1);
  });
});
