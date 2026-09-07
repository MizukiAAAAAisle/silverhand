import { describe, expect, it } from 'vitest';
import type { HostWsAttachment } from '@silverhand/backend';
import type {
  DaemonHostConfig,
  ServerConnectionProfile,
} from '@silverhand/shared';
import type { HostOutboundReloadResult } from '@silverhand/host';
import type {
  AttachWatchdogDeps,
  AttachWatchdogOutcome,
  ExpectedAttachWindow,
} from './outbound-attach.js';
import {
  performProfilePhase2,
  derivePartialApplyState,
  reconcilePartialApplyAtBoot,
  type PartialApplyState,
  type PerformProfilePhase2Deps,
  type ProfilePhase2Outcome,
  type ReconcilePartialApplyDeps,
} from './profile-phase2.js';
import type { ReadProfileResult } from './server-connection-profile.js';

interface FakeState {
  writeCalls: DaemonHostConfig[];
  reloadCalls: number;
  watchdogCalls: {
    window: ExpectedAttachWindow;
    deps: AttachWatchdogDeps;
  }[];
}

function makeAttachment(overrides?: Partial<HostWsAttachment>): HostWsAttachment {
  return {
    hostId: 'host-1',
    connectionId: 'conn-old',
    attachedAt: 1_700_000_000_000,
    hostname: null,
    capabilities: [],
    ...overrides,
  };
}

