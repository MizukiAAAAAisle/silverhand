import { describe, it, expect, beforeEach } from 'vitest';
import { ReplayBuffer } from '../../src/ws/replay-buffer.js';

describe('ReplayBuffer', () => {
  const EPOCH = 'epoch-1';
  let buf: ReplayBuffer;

  beforeEach(() => {
    buf = new ReplayBuffer(5); // small size for easy testing
  });

  it('starts empty', () => {
    expect(buf.size).toBe(0);
    expect(buf.currentSeq(EPOCH)).toBe(0);
    expect(buf.replay(0, EPOCH)).toEqual([]);
  });

  it('replays entries after fromSeq', () => {
    buf.push({ seq: 1, epoch: EPOCH, kind: 'msg', payload: 'a' });
    buf.push({ seq: 2, epoch: EPOCH, kind: 'msg', payload: 'b' });
    buf.push({ seq: 3, epoch: EPOCH, kind: 'msg', payload: 'c' });

    expect(buf.replay(1, EPOCH)).toEqual([
      { seq: 2, epoch: EPOCH, kind: 'msg', payload: 'b' },
      { seq: 3, epoch: EPOCH, kind: 'msg', payload: 'c' },
    ]);
  });

  it('returns all entries when fromSeq=0', () => {
    buf.push({ seq: 1, epoch: EPOCH, kind: 'ev', payload: null });
    buf.push({ seq: 2, epoch: EPOCH, kind: 'ev', payload: null });
    expect(buf.replay(0, EPOCH)).toHaveLength(2);
  });

  it('returns empty array on epoch mismatch', () => {
    buf.push({ seq: 1, epoch: EPOCH, kind: 'ev', payload: null });
    expect(buf.replay(0, 'different-epoch')).toEqual([]);
  });

  it('tracks currentSeq correctly', () => {
    buf.push({ seq: 1, epoch: EPOCH, kind: 'ev', payload: null });
    buf.push({ seq: 5, epoch: EPOCH, kind: 'ev', payload: null });
    expect(buf.currentSeq(EPOCH)).toBe(5);
  });

  it('returns 0 for currentSeq on epoch mismatch', () => {
    buf.push({ seq: 3, epoch: EPOCH, kind: 'ev', payload: null });
    expect(buf.currentSeq('other')).toBe(0);
  });

  it('overwrites oldest entries when full (circular)', () => {
    for (let i = 1; i <= 7; i++) {
      buf.push({ seq: i, epoch: EPOCH, kind: 'ev', payload: i });
    }
    expect(buf.size).toBe(5); // capped at maxSize
    // Oldest two (seq 1, 2) should be gone — replay from 0 returns seq 3..7
    const entries = buf.replay(0, EPOCH);
    expect(entries.map(e => e.seq)).toEqual([3, 4, 5, 6, 7]);
  });

  it('handles gap > buffer (client missed too much)', () => {
    buf.push({ seq: 10, epoch: EPOCH, kind: 'ev', payload: null });
    buf.push({ seq: 11, epoch: EPOCH, kind: 'ev', payload: null });
    // Client has lastSeq=5, buffer starts at 10 — no entries with seq > 5 AND >= 10
    // Actually seq 10 and 11 are > 5 so they will be returned.
    // Real "gap too large" detection is done in ws-connection, not the buffer.
    const entries = buf.replay(5, EPOCH);
    expect(entries.map(e => e.seq)).toEqual([10, 11]);
  });
});
