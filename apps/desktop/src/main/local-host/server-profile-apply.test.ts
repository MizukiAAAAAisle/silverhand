import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonHostConfig, ServerConnectionProfile } from "@silverhand/shared";
import type { HostOutboundReloadResult } from "@silverhand/host";
import {
  applyServerProfile,
  derivePartialApplyState,
  reconcilePartialApplyAtBoot,
  type ApplyServerProfileDeps,
  type ServerProfileApplyOutcome,
} from "./server-profile-apply.js";

const profile: ServerConnectionProfile = {
  version: 3,
  server_url: "https://remote.test/",
  created_at: 100,
  updated_at: 500,
};
const reloaded = {
  reloaded: true,
  action: "reloaded",
  config_path: "/binding.json",
  host_id: "host",
} satisfies HostOutboundReloadResult;
function fixture() {
  const written: DaemonHostConfig[] = [];
  const write = vi.fn((config: DaemonHostConfig) => {
    written.push(config);
  });
  const reload = vi.fn<() => Promise<HostOutboundReloadResult>>().mockResolvedValue({
    ...reloaded,
    action: "unchanged",
  });
  const deps: ApplyServerProfileDeps = {
    writeDaemonHostConfig: write,
    hostOutboundReload: reload,
    currentLocalHostId: () => "host",
    currentHostToken: () => "main-secret",
    getAttachment: null,
  };
  return { deps, written, write, reload };
}
function derive(outcome: ServerProfileApplyOutcome) {
  return derivePartialApplyState(outcome, Date.now());
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());

