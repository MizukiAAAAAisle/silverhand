import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClientError, type HostClient } from "@silverhand/host";
import { waitForDaemonGeneration } from "../local-host/daemon-generation-attach.js";

// The gate owns identity/deadline policy; HostClient's wire negotiation is
// covered in packages/host/tests/host-client.test.ts.
function fixture() {
  let instanceId: string | null = null;
  const listeners = new Set<() => void>();
  const connect = vi.fn<() => Promise<void>>().mockResolvedValue();
  const client = {
    get negotiated() {
      return instanceId === null ? null : { instanceId };
    },
    connect,
    onReconnect(callback: () => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  } as unknown as HostClient;
  return {
    client,
    connect,
    listeners,
    negotiate(id: string, reconnect = true) {
      instanceId = id;
      if (reconnect) for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("daemon generation admission", () => {
  it("already negotiated target needs no connect and releases its deadline/subscription", async () => {
    const f = fixture();
    f.negotiate("target", false);
    expect(await waitForDaemonGeneration(f.client, "target")).toEqual({ ok: true });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unrelated generations then accepts the target reconnect", async () => {
    const f = fixture();
    const settled = vi.fn();
    const pending = waitForDaemonGeneration(f.client, "target").then(settled);
    f.negotiate("old");
    f.negotiate("stranger");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    expect(f.listeners.size).toBe(1);
    f.negotiate("target");
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith({ ok: true });
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolved-wrong-generation", "stuck"] as const)(
    "bounds %s connect by the real five-second default",
    async (mode) => {
      const f = fixture();
      if (mode === "stuck") f.connect.mockImplementation(() => new Promise(() => {}));
      f.negotiate("old", false);
      const settled = vi.fn();
      const pending = waitForDaemonGeneration(f.client, "target").then(settled);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toHaveBeenCalledExactlyOnceWith({ ok: false, reason: "timeout" });
      expect(f.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      f.negotiate("target");
      expect(settled).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "accepts target negotiated during connect (reconnect event=%s)",
    async (event) => {
      const f = fixture();
      f.connect.mockImplementation(async () => {
        f.negotiate("target", event);
      });
      expect(await waitForDaemonGeneration(f.client, "target")).toEqual({ ok: true });
      expect(f.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { error: new Error("socket refused"), reason: "connect_failed" },
    { error: new HostClientError("closed", "client closed"), reason: "client_closed" },
  ])("preserves $reason and cleans up", async ({ error, reason }) => {
    const f = fixture();
    f.connect.mockRejectedValue(error);
    expect(await waitForDaemonGeneration(f.client, "target")).toEqual({ ok: false, reason, error });
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
