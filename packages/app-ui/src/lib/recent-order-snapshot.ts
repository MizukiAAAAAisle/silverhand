import { useRef } from "react";

/**
 * Recent-mode visible-order read model (#task:1161).
 *
 * "Recent" = recently-OPENED — an MRU axis (the ⌘Tab / editor-switcher family,
 * NOT Slack/Discord activity-order; see docs/list-sort-v1.md). The naive form
 * sorts live by each row's `last_accessed_at`, so the instant you open a row its
 * key updates and the next `viewer_sort` refetch reshuffles it to the top UNDER
 * YOUR POINTER (shiki dogfood, #1161). The MRU family's standard answer is a
 * snapshot: freeze the order during use, materialize the new order only on
 * re-entry (⌘Tab freezes while held, re-ranks on next invoke).
 *
 * So we freeze each id's recent sort KEY to its value at "entry", and re-snapshot
 * ONLY on triggers DECOUPLED from selection/touch (the list changes, or a scope
 * toggles into recent). Rows already on screen keep their frozen slot across
 * refetches; ids that appear AFTER entry (new / restored channels) are ADMITTED
 * on first sighting — they land at their LIVE key (their natural recent slot)
 * and are written into the snapshot that same frame, so from then on they are
 * "in the list" and their OWN later touches can't reflow them either ("freeze
 * the order, admit additions/removals"; admit-and-freeze, NOT unknown-forever-
 * live — Cindy P1). Manual mode never consults this (it is rank-ordered).
 *
 * This is the same persistence-vs-presentation split as the `pendingDrop` drop
 * override in list-drag-sort: `touch` stays pure persistence (writes
 * `last_accessed_at`, touches no cache); the visible order is composed here.
 */
export interface RecentKeySnapshot {
  /** Opaque identity of this snapshot. Same token ⇒ same snapshot (no
   *  recapture). MUST encode only the decoupled re-snapshot triggers and MUST
   *  NOT change on a touch / `last_accessed_at` refetch. */
  token: string;
  /** Frozen recent key per id, captured at entry. An id ABSENT from the map
   *  (appeared after entry) uses its live key — see `recentKeyFor`. */
  keyById: Map<string, number | null>;
}

/** The recent sort key to ORDER an id by: its frozen snapshot value when the id
 *  was present at snapshot time, else its live value (a new / restored row that
 *  joined after entry). `null` = never opened (the sorter tie-breaks on
 *  createdAt). Pure read — no admission; see `recentKeyForAndAdmit` for the
 *  render-time variant the hook actually uses. */
export function recentKeyFor(
  snapshot: RecentKeySnapshot | null,
  id: string,
  liveLastAccessedAt: number | null,
): number | null {
  if (snapshot && snapshot.keyById.has(id)) {
    return snapshot.keyById.get(id) ?? null;
  }
  return liveLastAccessedAt;
}

/**
 * Like `recentKeyFor`, but ADMITS an unknown id: on its first sighting it lands
 * at its live key (natural recent slot) AND is written into the snapshot, so
 * from the next frame it counts as "in the list" and its own later
 * `last_accessed_at` changes can't reflow it (Cindy P1: admit-and-freeze, not
 * unknown-forever-live — otherwise the click-jump just moves from initial rows
 * to post-mount new/restored rows).
 *
 * This mutates `snapshot.keyById` (a ref-held Map) during render — the SAME
 * synchronous read-model class as `useRecentKeySnapshot`'s capture, and
 * idempotent (a second call within the same token sees the admitted entry and
 * returns the frozen value), so React StrictMode's double render is safe.
 */
export function recentKeyForAndAdmit(
  snapshot: RecentKeySnapshot,
  id: string,
  liveLastAccessedAt: number | null,
): number | null {
  if (snapshot.keyById.has(id)) {
    return snapshot.keyById.get(id) ?? null;
  }
  snapshot.keyById.set(id, liveLastAccessedAt);
  return liveLastAccessedAt;
}

/**
 * The snapshot identity token (pure, so the re-capture policy is unit-testable).
 * It changes ONLY on the decoupled re-snapshot triggers:
 *   - `loaded` false ⇒ a stable "loading" token, so the first real load (which
 *     flips `loaded` true) always re-captures from real data, never the
 *     all-null loading frame.
 *   - `listKey` ⇒ switching list views (e.g. workspace switch for the channel
 *     sidebar) re-snapshots.
 *   - the SET of scopes currently in recent mode ⇒ toggling a scope into (or out
 *     of) recent re-snapshots. Order-independent (sorted) so a reordered scope
 *     list is the SAME token (no spurious recapture).
 * It deliberately does NOT depend on `last_accessed_at` / entry values, so a
 * touch or a list refetch never bumps it — that decoupling is the whole fix.
 */
export function recentSnapshotToken(
  listKey: string | null,
  recentScopes: Iterable<string>,
  loaded: boolean,
): string {
  if (!loaded) return "__loading__";
  return `${listKey ?? ""}::${[...recentScopes].sort().join(",")}`;
}

/**
 * Hold a recent-key snapshot, re-capturing ONLY when `token` changes. Captured
 * synchronously on the entry render (a ref compared in render — the documented
 * "store info from a previous render" pattern — NOT an effect) so the first
 * painted frame is already frozen: no live-then-freeze flash.
 *
 * The token must encode the re-snapshot triggers (listKey + which scopes are in
 * recent mode) and must NOT change on a touch / `last_accessed_at` refetch —
 * that decoupling IS the fix. Re-snapshotting at the selection moment would
 * re-eat the just-written key and the jump returns (Alice's invariant).
 */
export function useRecentKeySnapshot(
  token: string,
  capture: () => Map<string, number | null>,
): RecentKeySnapshot {
  const ref = useRef<RecentKeySnapshot | null>(null);
  if (ref.current === null || ref.current.token !== token) {
    ref.current = { token, keyById: capture() };
  }
  return ref.current;
}
