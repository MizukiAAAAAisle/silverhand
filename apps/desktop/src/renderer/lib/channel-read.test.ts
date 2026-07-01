import { describe, expect, it } from 'vitest';
import { nextTailReadMark, type TailReadMark } from './channel-read';

// #task:1255 P1c / #task:1244 — ChannelView's read-cursor advancement moved off
// frame arrival onto the mainline cache. These cases pin the read-inert
// tightening Cindy/Alice signed off: read advances only when the visible window
// is at tail and the newest mainline row actually advanced.

describe('nextTailReadMark', () => {
  it('marks once when a mainline row appends at tail', () => {
    const first = nextTailReadMark(null, 'c1', 5, true, false);
    expect(first).toEqual({ channelId: 'c1', seq: 5 });

    // Same tail again (re-render, no new row) → no second mark.
    const again = nextTailReadMark(first, 'c1', 5, true, false);
    expect(again).toBeNull();
  });

  it('marks again when the tail advances to a newer row', () => {
    const prev: TailReadMark = { channelId: 'c1', seq: 5 };
    expect(nextTailReadMark(prev, 'c1', 6, true, false)).toEqual({
      channelId: 'c1',
      seq: 6,
    });
  });

  it('does NOT mark when scrolled into history (not at tail)', () => {
    expect(nextTailReadMark(null, 'c1', 5, false, false)).toBeNull();
  });

  it('does NOT mark when a live gap is known (off-tail content arrived)', () => {
    expect(nextTailReadMark(null, 'c1', 5, true, true)).toBeNull();
  });

  it('does NOT mark on a reply-only frame (mainline tail unchanged)', () => {
    // A reply-only frame bumps a thread badge but never enters the mainline
    // list, so tailSeq is unchanged → with a prior mark at that seq, no re-mark.
    const prev: TailReadMark = { channelId: 'c1', seq: 5 };
    expect(nextTailReadMark(prev, 'c1', 5, true, false)).toBeNull();
  });

  it('re-marks across a channel switch even at the same seq value', () => {
    const prev: TailReadMark = { channelId: 'c1', seq: 5 };
    expect(nextTailReadMark(prev, 'c2', 5, true, false)).toEqual({
      channelId: 'c2',
      seq: 5,
    });
  });

  it('does not mark an empty channel (no tail row)', () => {
    expect(nextTailReadMark(null, 'c1', null, true, false)).toBeNull();
  });
});
