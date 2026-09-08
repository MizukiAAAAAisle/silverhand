import { describe, expect, it } from "vitest";
import type { HostWsAttachment } from "@silverhand/backend";
import type { DaemonHostConfig, ServerConnectionProfile } from "@silverhand/shared";
import type { HostOutboundReloadResult } from "@silverhand/host";
import type {
  AttachWatchdogDeps,
  AttachWatchdogOutcome,
  ExpectedAttachWindow,
} from "./outbound-attach.js";
import {
  applyServerProfile,
  derivePartialApplyState,
  reconcilePartialApplyAtBoot,
  type PartialApplyState,
  type ApplyServerProfileDeps,
  type ServerProfileApplyOutcome,
  type ReconcilePartialApplyDeps,
} from "./server-profile-apply.js";
import type { ReadProfileResult } from "./server-connection-profile.js";

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
    hostId: "host-1",
    connectionId: "conn-old",
    attachedAt: 1_700_000_000_000,
    hostname: null,
    capabilities: [],
    ...overrides,
  };
}

function makeProfile(overrides?: Partial<ServerConnectionProfile>): ServerConnectionProfile {
  return {
    version: 3,
    server_url: "http://127.0.0.1:4321",
    created_at: 1_699_900_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

interface FakeOptions {
  writeThrows?: Error;
  reloadResult?: HostOutboundReloadResult;
  reloadThrows?: Error;
  /** Initial attachment snapshot. Profile application captures `previousConnectionId`
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
  deps: ApplyServerProfileDeps;
  state: FakeState;
} {
  const state: FakeState = {
    writeCalls: [],
    reloadCalls: 0,
    watchdogCalls: [],
  };
  const reloadResult: HostOutboundReloadResult = opts.reloadResult ?? {
    reloaded: true,
    action: "reloaded",
    config_path: "/fake/daemon-config.json",
    host_id: "host-1",
  };
  const hasController = opts.hasController ?? true;
  const deps: ApplyServerProfileDeps = {
    allowInsecureRemote: opts.allowInsecureRemote,
    writeDaemonHostConfig: (config) => {
      if (opts.writeThrows) throw opts.writeThrows;
      state.writeCalls.push(config);
    },
    hostOutboundReload: async () => {
      state.reloadCalls += 1;
      if (opts.reloadThrows) throw opts.reloadThrows;
      return reloadResult;
    },
    getAttachment: hasController ? (_id) => opts.attachment ?? null : null,
    currentLocalHostId: () => (opts.hostId === undefined ? "host-1" : opts.hostId),
    currentHostToken: () => (opts.hostToken === undefined ? "tok-1" : opts.hostToken),
    startWatchdog: (window, watchdogDeps) => {
      state.watchdogCalls.push({ window, deps: watchdogDeps });
      const outcome: AttachWatchdogOutcome = opts.watchdogOutcome ?? {
        ok: true,
        attachment: makeAttachment({
          connectionId: "conn-new",
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

describe("applyServerProfile — no_op_no_host_claim short-circuit", () => {
  it("returns no_op_no_host_claim when hostId is null (Setup Wizard pre-auth)", async () => {
    const { deps, state } = makeDeps({ hostId: null });
    const out = await applyServerProfile({ profile: makeProfile() }, deps);
    expect(out).toEqual({ kind: "no_op_no_host_claim", profileVersion: 3 });
    // Pre-auth path MUST NOT touch daemon-config or fire IPC.
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });

  it("does NOT read currentHostToken when hostId is null (pre-auth path is daemon-config-free)", async () => {
    const { deps, state } = makeDeps({ hostId: null });
    deps.currentHostToken = () => {
      throw new Error("currentHostToken must not be called when hostId is null");
    };
    const out = await applyServerProfile({ profile: makeProfile() }, deps);
    expect(out).toEqual({ kind: "no_op_no_host_claim", profileVersion: 3 });
    expect(state.writeCalls).toEqual([]);
  });

  it("returns partial_apply_pending/host_token_missing when hostId is set but hostToken is null", async () => {
    const { deps, state } = makeDeps({ hostId: "host-1", hostToken: null });
    const out = await applyServerProfile({ profile: makeProfile({ version: 7 }) }, deps);
    expect(out).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 7,
      reason: "host_token_missing",
      reloadRejectionReason: null,
      detail: "no host token in daemon-config for claimed host",
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
  it("derivePartialApplyState collapses no_op_no_host_claim to fully_applied", () => {
    const outcome: ServerProfileApplyOutcome = {
      kind: "no_op_no_host_claim",
      profileVersion: 7,
    };
    expect(derivePartialApplyState(outcome, 1_700_000_020_000)).toEqual({
      kind: "fully_applied",
    });
  });

  it("derivePartialApplyState carries through host_token_missing as partial_apply_pending", () => {
    const outcome: ServerProfileApplyOutcome = {
      kind: "partial_apply_pending",
      profileVersion: 4,
      reason: "host_token_missing",
      reloadRejectionReason: null,
      detail: "no host token in daemon-config for claimed host",
    };
    const state = derivePartialApplyState(outcome, 1_700_000_030_000);
    expect(state).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 4,
      reason: "host_token_missing",
      reloadRejectionReason: null,
      detail: "no host token in daemon-config for claimed host",
      lastAttemptAt: 1_700_000_030_000,
    } satisfies PartialApplyState);
  });
});

describe("applyServerProfile — fully_applied success arms", () => {
  it("returns fully_applied/reloaded when daemon swapped + watchdog observed fresh attachment", async () => {
    const { deps, state } = makeDeps({
      attachment: makeAttachment({ connectionId: "conn-old" }),
      watchdogOutcome: {
        ok: true,
        attachment: makeAttachment({ connectionId: "conn-new", attachedAt: 1_700_000_011_000 }),
        elapsedMs: 30,
      },
      now: () => 1_700_000_010_000,
    });
    const out = await applyServerProfile({ profile: makeProfile({ version: 5 }) }, deps);
    expect(out).toEqual({
      kind: "fully_applied",
      profileVersion: 5,
      reloadKind: "reloaded",
      // elapsedMs is `now() - startedAt` with our fixed clock = 0.
      elapsedMs: 0,
    });
    // profile_version stamped onto the daemon-config write.
    expect(state.writeCalls).toEqual([
      {
        server_url: "http://127.0.0.1:4321",
        host_id: "host-1",
        host_token: "tok-1",
        profile_version: 5,
      },
    ]);
    expect(state.reloadCalls).toBe(1);
    expect(state.watchdogCalls).toHaveLength(1);
    // Watchdog window inherits the pre-write snapshot.
    expect(state.watchdogCalls[0]!.window).toEqual({
      expectedHostId: "host-1",
      previousConnectionId: "conn-old",
      expectAttachSince: 1_700_000_010_000,
    });
  });

  it("returns fully_applied/unchanged when daemon kept the live client (fingerprint match)", async () => {
    const { deps, state } = makeDeps({
      reloadResult: {
        reloaded: true,
        action: "unchanged",
        config_path: "/fake/daemon-config.json",
        host_id: "host-1",
      },
    });
    const out = await applyServerProfile({ profile: makeProfile({ version: 9 }) }, deps);
    expect(out).toMatchObject({
      kind: "fully_applied",
      profileVersion: 9,
      reloadKind: "unchanged",
    });
    // Unchanged → no watchdog (daemon kept the live client).
    expect(state.watchdogCalls).toEqual([]);
  });

  it("returns fully_applied/connectivity_unverified when watchdog times out (config still saved)", async () => {
    const { deps, state } = makeDeps({
      watchdogOutcome: { ok: false, reason: "timeout", elapsedMs: 10_000 },
      now: () => 1_700_000_010_000,
    });
    const out = await applyServerProfile({ profile: makeProfile({ version: 4 }) }, deps);
    expect(out).toMatchObject({
      kind: "fully_applied",
      profileVersion: 4,
      reloadKind: "connectivity_unverified",
    });
    expect(state.writeCalls).toHaveLength(1);
    expect(state.watchdogCalls).toHaveLength(1);
  });
});

describe("applyServerProfile — partial_apply_pending failure arms", () => {
  it("returns partial_apply_pending/config_write_failed when atomic write throws", async () => {
    const { deps, state } = makeDeps({ writeThrows: new Error("ENOSPC: disk full") });
    const out = await applyServerProfile({ profile: makeProfile({ version: 6 }) }, deps);
    expect(out).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 6,
      reason: "config_write_failed",
      reloadRejectionReason: null,
      detail: "ENOSPC: disk full",
    });
    // Anchor: write failure MUST NOT fire reload IPC.
    expect(state.reloadCalls).toBe(0);
  });

  it("returns partial_apply_pending/reload_rejected/not_attached when IPC transport throws", async () => {
    const { deps } = makeDeps({ reloadThrows: new Error("socket closed") });
    const out = await applyServerProfile({ profile: makeProfile({ version: 8 }) }, deps);
    expect(out).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 8,
      reason: "reload_rejected",
      reloadRejectionReason: "not_attached",
      detail: "socket closed",
    });
  });

  it("passes through daemon-typed reload rejection (parse_failed) verbatim", async () => {
    const { deps } = makeDeps({
      reloadResult: {
        reloaded: false,
        reason: "parse_failed",
        message: "config JSON malformed",
      },
    });
    const out = await applyServerProfile({ profile: makeProfile({ version: 11 }) }, deps);
    expect(out).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 11,
      reason: "reload_rejected",
      reloadRejectionReason: "parse_failed",
      detail: "config JSON malformed",
    });
  });

  it("passes through daemon-typed invalid_server_url reload rejection", async () => {
    const { deps } = makeDeps({
      reloadResult: {
        reloaded: false,
        reason: "invalid_server_url",
        message: "daemon refused new server_url",
      },
    });
    const out = await applyServerProfile({ profile: makeProfile() }, deps);
    expect(out).toMatchObject({
      kind: "partial_apply_pending",
      reason: "reload_rejected",
      reloadRejectionReason: "invalid_server_url",
    });
  });

  it("returns partial_apply_pending/no_attachment_controller when controller is null after reload swap", async () => {
    const { deps, state } = makeDeps({ hasController: false });
    const out = await applyServerProfile({ profile: makeProfile({ version: 2 }) }, deps);
    expect(out).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 2,
      reason: "no_attachment_controller",
      reloadRejectionReason: null,
      detail: "backend HostWsServerController unavailable in this mode",
    });
    // Daemon DID ack the reload — but the renderer-observable state
    // is still "couldn't observe the post-reload attachment", so we
    // surface partial_apply_pending without watchdog poll spend.
    expect(state.reloadCalls).toBe(1);
    expect(state.watchdogCalls).toEqual([]);
  });
});

describe("applyServerProfile — profile_version stamping", () => {
  it("writes profile.version onto every daemon-config (1 → 1)", async () => {
    const { deps, state } = makeDeps();
    await applyServerProfile({ profile: makeProfile({ version: 1 }) }, deps);
    expect(state.writeCalls[0]?.profile_version).toBe(1);
  });

  it("writes profile.version even when probing a re-save with the same URL (idempotent bump)", async () => {
    // Save Settings twice with the same URL → daemon returns
    // `unchanged` second time → still write profile_version=2 because
    // every commit creates a new generation.
    const { deps, state } = makeDeps({
      reloadResult: {
        reloaded: true,
        action: "unchanged",
        config_path: "/fake/daemon-config.json",
        host_id: "host-1",
      },
    });
    await applyServerProfile({ profile: makeProfile({ version: 2 }) }, deps);
    expect(state.writeCalls[0]?.profile_version).toBe(2);
  });

  it("does NOT carry through a previous profile_version — application writes the current profile version", async () => {
    // No `currentProfileVersion` dep on the profile application interface — it is
    // by design. This pin codifies the §7.5 contract: profile application sets
    // profile_version unconditionally to profile.version.
    const { deps, state } = makeDeps();
    await applyServerProfile({ profile: makeProfile({ version: 42 }) }, deps);
    expect(state.writeCalls[0]).toEqual({
      server_url: "http://127.0.0.1:4321",
      host_id: "host-1",
      host_token: "tok-1",
      profile_version: 42,
    });
  });

  it("stamps allow_insecure_remote when the local client policy opted in", async () => {
    const { deps, state } = makeDeps({ allowInsecureRemote: true });
    await applyServerProfile({ profile: makeProfile({ version: 43 }) }, deps);
    expect(state.writeCalls[0]).toEqual({
      server_url: "http://127.0.0.1:4321",
      host_id: "host-1",
      host_token: "tok-1",
      profile_version: 43,
      allow_insecure_remote: true,
    });
  });
});

describe("applyServerProfile — order pinning (anchor cross-ref)", () => {
  it("snapshot is captured BEFORE write (watchdog accepts attachments stamped during reload)", async () => {
    const { deps, state } = makeDeps({
      attachment: makeAttachment({ connectionId: "conn-old" }),
      now: () => 1_700_000_010_000,
    });
    await applyServerProfile({ profile: makeProfile() }, deps);
    expect(state.watchdogCalls[0]!.window.expectAttachSince).toBe(1_700_000_010_000);
    expect(state.watchdogCalls[0]!.window.previousConnectionId).toBe("conn-old");
  });

  it("config_write_failed never fires the reload IPC (write-before-IPC anchor)", async () => {
    const { deps, state } = makeDeps({ writeThrows: new Error("EROFS: read-only fs") });
    await applyServerProfile({ profile: makeProfile() }, deps);
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });
});

describe("derivePartialApplyState — pure state-derivation helper", () => {
  it("collapses fully_applied (any reloadKind) to { kind: fully_applied }", () => {
    const outcomes: ServerProfileApplyOutcome[] = [
      { kind: "fully_applied", profileVersion: 1, reloadKind: "reloaded", elapsedMs: 12 },
      { kind: "fully_applied", profileVersion: 1, reloadKind: "unchanged", elapsedMs: 0 },
      {
        kind: "fully_applied",
        profileVersion: 1,
        reloadKind: "connectivity_unverified",
        elapsedMs: 10_000,
      },
    ];
    for (const outcome of outcomes) {
      expect(derivePartialApplyState(outcome, 1_700_000_020_000)).toEqual({
        kind: "fully_applied",
      });
    }
  });

  it("carries through partial_apply_pending fields verbatim with fresh lastAttemptAt", () => {
    const outcome: ServerProfileApplyOutcome = {
      kind: "partial_apply_pending",
      profileVersion: 9,
      reason: "reload_rejected",
      reloadRejectionReason: "config_unreadable",
      detail: "permission denied",
    };
    const state = derivePartialApplyState(outcome, 1_700_000_055_000);
    expect(state).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 9,
      reason: "reload_rejected",
      reloadRejectionReason: "config_unreadable",
      detail: "permission denied",
      lastAttemptAt: 1_700_000_055_000,
    } satisfies PartialApplyState);
  });

  it("lastAttemptAt updates per-attempt (not preserved across calls)", () => {
    const outcome: ServerProfileApplyOutcome = {
      kind: "partial_apply_pending",
      profileVersion: 1,
      reason: "config_write_failed",
      reloadRejectionReason: null,
      detail: "EIO",
    };
    const state1 = derivePartialApplyState(outcome, 1_700_000_001_000);
    const state2 = derivePartialApplyState(outcome, 1_700_000_002_000);
    if (state1.kind !== "partial_apply_pending") throw new Error("unreachable");
    if (state2.kind !== "partial_apply_pending") throw new Error("unreachable");
    expect(state1.lastAttemptAt).toBe(1_700_000_001_000);
    expect(state2.lastAttemptAt).toBe(1_700_000_002_000);
  });
});

interface ReconcileFakeState {
  applyCalls: ServerConnectionProfile[];
}

interface ReconcileFakeOptions {
  read: ReadProfileResult;
  daemonConfig: DaemonHostConfig | null;
  applyOutcome?: ServerProfileApplyOutcome;
  /** Defaults to fixed clock at 1_700_000_500_000. */
  now?: () => number;
}

function makeReconcileDeps(opts: ReconcileFakeOptions): {
  deps: ReconcilePartialApplyDeps;
  state: ReconcileFakeState;
} {
  const state: ReconcileFakeState = { applyCalls: [] };
  const applyOutcome: ServerProfileApplyOutcome = opts.applyOutcome ?? {
    kind: "fully_applied",
    profileVersion: 0,
    reloadKind: "reloaded",
    elapsedMs: 0,
  };
  const deps: ReconcilePartialApplyDeps = {
    readProfile: () => opts.read,
    readDaemonHostConfig: () => opts.daemonConfig,
    applyProfile: async (profile) => {
      state.applyCalls.push(profile);
      return applyOutcome;
    },
    now: opts.now ?? (() => 1_700_000_500_000),
  };
  return { deps, state };
}

describe("reconcilePartialApplyAtBoot — profile read failure → unusable_profile", () => {
  it("parse_failed → unusable_profile/parse_failed (detail propagated)", async () => {
    const { deps, state } = makeReconcileDeps({
      read: { ok: false, reason: "parse_failed", detail: "invalid version field" },
      daemonConfig: null,
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({
      kind: "unusable_profile",
      reason: "parse_failed",
      detail: "invalid version field",
      lastReadAt: 1_700_000_500_000,
    });
    expect(state.applyCalls).toEqual([]);
  });

  it("parse_failed + no daemon-config → still unusable_profile (NOT no_profile)", async () => {
    const { deps } = makeReconcileDeps({
      read: { ok: false, reason: "parse_failed", detail: "invalid profile" },
      daemonConfig: null,
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out.kind).toBe("unusable_profile");
  });
});

describe("reconcilePartialApplyAtBoot — no profile (not_found)", () => {
  it("not_found → no_profile", async () => {
    const { deps, state } = makeReconcileDeps({
      read: { ok: false, reason: "not_found" },
      daemonConfig: null,
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({ kind: "no_profile" });
    expect(state.applyCalls).toEqual([]);
  });

  // Even if a stale daemon-config exists from a previous claim, no
  // profile = no profile to apply. The daemon's running config will
  // be reconciled when the user next configures one (or signs in).
  it("not_found + stale daemon-config → no_profile (still no profile to reconcile)", async () => {
    const { deps, state } = makeReconcileDeps({
      read: { ok: false, reason: "not_found" },
      daemonConfig: {
        server_url: "http://127.0.0.1:4321",
        host_id: "host-1",
        host_token: "tok-1",
        profile_version: 5,
      },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({ kind: "no_profile" });
    expect(state.applyCalls).toEqual([]);
  });
});

describe("reconcilePartialApplyAtBoot — fast path: profile_version match", () => {
  it("profile.version === daemon.profile_version → fully_applied (no profile application)", async () => {
    const { deps, state } = makeReconcileDeps({
      read: { ok: true, profile: makeProfile({ version: 7 }) },
      daemonConfig: {
        server_url: "http://127.0.0.1:4321",
        host_id: "host-1",
        host_token: "tok-1",
        profile_version: 7,
      },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({ kind: "fully_applied" });
    expect(state.applyCalls).toEqual([]);
  });
});

describe("reconcilePartialApplyAtBoot — drift triggers profile application", () => {
  it("profile present + daemon-config absent → runs profile application with the read profile", async () => {
    const profile = makeProfile({ version: 4 });
    const { deps, state } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: null,
      applyOutcome: {
        kind: "fully_applied",
        profileVersion: 4,
        reloadKind: "reloaded",
        elapsedMs: 12,
      },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(state.applyCalls).toEqual([profile]);
    expect(out).toEqual({ kind: "fully_applied" });
  });

  it("profile_version mismatch → runs profile application (NOT fast-path)", async () => {
    const profile = makeProfile({ version: 9 });
    const { deps, state } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: {
        server_url: "http://127.0.0.1:4321",
        host_id: "host-1",
        host_token: "tok-1",
        profile_version: 8,
      },
    });
    await reconcilePartialApplyAtBoot(deps);
    expect(state.applyCalls).toEqual([profile]);
  });

  it("legacy daemon-config without profile_version → runs profile application (no fast-path)", async () => {
    const profile = makeProfile({ version: 1 });
    const { deps, state } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: {
        server_url: "http://127.0.0.1:4321",
        host_id: "host-1",
        host_token: "tok-1",
      },
    });
    await reconcilePartialApplyAtBoot(deps);
    expect(state.applyCalls).toEqual([profile]);
  });
});

describe("reconcilePartialApplyAtBoot — profile application failure → partial_apply_pending", () => {
  it("drift + profile application returns host_token_missing → partial_apply_pending preserves Retry", async () => {
    const profile = makeProfile({ version: 6 });
    const { deps } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: null, // claimed host but no token
      applyOutcome: {
        kind: "partial_apply_pending",
        profileVersion: 6,
        reason: "host_token_missing",
        reloadRejectionReason: null,
        detail: "no host token in daemon-config for claimed host",
      },
      now: () => 1_700_000_700_000,
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 6,
      reason: "host_token_missing",
      reloadRejectionReason: null,
      detail: "no host token in daemon-config for claimed host",
      lastAttemptAt: 1_700_000_700_000,
    } satisfies PartialApplyState);
  });

  it("drift + profile application returns reload_rejected → partial_apply_pending with daemon reason", async () => {
    const profile = makeProfile({ version: 2 });
    const { deps } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: {
        server_url: "http://127.0.0.1:4321",
        host_id: "host-1",
        host_token: "tok-1",
        profile_version: 1,
      },
      applyOutcome: {
        kind: "partial_apply_pending",
        profileVersion: 2,
        reason: "reload_rejected",
        reloadRejectionReason: "invalid_server_url",
        detail: "daemon refused new server_url",
      },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    if (out.kind !== "partial_apply_pending") throw new Error("unreachable");
    expect(out.reason).toBe("reload_rejected");
    expect(out.reloadRejectionReason).toBe("invalid_server_url");
  });

  it("drift + no claim → profile application returns no_op_no_host_claim → fully_applied", async () => {
    const profile = makeProfile({ version: 3 });
    const { deps } = makeReconcileDeps({
      read: { ok: true, profile },
      daemonConfig: null,
      applyOutcome: { kind: "no_op_no_host_claim", profileVersion: 3 },
    });
    const out = await reconcilePartialApplyAtBoot(deps);
    expect(out).toEqual({ kind: "fully_applied" });
  });
});