function makeProfile(overrides?: Partial<ServerConnectionProfile>): ServerConnectionProfile {
  return {
    version: 3,
    server_url: 'http://127.0.0.1:4321',
    created_at: 1_699_900_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

interface FakeOptions {
  writeThrows?: Error;
  reloadResult?: HostOutboundReloadResult;
  reloadThrows?: Error;
  /** Initial attachment snapshot. Phase-2 captures `previousConnectionId`
   *  from this before the write. */
  attachment?: HostWsAttachment | null;
  /** When provided, watchdog resolves with this outcome immediately. */
  watchdogOutcome?: AttachWatchdogOutcome;
  /** undefined = default 'host-1'; null = explicit null (Setup Wizard pre-auth). */
  hostId?: string | null;
  /** undefined = default 'tok-1'; null = explicit null (revoked / pre-claim). */
  hostToken?: string | null;
  /** Local package/client opt-in to stamp into daemon-config. */
  allowInsecureRemote?: boolean;
  /** Pass `false` to drop the controller entirely (drives the
   *  `no_attachment_controller` arm). */
  hasController?: boolean;
  /** Defaults to a fixed clock starting at 1_700_000_010_000. */
  now?: () => number;
}

function makeDeps(opts: FakeOptions = {}): {
  deps: PerformProfilePhase2Deps;
  state: FakeState;
} {
  const state: FakeState = {
    writeCalls: [],
    reloadCalls: 0,
    watchdogCalls: [],
  };
  const reloadResult: HostOutboundReloadResult =
    opts.reloadResult ?? {
      reloaded: true,
      action: 'reloaded',
      config_path: '/fake/daemon-config.json',
      host_id: 'host-1',
    };
  const hasController = opts.hasController ?? true;
  const deps: PerformProfilePhase2Deps = {
    allowInsecureRemote: opts.allowInsecureRemote,
    writeDaemonHostConfig: config => {
      if (opts.writeThrows) throw opts.writeThrows;
      state.writeCalls.push(config);
    },
    hostOutboundReload: async () => {
      state.reloadCalls += 1;
      if (opts.reloadThrows) throw opts.reloadThrows;
      return reloadResult;
    },
    getAttachment: hasController ? _id => opts.attachment ?? null : null,
    currentLocalHostId: () => (opts.hostId === undefined ? 'host-1' : opts.hostId),
    currentHostToken: () => (opts.hostToken === undefined ? 'tok-1' : opts.hostToken),
    startWatchdog: (window, watchdogDeps) => {
      state.watchdogCalls.push({ window, deps: watchdogDeps });
      const outcome: AttachWatchdogOutcome =
        opts.watchdogOutcome ??
        {
          ok: true,
          attachment: makeAttachment({
            connectionId: 'conn-new',
            attachedAt: 1_700_000_011_000,
          }),
          elapsedMs: 30,
        };
      return {
        promise: Promise.resolve(outcome),
        abort: () => {},
      };
    },
    now: opts.now ?? (() => 1_700_000_010_000),
  };
  return { deps, state };
}

describe('performProfilePhase2 — no_op_no_host_claim short-circuit', () => {
  it('returns no_op_no_host_claim when hostId is null (Setup Wizard pre-auth)', async () => {
    const { deps, state } = makeDeps({ hostId: null });
    const out = await performProfilePhase2({ profile: makeProfile() }, deps);
    expect(out).toEqual({ kind: 'no_op_no_host_claim', profileVersion: 3 });
    // Pre-auth path MUST NOT touch daemon-config or fire IPC.
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });

  // Cindy 5c-2 review nit: the pre-auth path (`hostId === null`)
  // must short-circuit BEFORE reading `currentHostToken()`. Production
  // `currentHostToken` is null-safe, but the pre-auth path can be
  // called from contexts where daemon-config is structurally absent;
  // making it zero-touch on that path keeps the boundary clean.
  // Defended with a deps helper that throws if `currentHostToken` is
  // called — if a future regression re-orders the reads, this test
  // fails loud.
  it('does NOT read currentHostToken when hostId is null (pre-auth path is daemon-config-free)', async () => {
    const { deps, state } = makeDeps({ hostId: null });
    deps.currentHostToken = () => {
      throw new Error('currentHostToken must not be called when hostId is null');
    };
    const out = await performProfilePhase2({ profile: makeProfile() }, deps);
    expect(out).toEqual({ kind: 'no_op_no_host_claim', profileVersion: 3 });
    expect(state.writeCalls).toEqual([]);
  });

  // Cindy 5c-2 review P1 — flipped from the original test.
  // `hostId !== null && hostToken === null` is NOT the pre-auth path:
  // we have a claimed host on this desktop but daemon-config is
  // missing/corrupt/has no token. The profile commit upstream already
  // landed durable, so the daemon (if running) is on a stale config.
  // Surfacing this as `no_op_no_host_claim` (and thence `fully_applied`
  // via `derivePartialApplyState`) would silently mask real drift.
  // Must be `partial_apply_pending/host_token_missing` so UI shows
  // Retry + 5c-3 boot reconciliation can act on it.
  it('returns partial_apply_pending/host_token_missing when hostId is set but hostToken is null', async () => {
    const { deps, state } = makeDeps({ hostId: 'host-1', hostToken: null });
    const out = await performProfilePhase2({ profile: makeProfile({ version: 7 }) }, deps);
    expect(out).toEqual({
      kind: 'partial_apply_pending',
      profileVersion: 7,
      reason: 'host_token_missing',
      reloadRejectionReason: null,
      detail: 'no host token in daemon-config for claimed host',
    });
    // host_token_missing is detected BEFORE write — there's no token
    // to put in daemon-config, so we MUST NOT scribble a tokenless
    // config or fire reload IPC.
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });

  // Distinct-from-partial-apply-pending pin: the typed kind matters.
  // Same `state.kind` for "fully_applied" + "no_op_no_host_claim" is
  // by design — both mean "nothing to reconcile".
  it('derivePartialApplyState collapses no_op_no_host_claim to fully_applied', () => {
    const outcome: ProfilePhase2Outcome = {
      kind: 'no_op_no_host_claim',
      profileVersion: 7,
    };
    expect(derivePartialApplyState(outcome, 1_700_000_020_000)).toEqual({
      kind: 'fully_applied',
    });
  });

  // Cindy 5c-2 review P1 — explicit pin: host_token_missing must
  // NOT collapse to fully_applied. If `derivePartialApplyState`
  // grew a default-collapse arm in the future, this pins the
  // boundary.
  it('derivePartialApplyState carries through host_token_missing as partial_apply_pending', () => {
    const outcome: ProfilePhase2Outcome = {
      kind: 'partial_apply_pending',
      profileVersion: 4,
      reason: 'host_token_missing',
      reloadRejectionReason: null,
      detail: 'no host token in daemon-config for claimed host',
    };
    const state = derivePartialApplyState(outcome, 1_700_000_030_000);
    expect(state).toEqual({
      kind: 'partial_apply_pending',
      profileVersion: 4,
      reason: 'host_token_missing',
      reloadRejectionReason: null,
      detail: 'no host token in daemon-config for claimed host',
      lastAttemptAt: 1_700_000_030_000,
    } satisfies PartialApplyState);
  });
});

describe('performProfilePhase2 — fully_applied success arms', () => {
  it('returns fully_applied/reloaded when daemon swapped + watchdog observed fresh attachment', async () => {
    const { deps, state } = makeDeps({
      attachment: makeAttachment({ connectionId: 'conn-old' }),
      watchdogOutcome: {
        ok: true,
        attachment: makeAttachment({ connectionId: 'conn-new', attachedAt: 1_700_000_011_000 }),
        elapsedMs: 30,
      },
      now: () => 1_700_000_010_000,
    });
    const out = await performProfilePhase2({ profile: makeProfile({ version: 5 }) }, deps);
    expect(out).toEqual({
      kind: 'fully_applied',
      profileVersion: 5,
      reloadKind: 'reloaded',
      // elapsedMs is `now() - startedAt` with our fixed clock = 0.
      elapsedMs: 0,
    });
    // profile_version stamped onto the daemon-config write.
    expect(state.writeCalls).toEqual([
      {
        server_url: 'http://127.0.0.1:4321',
        host_id: 'host-1',
        host_token: 'tok-1',
        profile_version: 5,
      },
    ]);
    expect(state.reloadCalls).toBe(1);
    expect(state.watchdogCalls).toHaveLength(1);
    // Watchdog window inherits the pre-write snapshot.
    expect(state.watchdogCalls[0]!.window).toEqual({
      expectedHostId: 'host-1',
      previousConnectionId: 'conn-old',
      expectAttachSince: 1_700_000_010_000,
    });
  });

  it('returns fully_applied/unchanged when daemon kept the live client (fingerprint match)', async () => {
    const { deps, state } = makeDeps({
      reloadResult: {
        reloaded: true,
        action: 'unchanged',
        config_path: '/fake/daemon-config.json',
        host_id: 'host-1',
      },
    });
    const out = await performProfilePhase2({ profile: makeProfile({ version: 9 }) }, deps);
    expect(out).toMatchObject({
      kind: 'fully_applied',
      profileVersion: 9,
      reloadKind: 'unchanged',
    });
    // Unchanged → no watchdog (daemon kept the live client).
    expect(state.watchdogCalls).toEqual([]);
  });

  it('returns fully_applied/connectivity_unverified when watchdog times out (config still saved)', async () => {
    const { deps, state } = makeDeps({
      watchdogOutcome: { ok: false, reason: 'timeout', elapsedMs: 10_000 },
      now: () => 1_700_000_010_000,
    });
    const out = await performProfilePhase2({ profile: makeProfile({ version: 4 }) }, deps);
    // §7.5: watchdog timeout is success-arm — config IS saved, the
    // user just may not be reachable yet.
    expect(out).toMatchObject({
      kind: 'fully_applied',
      profileVersion: 4,
      reloadKind: 'connectivity_unverified',
    });
    expect(state.writeCalls).toHaveLength(1);
    expect(state.watchdogCalls).toHaveLength(1);
  });
});

describe('performProfilePhase2 — partial_apply_pending failure arms', () => {
  it('returns partial_apply_pending/config_write_failed when atomic write throws', async () => {
    const { deps, state } = makeDeps({ writeThrows: new Error('ENOSPC: disk full') });
    const out = await performProfilePhase2({ profile: makeProfile({ version: 6 }) }, deps);
    expect(out).toEqual({
      kind: 'partial_apply_pending',
      profileVersion: 6,
      reason: 'config_write_failed',
      reloadRejectionReason: null,
      detail: 'ENOSPC: disk full',
    });
    // Anchor: write failure MUST NOT fire reload IPC.
    expect(state.reloadCalls).toBe(0);
  });

  it('returns partial_apply_pending/reload_rejected/not_attached when IPC transport throws', async () => {
    const { deps } = makeDeps({ reloadThrows: new Error('socket closed') });
    const out = await performProfilePhase2({ profile: makeProfile({ version: 8 }) }, deps);
    expect(out).toEqual({
      kind: 'partial_apply_pending',
      profileVersion: 8,
      reason: 'reload_rejected',
      reloadRejectionReason: 'not_attached',
      detail: 'socket closed',
    });
  });

  it('passes through daemon-typed reload rejection (parse_failed) verbatim', async () => {
    const { deps } = makeDeps({
      reloadResult: {
        reloaded: false,
        reason: 'parse_failed',
        message: 'config JSON malformed',
      },
    });
    const out = await performProfilePhase2({ profile: makeProfile({ version: 11 }) }, deps);
    expect(out).toEqual({
      kind: 'partial_apply_pending',
      profileVersion: 11,
      reason: 'reload_rejected',
      reloadRejectionReason: 'parse_failed',
      detail: 'config JSON malformed',
    });
  });

  it('passes through daemon-typed invalid_server_url reload rejection', async () => {
    const { deps } = makeDeps({
      reloadResult: {
        reloaded: false,
        reason: 'invalid_server_url',
        message: 'daemon refused new server_url',
      },
    });
    const out = await performProfilePhase2({ profile: makeProfile() }, deps);
    expect(out).toMatchObject({
      kind: 'partial_apply_pending',
      reason: 'reload_rejected',
      reloadRejectionReason: 'invalid_server_url',
    });
  });

  it('returns partial_apply_pending/no_attachment_controller when controller is null after reload swap', async () => {
    const { deps, state } = makeDeps({ hasController: false });
    const out = await performProfilePhase2({ profile: makeProfile({ version: 2 }) }, deps);
    expect(out).toEqual({
      kind: 'partial_apply_pending',
      profileVersion: 2,
      reason: 'no_attachment_controller',
      reloadRejectionReason: null,
      detail: 'backend HostWsServerController unavailable in this mode',
    });
    // Daemon DID ack the reload — but the renderer-observable state
    // is still "couldn't observe the post-reload attachment", so we
    // surface partial_apply_pending without watchdog poll spend.
    expect(state.reloadCalls).toBe(1);
    expect(state.watchdogCalls).toEqual([]);
  });
});

describe('performProfilePhase2 — profile_version stamping', () => {
  it('writes profile.version onto every daemon-config (1 → 1)', async () => {
    const { deps, state } = makeDeps();
    await performProfilePhase2({ profile: makeProfile({ version: 1 }) }, deps);
    expect(state.writeCalls[0]?.profile_version).toBe(1);
  });

  it('writes profile.version even when probing a re-save with the same URL (idempotent bump)', async () => {
    // Save Settings twice with the same URL → daemon returns
    // `unchanged` second time → still write profile_version=2 because
    // every commit creates a new generation.
    const { deps, state } = makeDeps({
      reloadResult: {
        reloaded: true,
        action: 'unchanged',
        config_path: '/fake/daemon-config.json',
        host_id: 'host-1',
      },
    });
    await performProfilePhase2({ profile: makeProfile({ version: 2 }) }, deps);
    expect(state.writeCalls[0]?.profile_version).toBe(2);
  });

  it('does NOT carry through a previous profile_version — phase-2 is the bumper', async () => {
    // No `currentProfileVersion` dep on the phase-2 interface — it is
    // by design. This pin codifies the §7.5 contract: phase-2 sets
    // profile_version unconditionally to profile.version.
    const { deps, state } = makeDeps();
    await performProfilePhase2({ profile: makeProfile({ version: 42 }) }, deps);
    expect(state.writeCalls[0]).toEqual({
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-1',
      host_token: 'tok-1',
      profile_version: 42,
    });
  });

  it('stamps allow_insecure_remote when the local client policy opted in', async () => {
    const { deps, state } = makeDeps({ allowInsecureRemote: true });
    await performProfilePhase2({ profile: makeProfile({ version: 43 }) }, deps);
    expect(state.writeCalls[0]).toEqual({
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-1',
      host_token: 'tok-1',
      profile_version: 43,
      allow_insecure_remote: true,
    });
  });
});

describe('performProfilePhase2 — order pinning (anchor cross-ref)', () => {
  it('snapshot is captured BEFORE write (watchdog accepts attachments stamped during reload)', async () => {
    // The watchdog window's `expectAttachSince` MUST equal `now()` at
    // phase-2 entry, not after write. Concretely: a daemon that
    // attaches the new bytes in the gap between IPC send and IPC ack
    // (so attachedAt < expectAttachSince would otherwise be possible)
    // is still admitted via the `previousConnectionId` branch.
    const { deps, state } = makeDeps({
      attachment: makeAttachment({ connectionId: 'conn-old' }),
      now: () => 1_700_000_010_000,
    });
    await performProfilePhase2({ profile: makeProfile() }, deps);
    expect(state.watchdogCalls[0]!.window.expectAttachSince).toBe(1_700_000_010_000);
    expect(state.watchdogCalls[0]!.window.previousConnectionId).toBe('conn-old');
  });

  it('config_write_failed never fires the reload IPC (write-before-IPC anchor)', async () => {
    const { deps, state } = makeDeps({ writeThrows: new Error('EROFS: read-only fs') });
    await performProfilePhase2({ profile: makeProfile() }, deps);
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });
});

describe('derivePartialApplyState — pure state-derivation helper', () => {
  it('collapses fully_applied (any reloadKind) to { kind: fully_applied }', () => {
    const outcomes: ProfilePhase2Outcome[] = [
      { kind: 'fully_applied', profileVersion: 1, reloadKind: 'reloaded', elapsedMs: 12 },
      { kind: 'fully_applied', profileVersion: 1, reloadKind: 'unchanged', elapsedMs: 0 },
      {
        kind: 'fully_applied',
        profileVersion: 1,
        reloadKind: 'connectivity_unverified',
        elapsedMs: 10_000,
      },
    ];
    for (const outcome of outcomes) {
      expect(derivePartialApplyState(outcome, 1_700_000_020_000)).toEqual({
        kind: 'fully_applied',
      });
    }
  });

  it('carries through partial_apply_pending fields verbatim with fresh lastAttemptAt', () => {
    const outcome: ProfilePhase2Outcome = {
      kind: 'partial_apply_pending',
      profileVersion: 9,
      reason: 'reload_rejected',
      reloadRejectionReason: 'config_unreadable',
      detail: 'permission denied',
    };
    const state = derivePartialApplyState(outcome, 1_700_000_055_000);
    expect(state).toEqual({
      kind: 'partial_apply_pending',
      profileVersion: 9,
      reason: 'reload_rejected',
      reloadRejectionReason: 'config_unreadable',
      detail: 'permission denied',
      lastAttemptAt: 1_700_000_055_000,
    } satisfies PartialApplyState);
  });

  it('lastAttemptAt updates per-attempt (not preserved across calls)', () => {
    const outcome: ProfilePhase2Outcome = {
      kind: 'partial_apply_pending',
      profileVersion: 1,
      reason: 'config_write_failed',
      reloadRejectionReason: null,
      detail: 'EIO',
    };
    const state1 = derivePartialApplyState(outcome, 1_700_000_001_000);
    const state2 = derivePartialApplyState(outcome, 1_700_000_002_000);
    if (state1.kind !== 'partial_apply_pending') throw new Error('unreachable');
    if (state2.kind !== 'partial_apply_pending') throw new Error('unreachable');
    expect(state1.lastAttemptAt).toBe(1_700_000_001_000);
    expect(state2.lastAttemptAt).toBe(1_700_000_002_000);
  });
});

/**
 * D4.a Commit 5c-3 — `reconcilePartialApplyAtBoot` tests.
 *
 * Cindy 5c-3 review baseline (4 gates):
 *   1. profile read failure ⇒ `unusable_profile`
 *   2. daemon-config absent + profile present ⇒ NOT direct success
 *   3. auto-retry failure ⇒ `partial_apply_pending` + Retry preserved
 *   4. bootstrap trigger doesn't block embedded startup (verified at
 *      the call site in `index.ts`; reconcile itself is unit-tested
 *      against substituted phase-2 deps)
 *
 * Strategy: substitute phase-2 with a deterministic stub that
 * records the inputs it received. Reconcile becomes a pure
 * orchestration test driven by the (profile-read, daemon-config,
 * phase-2-outcome) triple.
 */
interface ReconcileFakeState {
  phase2Calls: ServerConnectionProfile[];
}

interface ReconcileFakeOptions {
  read: ReadProfileResult;
  daemonConfig: DaemonHostConfig | null;
  phase2Outcome?: ProfilePhase2Outcome;
  /** Defaults to fixed clock at 1_700_000_500_000. */
  now?: () => number;
}

function makeReconcileDeps(opts: ReconcileFakeOptions): {
  deps: ReconcilePartialApplyDeps;
  state: ReconcileFakeState;
} {
  const state: ReconcileFakeState = { phase2Calls: [] };
  const phase2Outcome: ProfilePhase2Outcome =
    opts.phase2Outcome ??
    {
      kind: 'fully_applied',
      profileVersion: 0,
      reloadKind: 'reloaded',
      elapsedMs: 0,
    };
  const deps: ReconcilePartialApplyDeps = {
    readProfile: () => opts.read,
    readDaemonHostConfig: () => opts.daemonConfig,
    runPhase2: async profile => {
      state.phase2Calls.push(profile);
      return phase2Outcome;
    },
    now: opts.now ?? (() => 1_700_000_500_000),
  };
  return { deps, state };
}

describe('reconcilePartialApplyAtBoot — Cindy gate 1: profile read failure → unusable_profile', () => {
  it('parse_failed → unusable_profile/parse_failed (detail propagated)', async () => {
    const { deps, state } = makeReconcileDeps({
      read: { ok: false, reason: 'parse_failed', detail: 'invalid version field' },
      daemonConfig: null,
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({
      kind: 'unusable_profile',
      reason: 'parse_failed',
      detail: 'invalid version field',
      lastReadAt: 1_700_000_500_000,
    });
    expect(state.phase2Calls).toEqual([]);
  });

  // Distinct-from-no_profile pin: even if the daemon-config is
  // ALSO absent (so the cheap inference might be "nothing
  // configured"), an unreadable profile file is still
  // `unusable_profile`. Cindy 5c-1 note explicitly forbade
  // collapsing to `<none>` / `no_profile` here.
  it('parse_failed + no daemon-config → still unusable_profile (NOT no_profile)', async () => {
    const { deps } = makeReconcileDeps({
      read: { ok: false, reason: 'parse_failed', detail: 'invalid profile' },
      daemonConfig: null,
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out.kind).toBe('unusable_profile');
  });
});

describe('reconcilePartialApplyAtBoot — no profile (not_found)', () => {
  it('not_found → no_profile', async () => {
    const { deps, state } = makeReconcileDeps({
      read: { ok: false, reason: 'not_found' },
      daemonConfig: null,
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({ kind: 'no_profile' });
    expect(state.phase2Calls).toEqual([]);
  });

  // Even if a stale daemon-config exists from a previous claim, no
  // profile = no profile to apply. The daemon's running config will
  // be reconciled when the user next configures one (or signs in).
  it('not_found + stale daemon-config → no_profile (still no profile to reconcile)', async () => {
    const { deps, state } = makeReconcileDeps({
      read: { ok: false, reason: 'not_found' },
      daemonConfig: {
        server_url: 'http://127.0.0.1:4321',
        host_id: 'host-1',
        host_token: 'tok-1',
        profile_version: 5,
      },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({ kind: 'no_profile' });
    expect(state.phase2Calls).toEqual([]);
  });
});

describe('reconcilePartialApplyAtBoot — fast path: profile_version match', () => {
  it('profile.version === daemon.profile_version → fully_applied (no phase-2)', async () => {
    const { deps, state } = makeReconcileDeps({
      read: { ok: true, profile: makeProfile({ version: 7 }) },
      daemonConfig: {
        server_url: 'http://127.0.0.1:4321',
        host_id: 'host-1',
        host_token: 'tok-1',
        profile_version: 7,
      },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({ kind: 'fully_applied' });
    // Fast-path: skip the phase-2 IPC roundtrip when there's
    // demonstrably no drift.
    expect(state.phase2Calls).toEqual([]);
  });
});

describe('reconcilePartialApplyAtBoot — Cindy gate 2: drift triggers phase-2', () => {
  // The phase-2 orchestrator owns the sub-cases (claim absent vs
  // claim present + token absent vs full mismatch); reconcile just
  // delegates. These tests pin the dispatch — that reconcile DOES
  // call phase-2 with the right profile and routes the outcome
  // through `derivePartialApplyState`.
  it('profile present + daemon-config absent → runs phase-2 with the read profile', async () => {
    const profile = makeProfile({ version: 4 });
    const { deps, state } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: null,
      phase2Outcome: {
        kind: 'fully_applied',
        profileVersion: 4,
        reloadKind: 'reloaded',
        elapsedMs: 12,
      },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(state.phase2Calls).toEqual([profile]);
    expect(out).toEqual({ kind: 'fully_applied' });
  });

  it('profile_version mismatch → runs phase-2 (NOT fast-path)', async () => {
    const profile = makeProfile({ version: 9 });
    const { deps, state } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: {
        server_url: 'http://127.0.0.1:4321',
        host_id: 'host-1',
        host_token: 'tok-1',
        profile_version: 8,
      },
    });
    await reconcilePartialApplyAtBoot(deps);
    expect(state.phase2Calls).toEqual([profile]);
  });

  // Legacy D3.x daemon-config has no `profile_version` field; it
  // can't match anything (`undefined !== profile.version`), so we
  // fall through to phase-2 to re-derive — never fast-path-skip.
  it('legacy daemon-config without profile_version → runs phase-2 (no fast-path)', async () => {
    const profile = makeProfile({ version: 1 });
    const { deps, state } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: {
        server_url: 'http://127.0.0.1:4321',
        host_id: 'host-1',
        host_token: 'tok-1',
        // intentionally no profile_version field
      },
    });
    await reconcilePartialApplyAtBoot(deps);
    expect(state.phase2Calls).toEqual([profile]);
  });
});

describe('reconcilePartialApplyAtBoot — Cindy gate 3: phase-2 failure → partial_apply_pending', () => {
  it('drift + phase-2 returns host_token_missing → partial_apply_pending preserves Retry', async () => {
    const profile = makeProfile({ version: 6 });
    const { deps } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: null, // claimed host but no token
      phase2Outcome: {
        kind: 'partial_apply_pending',
        profileVersion: 6,
        reason: 'host_token_missing',
        reloadRejectionReason: null,
        detail: 'no host token in daemon-config for claimed host',
      },
      now: () => 1_700_000_700_000,
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({
      kind: 'partial_apply_pending',
      profileVersion: 6,
      reason: 'host_token_missing',
      reloadRejectionReason: null,
      detail: 'no host token in daemon-config for claimed host',
      lastAttemptAt: 1_700_000_700_000,
    } satisfies PartialApplyState);
  });

  it('drift + phase-2 returns reload_rejected → partial_apply_pending with daemon reason', async () => {
    const profile = makeProfile({ version: 2 });
    const { deps } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: {
        server_url: 'http://127.0.0.1:4321',
        host_id: 'host-1',
        host_token: 'tok-1',
        profile_version: 1,
      },
      phase2Outcome: {
        kind: 'partial_apply_pending',
        profileVersion: 2,
        reason: 'reload_rejected',
        reloadRejectionReason: 'invalid_server_url',
        detail: 'daemon refused new server_url',
      },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    if (out.kind !== 'partial_apply_pending') throw new Error('unreachable');
    expect(out.reason).toBe('reload_rejected');
    expect(out.reloadRejectionReason).toBe('invalid_server_url');
  });

  // Cindy 5c-3 gate 3 explicit pin: NO_OP_NO_HOST_CLAIM (e.g. profile
  // present but no claim yet) collapses to `fully_applied` via
  // `derivePartialApplyState`. Verify that drift ⇒ phase-2 ⇒
  // `no_op_no_host_claim` ⇒ `fully_applied` reaches the right state.
  it('drift + no claim → phase-2 returns no_op_no_host_claim → fully_applied', async () => {
    const profile = makeProfile({ version: 3 });
    const { deps } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: null,
      phase2Outcome: { kind: 'no_op_no_host_claim', profileVersion: 3 },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({ kind: 'fully_applied' });
  });
});
