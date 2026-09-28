import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTailReadMark, observeVisibleTail, type TailReadMark } from "./channel-read";
import { decodeMessageSeq } from "@silverhand/shared";
import { ApiError } from "../../../lib/api";

const s = (n: number) => decodeMessageSeq(n);

describe("visible tail observation recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const mark: TailReadMark = { channelId: "c1", seq: s(22) };
  const locked = new ApiError(500, "Internal Server Error", "database is locked");

  it("retries the SAME seen seq without a new message and records only acknowledged completion", async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockRejectedValueOnce(locked).mockResolvedValue(undefined);
    const acknowledged = vi.fn();
    observeVisibleTail(mark, observe, acknowledged);
    await vi.advanceTimersByTimeAsync(0);
    expect(acknowledged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(observe.mock.calls).toEqual([[mark], [mark]]);
    expect(acknowledged).toHaveBeenCalledExactlyOnceWith(mark);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds persistent transient failures and does not mark them complete", async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockRejectedValue(locked);
    const acknowledged = vi.fn();
    observeVisibleTail(mark, observe, acknowledged);
    await vi.runAllTimersAsync();
    expect(observe).toHaveBeenCalledTimes(4);
    expect(acknowledged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 422])("does not retry permanent refusal %s", async (status) => {
    vi.useFakeTimers();
    const observe = vi.fn().mockRejectedValue(new ApiError(status, "refused", ""));
    const acknowledged = vi.fn();
    observeVisibleTail(mark, observe, acknowledged);
    await vi.runAllTimersAsync();
    expect(observe).toHaveBeenCalledOnce();
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it("leaving the tail cancels retry; revisiting the SAME tail starts again", async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockRejectedValueOnce(locked).mockResolvedValue(undefined);
    let previous: TailReadMark | null = null;
    const acknowledge = (value: TailReadMark) => {
      previous = value;
    };
    const cancel = observeVisibleTail(mark, observe, acknowledge);
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.runAllTimersAsync();
    expect(observe).toHaveBeenCalledOnce();
    const same = nextTailReadMark(previous, mark.channelId, mark.seq, true, false);
    expect(same).toEqual(mark);
    observeVisibleTail(same!, observe, acknowledge);
    await vi.advanceTimersByTimeAsync(0);
    expect(previous).toEqual(mark);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("late response after channel change cannot acknowledge the new view", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((yes) => {
      resolve = yes;
    });
    const acknowledged = vi.fn();
    const cancel = observeVisibleTail(mark, () => pending, acknowledged);
    cancel();
    resolve();
    await pending;
    expect(acknowledged).not.toHaveBeenCalled();
  });
});

describe("nextTailReadMark", () => {
  it("marks once when a mainline row appends at tail", () => {
    const first = nextTailReadMark(null, "c1", s(5), true, false);
    expect(first).toEqual({ channelId: "c1", seq: 5 });

    // Same tail again (re-render, no new row) → no second mark.
    const again = nextTailReadMark(first, "c1", s(5), true, false);
    expect(again).toBeNull();
  });

  it("marks again when the tail advances to a newer row", () => {
    const prev: TailReadMark = { channelId: "c1", seq: s(5) };
    expect(nextTailReadMark(prev, "c1", s(6), true, false)).toEqual({
      channelId: "c1",
      seq: 6,
    });
  });

  it("does NOT mark when scrolled into history (not at tail)", () => {
    expect(nextTailReadMark(null, "c1", s(5), false, false)).toBeNull();
  });

  it("does NOT mark when a live gap is known (off-tail content arrived)", () => {
    expect(nextTailReadMark(null, "c1", s(5), true, true)).toBeNull();
  });

  it("does NOT mark on a reply-only frame (mainline tail unchanged)", () => {
    // A reply-only frame bumps a thread badge but never enters the mainline
    // list, so tailSeq is unchanged → with a prior mark at that seq, no re-mark.
    const prev: TailReadMark = { channelId: "c1", seq: s(5) };
    expect(nextTailReadMark(prev, "c1", s(5), true, false)).toBeNull();
  });

  it("re-marks across a channel switch even at the same seq value", () => {
    const prev: TailReadMark = { channelId: "c1", seq: s(5) };
    expect(nextTailReadMark(prev, "c2", s(5), true, false)).toEqual({
      channelId: "c2",
      seq: 5,
    });
  });

  it("does not mark an empty channel (no tail row)", () => {
    expect(nextTailReadMark(null, "c1", null, true, false)).toBeNull();
  });
});
