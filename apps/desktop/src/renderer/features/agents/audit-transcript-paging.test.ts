import { describe, expect, it } from 'vitest';
import {
  flattenTranscriptPages,
  transcriptPreviousBeforeSeq,
} from './audit-transcript-paging';

/**
 * Pins the "All Chats = 可读全文" contract (#task:2036 part ②, B2) at the pure
 * seam, without mounting a component. Models a 250-message conversation read in
 * windows of 200 from the latest — the case that exposed the pre-fix bug where
 * only the newest window was ever reachable.
 */
type Row = { id: string; seq: number };
const row = (seq: number): Row => ({ id: `m-${seq}`, seq });
const page = (rows: Row[], has_more_before: boolean) => ({
  messages: rows,
  has_more_before,
});

const all = Array.from({ length: 250 }, (_, i) => row(i + 1)); // seq 1..250
const latestWindow = all.slice(50); // seq 51..250 — the initial (anchor) window
const olderWindow = all.slice(0, 50); // seq 1..50 — the older page

describe('transcript backward paging seam', () => {
  it('the initial latest window does not contain the oldest message', () => {
    expect(latestWindow[0]!.seq).toBe(51);
    expect(latestWindow.some(r => r.id === 'm-1')).toBe(false);
  });

  it('has_more_before=true yields the exclusive cursor = oldest loaded seq', () => {
    // react-query hands getPreviousPageParam the OLDEST loaded page (pages[0]);
    // on the first backward step that is the latest window itself.
    const beforeSeq = transcriptPreviousBeforeSeq(page(latestWindow, true));
    expect(beforeSeq).toBe(51);
    // The endpoint window is `seq < before_seq` (exclusive), so the next page
    // ends at seq 50 — the boundary row (51) is never re-fetched.
    expect(olderWindow.every(r => r.seq < beforeSeq!)).toBe(true);
  });

  it('after loading the older page the oldest message is reachable, strictly ascending', () => {
    // Older pages are prepended, so pages[0] is the older window.
    const flat = flattenTranscriptPages([
      page(olderWindow, false),
      page(latestWindow, true),
    ]);
    expect(flat).toHaveLength(250);
    expect(flat[0]!.id).toBe('m-1'); // oldest now reachable
    expect(flat[flat.length - 1]!.id).toBe('m-250');
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i]!.seq).toBeGreaterThan(flat[i - 1]!.seq);
    }
  });

  it('a boundary row present in two pages appears exactly once', () => {
    // Defensive: even if a window were ever inclusive and repeated seq 51.
    const flat = flattenTranscriptPages([
      page([...olderWindow, row(51)], false), // older page also carries 51
      page(latestWindow, true), // latest window starts at 51
    ]);
    expect(flat.filter(r => r.id === 'm-51')).toHaveLength(1);
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i]!.seq).toBeGreaterThanOrEqual(flat[i - 1]!.seq);
    }
  });

  it('stops paging when has_more_before=false (no previous page param)', () => {
    expect(transcriptPreviousBeforeSeq(page(olderWindow, false))).toBeUndefined();
    // An empty page also terminates rather than looping on a missing seq.
    expect(transcriptPreviousBeforeSeq(page([], true))).toBeUndefined();
  });

  it('flatten tolerates the pre-load (undefined) state', () => {
    expect(flattenTranscriptPages(undefined)).toEqual([]);
  });
});
