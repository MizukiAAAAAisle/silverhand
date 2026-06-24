import { describe, expect, it } from 'vitest';
import {
  recentKeyFor,
  recentKeyForAndAdmit,
  recentSnapshotToken,
  type RecentKeySnapshot,
} from './recent-order-snapshot';
import { sortGroup, type SortEntryLookup } from './viewer-sort';

// ── Fixtures ──────────────────────────────────────────────────────────────
// A tiny list whose live recency we mutate to simulate a "click" (touch writes
// a fresh last_accessed_at) and a refetch landing it.
interface Row {
  id: string;
  createdAt: number;
}
const rows = (...ids: string[]): Row[] =>
  ids.map((id, i) => ({ id, createdAt: i + 1 }));

const liveLookup = (
  byId: Record<string, { rank?: number | null; lastAccessedAt: number | null }>,
): SortEntryLookup => {
  return id => ({
    rank: byId[id]?.rank ?? null,
    lastAccessedAt: byId[id]?.lastAccessedAt ?? null,
  });
};

const snapshot = (keyById: Record<string, number | null>): RecentKeySnapshot => ({
  token: 't',
  keyById: new Map(Object.entries(keyById)),
});

/** The exact recent-mode lookup `useListDragSort` builds: admit-and-freeze —
 *  snapshot key for known ids, live key for a new id which is then admitted. */
const admitLookup = (
  live: SortEntryLookup,
  snap: RecentKeySnapshot,
): SortEntryLookup => {
  return id => {
    const e = live(id);
    return { rank: e.rank, lastAccessedAt: recentKeyForAndAdmit(snap, id, e.lastAccessedAt) };
  };
};

const order = (
  items: Row[],
  mode: 'recent' | 'manual',
  lookup: SortEntryLookup,
): string[] =>
  sortGroup(items, mode, r => r.id, r => r.createdAt, lookup).map(r => r.id);

describe('recentKeyFor (pure read)', () => {
  it('returns the frozen snapshot value for a known id, ignoring the live key', () => {
    const snap = snapshot({ a: 100 });
    expect(recentKeyFor(snap, 'a', 999)).toBe(100);
  });

  it('returns the live value for an id absent from the snapshot (new/restored row)', () => {
    const snap = snapshot({ a: 100 });
    expect(recentKeyFor(snap, 'b', 500)).toBe(500);
  });

  it('honours a snapshotted null (never-opened-at-entry stays never-opened)', () => {
    const snap = snapshot({ a: null });
    expect(recentKeyFor(snap, 'a', 800)).toBeNull();
  });

  it('falls back to the live value when there is no snapshot at all', () => {
    expect(recentKeyFor(null, 'a', 42)).toBe(42);
  });
});

describe('recentKeyForAndAdmit (admit-and-freeze)', () => {
  it('returns the frozen value for a known id, ignoring the live key', () => {
    const snap = snapshot({ a: 100 });
    expect(recentKeyForAndAdmit(snap, 'a', 999)).toBe(100);
    expect(snap.keyById.get('a')).toBe(100); // unchanged
  });

  it('admits an unknown id at its live key on first sighting AND writes it in', () => {
    const snap = snapshot({ a: 100 });
    expect(recentKeyForAndAdmit(snap, 'b', 500)).toBe(500);
    expect(snap.keyById.has('b')).toBe(true);
    expect(snap.keyById.get('b')).toBe(500);
  });

  it('freezes an admitted id against its own later live changes (Cindy P1)', () => {
    const snap = snapshot({ a: 100 });
    expect(recentKeyForAndAdmit(snap, 'b', 500)).toBe(500); // first sighting → admit
    expect(recentKeyForAndAdmit(snap, 'b', 999)).toBe(500); // later touch → frozen
  });

  it('admits a never-opened new id as null and keeps it null', () => {
    const snap = snapshot({});
    expect(recentKeyForAndAdmit(snap, 'a', null)).toBeNull();
    expect(snap.keyById.has('a')).toBe(true);
    expect(recentKeyForAndAdmit(snap, 'a', 700)).toBeNull();
  });
});

