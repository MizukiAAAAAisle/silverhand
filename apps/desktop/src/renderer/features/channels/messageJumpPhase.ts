/**
 * The prime lifecycle of a message jump and its WINDOW-LOCK projection
 * (#task:1317). Kept in its own React-free module so the lock boundary is a
 * SINGLE definition shared by every consumer — the jump controller (which feeds
 * the real cluster/channel query lock via `isPrimePendingFor`) and the
 * ThreadPanel gates — with no second inlined copy that could drift. Because the
 * unit test covers `jumpWindowLockedForPhase` directly, it covers the actual
 * query-lock logic, not a look-alike.
 *
 * Phase meaning (single source of truth; loader / locate / window-lock all
 * project from it, never from one overloaded boolean):
 *  - `priming`   — the around-fetch is in flight. Window LOCKED, loader shown,
 *                  locate must NOT run (would poll a stale/empty window).
 *  - `committed` — the around-window is written to the cache (contains the
 *                  target). RENDER released BUT the window stays LOCKED until
 *                  `clearJump`, so a latest fetch can't clobber it; locate runs.
 *  - `settled`   — resolved WITHOUT committing (stale/aborted). Window UNLOCKED
 *                  (fallback latest may fill the pane); locate does a bounded
 *                  best-effort. (`not_found` clears the jump entirely → null.)
 */
export type JumpPhase = 'priming' | 'committed' | 'settled';

/**
 * WINDOW LOCK: true while a jump's around-window must stay protected from a
 * clobbering latest fetch — `priming` (fetch in flight) OR `committed`
 * (written, awaiting the visual locate). Releases at `settled` / `null`
 * (→ `clearJump`). THE single definition of the lock boundary: the controller's
 * `isPrimePendingFor` and ThreadPanel's `useThreadCluster` window-lock both call
 * this, so the boundary cannot drift between the two and re-open the committed
 * clobber race.
 */
export function jumpWindowLockedForPhase(phase: JumpPhase | null): boolean {
  return phase === 'priming' || phase === 'committed';
}

/**
 * Whether ThreadPanel's jump-locate rAF poll may START (#task:1317) — a pure
 * projection of the phase, co-located with the window-lock so the phase's
 * projections all live in one place:
 *  - `committed` — the around-window (contains the target) is cached AND still
 *    locked, so the poll runs against the authoritative window (no mis-anchor,
 *    no clobber).
 *  - `settled`   — no authoritative window; best-effort poll of whatever loaded,
 *    with the caller's bounded rAF budget releasing the jump if absent.
 *  - `priming`   — window undefined / possibly stale: MUST NOT poll (the
 *    original mis-anchor bug). Re-runs when the phase advances.
 *  - `null`      — no active jump.
 * Every allowed branch is bounded: the caller's poll finds the node
 * (scroll+flash → `onJumped`) or gives up after its budget (→ `onJumped`), and
 * `onJumped → clearJump` drops the phase — no "neither render nor release" state.
 */
export function threadLocateAllowed(phase: JumpPhase | null): boolean {
  return phase === 'committed' || phase === 'settled';
}
