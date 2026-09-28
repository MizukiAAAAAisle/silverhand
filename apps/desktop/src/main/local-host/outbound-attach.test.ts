import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAttachWatchdog, type OutboundAttachmentSnapshot } from "./outbound-attach.js";

const window = { expectedHostId: "host", previousConnectionId: "old", expectAttachSince: 1_000 };
const attachment = { hostId: "host", connectionId: "old", attachedAt: 500 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());

describe("outbound attachment observation", () => {
  it.each([
    { label: "first fresh timestamp", previous: null, value: { ...attachment, attachedAt: 1_000 } },
    {
      label: "changed connection with old timestamp",
      previous: "old",
      value: { ...attachment, connectionId: "new" },
    },
    {
      label: "same connection with fresh timestamp",
      previous: "old",
      value: { ...attachment, attachedAt: 1_001 },
    },
  ])("immediately accepts $label without arming a timer", async ({ previous, value }) => {
    const handle = startAttachWatchdog(
      { ...window, previousConnectionId: previous },
      { getAttachment: () => value },
    );
    const expected = { ok: true, attachment: value, elapsedMs: 0 };
    expect(await handle.promise).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
    handle.abort();
    handle.abort();
    expect(await handle.promise).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { label: "missing", previous: "old", value: null },
    {
      label: "wrong host but fresh",
      previous: "old",
      value: { ...attachment, hostId: "other", attachedAt: 2_000 },
    },
    {
      label: "stale with no prior",
      previous: null,
      value: { ...attachment, connectionId: "leftover" },
    },
    { label: "same stale connection", previous: "old", value: attachment },
  ])("keeps $label pending, then accepts a fresh poll", async ({ previous, value }) => {
    let current: OutboundAttachmentSnapshot | null = value;
    const getAttachment = vi.fn((hostId: string) => {
      expect(hostId).toBe("host");
      return current;
    });
    const handle = startAttachWatchdog(
      { ...window, previousConnectionId: previous },
      { getAttachment },
    );
    const settled = vi.fn();
    void handle.promise.then(settled);
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).not.toHaveBeenCalled();
    const fresh = { ...attachment, connectionId: "fresh", attachedAt: 1_500 };
    current = fresh;
    await vi.advanceTimersByTimeAsync(1);
    expect(await handle.promise).toEqual({ ok: true, attachment: fresh, elapsedMs: 500 });
    expect(vi.getTimerCount()).toBe(0);
    getAttachment.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getAttachment).not.toHaveBeenCalled();
  });

  it("times out at the actual ten-second budget, not before", async () => {
    const handle = startAttachWatchdog(window, { getAttachment: () => attachment });
    const settled = vi.fn();
    void handle.promise.then(settled);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await handle.promise).toEqual({ ok: false, reason: "timeout", elapsedMs: 10_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort during polling releases the timer and stops reads", async () => {
    const getAttachment = vi.fn(() => attachment);
    const handle = startAttachWatchdog(window, { getAttachment });
    await vi.advanceTimersByTimeAsync(100);
    handle.abort();
    handle.abort();
    expect(await handle.promise).toEqual({ ok: false, reason: "aborted", elapsedMs: 100 });
    expect(vi.getTimerCount()).toBe(0);
    getAttachment.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getAttachment).not.toHaveBeenCalled();
  });
});