describe('recent ordering with a frozen snapshot (#task:1161)', () => {
  it('does NOT reflow a row when opening it bumps its live key (the click-jump fix)', () => {
    const items = rows('a', 'b', 'c');
    // Entry: c most-recent, then b, then a.
    const snap = snapshot({ a: 100, b: 200, c: 300 });
    const live0 = liveLookup({ a: { lastAccessedAt: 100 }, b: { lastAccessedAt: 200 }, c: { lastAccessedAt: 300 } });
    expect(order(items, 'recent', admitLookup(live0, snap))).toEqual(['c', 'b', 'a']);

    // User opens `a` (2nd-from-bottom). touch writes a fresh last_accessed and a
    // refetch lands it: live now ranks `a` newest.
    const liveAfterClick = liveLookup({
      a: { lastAccessedAt: 400 },
      b: { lastAccessedAt: 200 },
      c: { lastAccessedAt: 300 },
    });
    // Frozen: order is unchanged — `a` keeps its slot under the pointer.
    expect(order(items, 'recent', admitLookup(liveAfterClick, snap))).toEqual(['c', 'b', 'a']);
    // Sanity: WITHOUT the snapshot the live key jumps `a` to the top (the bug).
    expect(order(items, 'recent', liveAfterClick)).toEqual(['a', 'c', 'b']);
  });

  it('admits a NEW id at its natural live recent slot on first render', () => {
    const items = rows('a', 'b', 'c', 'd'); // d appeared after entry
    const snap = snapshot({ a: 100, b: 200, c: 300 }); // captured before d existed
    const live = liveLookup({
      a: { lastAccessedAt: 100 },
      b: { lastAccessedAt: 200 },
      c: { lastAccessedAt: 300 },
      d: { lastAccessedAt: 250 }, // natural slot: between c and b
    });
    expect(order(items, 'recent', admitLookup(live, snap))).toEqual(['c', 'd', 'b', 'a']);
  });

  it('freezes an admitted new id against its OWN later touch (P1: jump must not relocate)', () => {
    const items = rows('a', 'b', 'c', 'd');
    const snap = snapshot({ a: 100, b: 200, c: 300 });
    // Render 1: d lands at its natural mid-list slot and is admitted.
    const live1 = liveLookup({
      a: { lastAccessedAt: 100 },
      b: { lastAccessedAt: 200 },
      c: { lastAccessedAt: 300 },
      d: { lastAccessedAt: 250 },
    });
    expect(order(items, 'recent', admitLookup(live1, snap))).toEqual(['c', 'd', 'b', 'a']);

    // User opens d → its live key jumps to newest. Same token / same snapshot:
    // d stays in its admitted slot (no jump to top).
    const live2 = liveLookup({
      a: { lastAccessedAt: 100 },
      b: { lastAccessedAt: 200 },
      c: { lastAccessedAt: 300 },
      d: { lastAccessedAt: 999 },
    });
    expect(order(items, 'recent', admitLookup(live2, snap))).toEqual(['c', 'd', 'b', 'a']);
  });

  it('admits removals (a snapshotted id that left the list simply drops out)', () => {
    const items = rows('a', 'b'); // c removed
    const snap = snapshot({ a: 100, b: 200, c: 300 });
    const live = liveLookup({ a: { lastAccessedAt: 100 }, b: { lastAccessedAt: 200 } });
    expect(order(items, 'recent', admitLookup(live, snap))).toEqual(['b', 'a']);
  });

  it('manual mode is rank-ordered and never consults the snapshot', () => {
    const items = rows('a', 'b', 'c');
    // ranks: b < a < c. last_accessed (and any snapshot) must be irrelevant.
    const live = liveLookup({
      a: { rank: 2, lastAccessedAt: 999 },
      b: { rank: 1, lastAccessedAt: 1 },
      c: { rank: 3, lastAccessedAt: 500 },
    });
    expect(order(items, 'manual', live)).toEqual(['b', 'a', 'c']);
  });
});

describe('recentSnapshotToken (re-capture policy)', () => {
  it('is a stable loading token until viewer_sort has loaded', () => {
    expect(recentSnapshotToken('ws1', ['starred'], false)).toBe('__loading__');
    expect(recentSnapshotToken(null, [], false)).toBe('__loading__');
  });

  it('changes when the listKey changes (e.g. workspace switch)', () => {
    expect(recentSnapshotToken('ws1', [''], true)).not.toBe(
      recentSnapshotToken('ws2', [''], true),
    );
  });

  it('is order-independent across the recent-scope set (no spurious recapture)', () => {
    expect(recentSnapshotToken('ws1', ['regular', 'starred', 'dm'], true)).toBe(
      recentSnapshotToken('ws1', ['dm', 'starred', 'regular'], true),
    );
  });

  it('changes when a scope toggles into / out of recent (rail scopes isolated)', () => {
    const both = recentSnapshotToken('ws1', ['starred', 'dm'], true);
    expect(both).not.toBe(recentSnapshotToken('ws1', ['starred'], true)); // dm left recent
    expect(both).not.toBe(recentSnapshotToken('ws1', ['starred', 'dm', 'regular'], true));
  });

  it('uses the list-wide sentinel scope for the channel sidebar', () => {
    expect(recentSnapshotToken('channels', [''], true)).toBe('channels::');
  });
});