describe("server profile application", () => {
  it("pre-claim application is a no-op without reading token/config or calling daemon", async () => {
    const f = fixture();
    f.deps.currentLocalHostId = () => null;
    f.deps.currentHostToken = () => {
      throw new Error("must not read binding");
    };
    const outcome = await applyServerProfile({ profile }, f.deps);
    expect(outcome).toEqual({ kind: "no_op_no_host_claim", profileVersion: 3 });
    expect(derive(outcome)).toEqual({ kind: "fully_applied" });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it("a claimed host with missing credentials remains pending, not a pre-auth no-op", async () => {
    const f = fixture();
    f.deps.currentHostToken = () => null;
    const outcome = await applyServerProfile({ profile }, f.deps);
    expect(derive(outcome)).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 3,
      reason: "host_token_missing",
      reloadRejectionReason: null,
      detail: "no host token in daemon-config for claimed host",
      lastAttemptAt: 1_000,
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it("writes each freshly committed generation, including unchanged URL, before reload reads it", async () => {
    const f = fixture();
    for (const version of [1, 2, 42]) {
      f.reload.mockImplementation(async () => {
        expect(f.written.at(-1)).toEqual({
          server_url: "https://remote.test/",
          host_id: "host",
          host_token: "main-secret",
          profile_version: version,
        });
        return { ...reloaded, action: "unchanged" };
      });
      const outcome = await applyServerProfile({ profile: { ...profile, version } }, f.deps);
      expect(outcome).toEqual({
        kind: "fully_applied",
        profileVersion: version,
        reloadKind: "unchanged",
        elapsedMs: 0,
      });
      expect(derive(outcome)).toEqual({ kind: "fully_applied" });
    }
    expect(f.written).toHaveLength(3);
    expect(f.reload).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("persists local insecure-remote opt-in alongside the committed generation", async () => {
    const f = fixture();
    f.deps.allowInsecureRemote = true;
    await applyServerProfile({ profile }, f.deps);
    expect(f.written).toEqual([
      {
        server_url: "https://remote.test/",
        host_id: "host",
        host_token: "main-secret",
        profile_version: 3,
        allow_insecure_remote: true,
      },
    ]);
  });

  it.each(["timestamp", "connection"] as const)(
    "captures %s before write/reload and observes real freshness",
    async (proof) => {
      const f = fixture();
      let current = { hostId: "host", connectionId: "old", attachedAt: 500 };
      f.deps.getAttachment = () => current;
      f.write.mockImplementation((config) => {
        f.written.push(config);
        current =
          proof === "timestamp"
            ? { ...current, attachedAt: 1_000 }
            : { ...current, connectionId: "new" };
        vi.setSystemTime(1_100);
      });
      f.reload.mockImplementation(async () => {
        vi.setSystemTime(1_200);
        return reloaded;
      });
      const pending = applyServerProfile({ profile }, f.deps);
      await vi.advanceTimersByTimeAsync(10_000);
      const outcome = await pending;
      expect(outcome).toEqual({
        kind: "fully_applied",
        profileVersion: 3,
        reloadKind: "reloaded",
        elapsedMs: 200,
      });
      expect(derive(outcome)).toEqual({ kind: "fully_applied" });
    },
  );

  it("real observation timeout leaves saved config fully applied but connectivity unverified", async () => {
    const f = fixture();
    f.deps.getAttachment = () => null;
    f.reload.mockResolvedValue(reloaded);
    const pending = applyServerProfile({ profile }, f.deps);
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;
    expect(outcome).toEqual({
      kind: "fully_applied",
      profileVersion: 3,
      reloadKind: "connectivity_unverified",
      elapsedMs: 10_000,
    });
    expect(derive(outcome)).toEqual({ kind: "fully_applied" });
    expect(f.written).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("write failure never calls daemon and each attempt gets its own timestamp", async () => {
    const f = fixture();
    f.write.mockImplementation(() => {
      throw new Error("disk full");
    });
    for (const timestamp of [1_000, 2_000]) {
      vi.setSystemTime(timestamp);
      expect(derive(await applyServerProfile({ profile }, f.deps))).toEqual({
        kind: "partial_apply_pending",
        profileVersion: 3,
        reason: "config_write_failed",
        reloadRejectionReason: null,
        detail: "disk full",
        lastAttemptAt: timestamp,
      });
    }
    expect(f.reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("transport failure preserves retry and the diagnostic after the config write", async () => {
    const f = fixture();
    f.reload.mockRejectedValue(new Error("socket closed"));
    expect(derive(await applyServerProfile({ profile }, f.deps))).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 3,
      reason: "reload_rejected",
      reloadRejectionReason: "not_attached",
      detail: "socket closed",
      lastAttemptAt: 1_000,
    });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["not_attached", "config_unreadable", "parse_failed", "invalid_server_url"] as const)(
    "preserves daemon rejection %s without claiming success",
    async (reason) => {
      const f = fixture();
      f.reload.mockResolvedValue({ reloaded: false, reason, message: "daemon diagnostic" });
      expect(derive(await applyServerProfile({ profile }, f.deps))).toEqual({
        kind: "partial_apply_pending",
        profileVersion: 3,
        reason: "reload_rejected",
        reloadRejectionReason: reason,
        detail: "daemon diagnostic",
        lastAttemptAt: 1_000,
      });
      expect(f.write).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("acknowledged swap with no observer is pending, not a fabricated observation timeout", async () => {
    const f = fixture();
    f.reload.mockResolvedValue(reloaded);
    expect(derive(await applyServerProfile({ profile }, f.deps))).toEqual({
      kind: "partial_apply_pending",
      profileVersion: 3,
      reason: "no_attachment_controller",
      reloadRejectionReason: null,
      detail: "backend HostWsServerController unavailable in this mode",
      lastAttemptAt: 1_000,
    });
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("boot reconciliation through real profile application", () => {
  it("corrupt profile is unusable and must not read or overwrite daemon config", async () => {
    const readDaemonHostConfig = vi.fn(() => {
      throw new Error("must not read config");
    });
    const applyProfile =
      vi.fn<(p: ServerConnectionProfile) => Promise<ServerProfileApplyOutcome>>();
    expect(
      await reconcilePartialApplyAtBoot({
        readProfile: () => ({ ok: false, reason: "parse_failed", detail: "invalid version" }),
        readDaemonHostConfig,
        applyProfile,
      }),
    ).toEqual({
      kind: "unusable_profile",
      reason: "parse_failed",
      detail: "invalid version",
      lastReadAt: 1_000,
    });
    expect(readDaemonHostConfig).not.toHaveBeenCalled();
    expect(applyProfile).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { server_url: "https://old.test", host_id: "host", host_token: "old", profile_version: 8 },
  ])("absent profile never reapplies stale daemon config %j", async (daemonConfig) => {
    const f = fixture();
    const applyProfile = vi.fn((p: ServerConnectionProfile) =>
      applyServerProfile({ profile: p }, f.deps),
    );
    expect(
      await reconcilePartialApplyAtBoot({
        readProfile: () => ({ ok: false, reason: "not_found" }),
        readDaemonHostConfig: () => daemonConfig,
        applyProfile,
      }),
    ).toEqual({ kind: "no_profile" });
    expect(applyProfile).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it.each(["matching", "absent", "older", "legacy"] as const)(
    "handles %s generation from authority",
    async (kind) => {
      const f = fixture();
      const applyProfile = vi.fn((p: ServerConnectionProfile) =>
        applyServerProfile({ profile: p }, f.deps),
      );
      const config =
        kind === "absent"
          ? null
          : {
              server_url: "https://old.test",
              host_id: "host",
              host_token: "old",
              ...(kind === "legacy" ? {} : { profile_version: kind === "matching" ? 3 : 2 }),
            };
      expect(
        await reconcilePartialApplyAtBoot({
          readProfile: () => ({ ok: true, profile }),
          readDaemonHostConfig: () => config,
          applyProfile,
        }),
      ).toEqual({ kind: "fully_applied" });
      if (kind === "matching") {
        expect(applyProfile).not.toHaveBeenCalled();
        expect(f.write).not.toHaveBeenCalled();
      } else {
        expect(f.written).toEqual([
          {
            server_url: "https://remote.test/",
            host_id: "host",
            host_token: "main-secret",
            profile_version: 3,
          },
        ]);
        expect(f.reload).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["missing-token", "rejected", "no-claim"] as const)(
    "boot drift preserves actual apply outcome: %s",
    async (kind) => {
      const f = fixture();
      if (kind === "missing-token") f.deps.currentHostToken = () => null;
      if (kind === "no-claim") f.deps.currentLocalHostId = () => null;
      if (kind === "rejected")
        f.reload.mockResolvedValue({
          reloaded: false,
          reason: "invalid_server_url",
          message: "bad URL",
        });
      const state = await reconcilePartialApplyAtBoot({
        readProfile: () => ({ ok: true, profile }),
        readDaemonHostConfig: () => null,
        applyProfile: (p) => applyServerProfile({ profile: p }, f.deps),
      });
      if (kind === "no-claim") expect(state).toEqual({ kind: "fully_applied" });
      else
        expect(state).toEqual({
          kind: "partial_apply_pending",
          profileVersion: 3,
          reason: kind === "missing-token" ? "host_token_missing" : "reload_rejected",
          reloadRejectionReason: kind === "missing-token" ? null : "invalid_server_url",
          detail:
            kind === "missing-token"
              ? "no host token in daemon-config for claimed host"
              : "bad URL",
          lastAttemptAt: 1_000,
        });
    },
  );
});
