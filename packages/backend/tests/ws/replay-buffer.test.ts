import { describe, it, expect, beforeEach } from 'vitest';
import { decodeTransportEpoch, decodeTransportSeq } from '@silverhand/shared';
import { ReplayBuffer } from '../../src/ws/replay-buffer.js';

// Transport-space fixtures go through the validated decoders (never a bare cast),
// mirroring the seq-brand test discipline — the buffer stores TransportSeq /
// TransportEpoch, so raw literals would not type-check.
const ts = (n: number) => decodeTransportSeq(n);

describe('ReplayBuffer', () => {
  const EPOCH = decodeTransportEpoch('epoch-1');
  let buf: ReplayBuffer;

  beforeEach(() => {
    buf = new ReplayBuffer(5); // small size for easy testing
  });

  it('starts empty', () => {
    expect(buf.size).toBe(0);
    expect(buf.currentSeq(EPOCH)).toBe(0);
    expect(buf.replay(ts(0), EPOCH)).toEqual([]);
  });

  it('replays entries after fromSeq', () => {
    buf.push({ seq: ts(1), epoch: EPOCH, kind: 'msg', payload: 'a' });
    buf.push({ seq: ts(2), epoch: EPOCH, kind: 'msg', payload: 'b' });
    buf.push({ seq: ts(3), epoch: EPOCH, kind: 'msg', payload: 'c' });

    expect(buf.replay(ts(1), EPOCH)).toEqual([
      { seq: ts(2), epoch: EPOCH, kind: 'msg', payload: 'b' },
      { seq: ts(3), epoch: EPOCH, kind: 'msg', payload: 'c' },
    ]);
  });

  it('returns all entries when fromSeq=0', () => {
    buf.push({ seq: ts(1), epoch: EPOCH, kind: 'ev', payload: null });
    buf.push({ seq: ts(2), epoch: EPOCH, kind: 'ev', payload: null });
    expect(buf.replay(ts(0), EPOCH)).toHaveLength(2);
  });

  it('returns empty array on epoch mismatch', () => {
    buf.push({ seq: ts(1), epoch: EPOCH, kind: 'ev', payload: null });
    expect(buf.replay(ts(0), decodeTransportEpoch('different-epoch'))).toEqual([]);
  });

  it('tracks currentSeq correctly', () => {
    buf.push({ seq: ts(1), epoch: EPOCH, kind: 'ev', payload: null });
    buf.push({ seq: ts(5), epoch: EPOCH, kind: 'ev', payload: null });
    expect(buf.currentSeq(EPOCH)).toBe(5);
  });

  it('returns 0 for currentSeq on epoch mismatch', () => {
    buf.push({ seq: ts(3), epoch: EPOCH, kind: 'ev', payload: null });
    expect(buf.currentSeq(decodeTransportEpoch('other'))).toBe(0);
  });

  it('overwrites oldest entries when full (circular)', () => {
    for (let i = 1; i <= 7; i++) {
      buf.push({ seq: ts(i), epoch: EPOCH, kind: 'ev', payload: i });
    }
    expect(buf.size).toBe(5); // capped at maxSize
    // Oldest two (seq 1, 2) should be gone — replay from 0 returns seq 3..7
    const entries = buf.replay(ts(0), EPOCH);
    expect(entries.map(e => e.seq)).toEqual([3, 4, 5, 6, 7]);
  });

  it('handles gap > buffer (client missed too much)', () => {
    buf.push({ seq: ts(10), epoch: EPOCH, kind: 'ev', payload: null });
    buf.push({ seq: ts(11), epoch: EPOCH, kind: 'ev', payload: null });
    // Client has lastSeq=5, buffer starts at 10 — no entries with seq > 5 AND >= 10
    // Actually seq 10 and 11 are > 5 so they will be returned.
    // Real "gap too large" detection is done in ws-connection, not the buffer.
    const entries = buf.replay(ts(5), EPOCH);
    expect(entries.map(e => e.seq)).toEqual([10, 11]);
  });
});
