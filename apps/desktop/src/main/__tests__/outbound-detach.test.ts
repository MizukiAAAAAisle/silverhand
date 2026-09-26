import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClientError, type HostClient } from "@silverhand/host";
import { gracefullyDetachOutbound } from "../outbound-detach.js";

const stale = { connectionId: "old" };
function client(action: "detached" | "noop" = "detached") {
  return {
    hostOutboundDetach: vi
      .fn<HostClient["hostOutboundDetach"]>()
      .mockResolvedValue({ detached: true, action }),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("bounded shutdown detach", () => {
  it("immediate cleared registry releases the RPC timer without consuming budget", async () => {
    const rpc = client();
    const getAttachment = vi.fn(() => null);
    expect(await gracefullyDetachOutbound({ client: rpc, hostId: "host", getAttachment })).toEqual({
      rpc: { ok: true, action: "detached" },
      registryCleared: true,
      elapsedMs: 0,
      budgetExhausted: false,
    });
    expect(rpc.hostOutboundDetach).toHaveBeenCalledTimes(1);
    expect(getAttachment).toHaveBeenCalledWith("host");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("noop still waits for registry removal at the real100ms poll", async () => {
    let current: typeof stale | null = stale;
    const pending = gracefullyDetachOutbound({
      client: client("noop"),
      hostId: "host",
      getAttachment: () => current,
    });
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    current = null;
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
    expect(await pending).toEqual({
      rpc: { ok: true, action: "noop" },
      registryCleared: true,
      elapsedMs: 100,
      budgetExhausted: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1450])("never resets the1500ms total budget after a%sms RPC", async (rpcDelay) => {
    const rpc = client();
    rpc.hostOutboundDetach.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ detached: true, action: "detached" }), rpcDelay);
        }),
    );
    const pending = gracefullyDetachOutbound({
      client: rpc,
      hostId: "host",
      getAttachment: () => stale,
    });
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
    expect(await pending).toEqual({
      rpc: { ok: true, action: "detached" },
      registryCleared: false,
      elapsedMs: 1500,
      budgetExhausted: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      value: new HostClientError("closed", "client closed"),
      sync: false,
      error: "client closed",
      code: "closed",
    },
    { value: "opaque error", sync: false, error: "opaque error", code: undefined },
    { value: new Error("sync failure"), sync: true, error: "sync failure", code: undefined },
  ])(
    "RPC failure $error is data and still permits observation",
    async ({ value, sync, error, code }) => {
      const rpc = client();
      rpc.hostOutboundDetach.mockImplementation(() => {
        if (sync) throw value;
        return Promise.reject(value);
      });
      const getAttachment = vi.fn(() => null);
      expect(
        await gracefullyDetachOutbound({ client: rpc, hostId: "host", getAttachment }),
      ).toEqual({
        rpc: { ok: false, error, ...(code ? { code } : {}) },
        registryCleared: true,
        elapsedMs: 0,
        budgetExhausted: false,
      });
      expect(getAttachment).toHaveBeenCalledWith("host");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stuck RPC cannot block shutdown and a late reply cannot restart observation", async () => {
    const rpc = client();
    let finish!: (result: { detached: true; action: "detached" }) => void;
    rpc.hostOutboundDetach.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const getAttachment = vi.fn(() => stale);
    const pending = gracefullyDetachOutbound({ client: rpc, hostId: "host", getAttachment });
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toHaveBeenCalledOnce();
    const expected = {
      rpc: {
        ok: false,
        error: "RPC did not settle within shutdown budget",
        code: "synthetic_timeout",
      },
      registryCleared: false,
      elapsedMs: 1500,
      budgetExhausted: true,
    };
    expect(await pending).toEqual(expected);
    expect(getAttachment).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    finish({ detached: true, action: "detached" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual(expected);
    expect(getAttachment).toHaveBeenCalledTimes(1);
  });

  it.each(["host", "observer"] as const)(
    "missing %s skips observation, not the IPC",
    async (missing) => {
      const rpc = client("noop");
      const getAttachment = vi.fn(() => null);
      expect(
        await gracefullyDetachOutbound({
          client: rpc,
          hostId: missing === "host" ? null : "host",
          getAttachment: missing === "observer" ? undefined : getAttachment,
        }),
      ).toEqual({
        rpc: { ok: true, action: "noop" },
        registryCleared: "skipped",
        elapsedMs: 0,
        budgetExhausted: false,
      });
      expect(rpc.hostOutboundDetach).toHaveBeenCalledTimes(1);
      expect(getAttachment).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { poll: 0, value: new Error("registry failure"), expected: "registry failure" },
    { poll: 1, value: new Error("later registry failure"), expected: "later registry failure" },
    { poll: 0, value: "string failure", expected: "string failure" },
  ])(
    "registry error at poll$poll is captured and stops polling",
    async ({ poll, value, expected }) => {
      let reads = 0;
      const getAttachment = vi.fn(() => {
        if (reads++ === poll) throw value;
        return stale;
      });
      const pending = gracefullyDetachOutbound({ client: client(), hostId: "host", getAttachment });
      await vi.advanceTimersByTimeAsync(poll * 100);
      expect(await pending).toEqual({
        rpc: { ok: true, action: "detached" },
        registryCleared: "error",
        registryError: expected,
        elapsedMs: poll * 100,
        budgetExhausted: false,
      });
      expect(vi.getTimerCount()).toBe(0);
      getAttachment.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      expect(getAttachment).not.toHaveBeenCalled();
    },
  );
});
