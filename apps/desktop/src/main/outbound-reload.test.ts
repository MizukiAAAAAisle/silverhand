import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonHostConfig } from "@silverhand/shared";
import type { HostOutboundReloadResult } from "@silverhand/host";
import {
  performOutboundReload,
  bindAttachmentAccessor,
  type PerformOutboundReloadDeps,
} from "./outbound-reload.js";
import type { OutboundAttachmentSnapshot } from "./outbound-attach.js";

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
  const deps: PerformOutboundReloadDeps = {
    writeDaemonHostConfig: write,
    hostOutboundReload: reload,
    getAttachment: null,
    currentLocalHostId: () => "host",
    currentHostToken: () => "main-secret",
    currentProfileVersion: () => undefined,
  };
  return { deps, written, write, reload };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());

describe("outbound reload", () => {
  it.each([
    ["__bad__", "malformed_url"],
    ["http://remote.test", "insecure_remote_http_disallowed"],
    ["ws://127.0.0.1", "unsupported_scheme"],
  ])("rejects real raw input %s before writing or calling daemon", async (serverUrl, reason) => {
    const f = fixture();
    expect(await performOutboundReload({ serverUrl }, f.deps)).toMatchObject({
      ok: false,
      kind: "classify_rejected",
      reason,
      message: expect.any(String),
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it.each([
    { raw: "HTTP://127.0.0.1:80/", normalized: "http://127.0.0.1/", insecure: false },
    { raw: "HTTPS://REMOTE.test:443/", normalized: "https://remote.test/", insecure: false },
    { raw: "http://remote.test:8080", normalized: "http://remote.test:8080/", insecure: true },
  ])(
    "writes main credentials and normalized $raw before daemon reads",
    async ({ raw, normalized, insecure }) => {
      const f = fixture();
      f.deps.allowInsecureRemote = insecure;
      const expected = {
        server_url: normalized,
        host_id: "host",
        host_token: "main-secret",
        ...(insecure ? { allow_insecure_remote: true } : {}),
      };
      f.reload.mockImplementation(async () => {
        expect(f.written).toEqual([expected]);
        return { ...reloaded, action: "unchanged" };
      });
      expect(await performOutboundReload({ serverUrl: raw }, f.deps)).toEqual({
        ok: true,
        kind: "unchanged",
      });
      expect(f.reload).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["claim", "token"] as const)(
    "missing %s cannot overwrite config or reload",
    async (missing) => {
      const f = fixture();
      if (missing === "claim") f.deps.currentLocalHostId = () => null;
      else f.deps.currentHostToken = () => null;
      expect(
        await performOutboundReload({ serverUrl: "https://remote.test" }, f.deps),
      ).toMatchObject({
        ok: false,
        kind: "reload_rejected",
        reason: "not_attached",
      });
      expect(f.write).not.toHaveBeenCalled();
      expect(f.reload).not.toHaveBeenCalled();
    },
  );

  it("write failure retains its diagnostic and prevents reload", async () => {
    const f = fixture();
    f.write.mockImplementation(() => {
      throw new Error("read-only binding");
    });
    expect(await performOutboundReload({ serverUrl: "https://remote.test" }, f.deps)).toEqual({
      ok: false,
      kind: "config_write_failed",
      message: "read-only binding",
    });
    expect(f.reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["not_attached", "config_unreadable", "parse_failed", "invalid_server_url"] as const)(
    "preserves daemon %s reason and diagnostic without starting observation",
    async (reason) => {
      const f = fixture();
      f.reload.mockResolvedValue({ reloaded: false, reason, message: "daemon diagnostic" });
      expect(await performOutboundReload({ serverUrl: "https://remote.test" }, f.deps)).toEqual({
        ok: false,
        kind: "reload_rejected",
        reason,
        message: "daemon diagnostic",
      });
      expect(f.write).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses the daemon reason as fallback when no message was supplied", async () => {
    const f = fixture();
    f.reload.mockResolvedValue({ reloaded: false, reason: "parse_failed" });
    expect(await performOutboundReload({ serverUrl: "https://remote.test" }, f.deps)).toEqual({
      ok: false,
      kind: "reload_rejected",
      reason: "parse_failed",
      message: "parse_failed",
    });
  });

  it("transport failure is not an acknowledged reload", async () => {
    const f = fixture();
    f.reload.mockRejectedValue(new Error("socket closed"));
    expect(await performOutboundReload({ serverUrl: "https://remote.test" }, f.deps)).toEqual({
      ok: false,
      kind: "reload_rejected",
      reason: "not_attached",
      message: "socket closed",
    });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("unchanged config needs no polling (observer=%s)", async (observer) => {
    const f = fixture();
    f.deps.getAttachment = bindAttachmentAccessor(observer ? { getAttachment: () => null } : null);
    expect(await performOutboundReload({ serverUrl: "https://remote.test" }, f.deps)).toEqual({
      ok: true,
      kind: "unchanged",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])(
    "missing observer remains distinct from connectivity timeout (remote=%s)",
    async (remoteMode) => {
      const f = fixture();
      f.deps.getAttachment = bindAttachmentAccessor(null);
      f.deps.remoteMode = remoteMode;
      f.reload.mockResolvedValue(reloaded);
      const outcome = await performOutboundReload({ serverUrl: "https://remote.test" }, f.deps);
      expect(outcome).toMatchObject(
        remoteMode
          ? { ok: true, kind: "reloaded_remote" }
          : { ok: false, kind: "no_attachment_controller" },
      );
      expect(f.write).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["timestamp", "connection"] as const)(
    "freezes pre-write %s evidence before the registry changes",
    async (proof) => {
      const f = fixture();
      let current = { hostId: "host", connectionId: "old", attachedAt: 500 };
      f.deps.getAttachment = bindAttachmentAccessor({ getAttachment: () => current });
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
      const result = performOutboundReload({ serverUrl: "https://remote.test" }, f.deps);
      // A late snapshot fails real observation and reaches timeout; no fake
      // watchdog supplies the success we expect.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toEqual({
        ok: true,
        kind: "reloaded",
        elapsedMs: 0,
        attachedAt: proof === "timestamp" ? 1_000 : 500,
      });
    },
  );

  it("reports actual poll latency and the observed attachment, not the IPC acknowledgement", async () => {
    const f = fixture();
    let current: OutboundAttachmentSnapshot | null = null;
    f.deps.getAttachment = bindAttachmentAccessor({ getAttachment: () => current });
    f.reload.mockResolvedValue(reloaded);
    const pending = performOutboundReload({ serverUrl: "https://remote.test" }, f.deps);
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();
    current = { hostId: "host", connectionId: "new", attachedAt: 1_249 };
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({
      ok: true,
      kind: "reloaded",
      elapsedMs: 250,
      attachedAt: 1_249,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("acknowledged saved config times out as connectivity_unverified, not save failure", async () => {
    const f = fixture();
    f.deps.getAttachment = () => null;
    f.reload.mockResolvedValue(reloaded);
    const pending = performOutboundReload({ serverUrl: "https://remote.test" }, f.deps);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ ok: true, kind: "connectivity_unverified", elapsedMs: 10_000 });
    expect(f.written).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["present", "missing", "unwired"] as const)(
    "preserves profile generation for %s legacy config",
    async (kind) => {
      const f = fixture();
      if (kind === "present") f.deps.currentProfileVersion = () => 7;
      if (kind === "unwired") delete f.deps.currentProfileVersion;
      await performOutboundReload({ serverUrl: "https://remote.test" }, f.deps);
      expect(f.written).toEqual([
        {
          server_url: "https://remote.test/",
          host_id: "host",
          host_token: "main-secret",
          ...(kind === "present" ? { profile_version: 7 } : {}),
        },
      ]);
      if (kind !== "present") expect(f.written[0]).not.toHaveProperty("profile_version");
    },
  );
});
