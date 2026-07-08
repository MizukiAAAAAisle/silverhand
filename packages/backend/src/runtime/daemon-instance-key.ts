/**
 * Single source of truth for the daemon-instance key.
 *
 * A daemon-instance key identifies one concrete daemon process across the
 * lifetime of a host. Both `daemon_pid` and `started_at` are required: pid
 * alone is not unique on long-lived hosts (the OS recycles pids), so a
 * restarted daemon that happens to reuse a pid must still be distinguishable
 * from its predecessor.
 *
 * This key is a cross-component contract. `RunStateCache` latches it (via
 * `applyRuntimeStatus` / `acceptDaemonKey`) and rejects any event carrying a
 * different key as belonging to a stale daemon. Every *real* daemon-instance
 * key — one built from a known `pid` + `startedAt` — MUST be minted here, so
 * that two spellings of the same concept (e.g. `123@ts` vs `pid:123@ts`) can
 * never silently defeat `acceptDaemonKey`'s equality check and make the cache
 * drop/wipe on a format mismatch rather than a real daemon swap.
 *
 * The one deliberate exception is the pre-ready fallback in
 * `RuntimeEventHandler` (`unknown@<now>`), used only when a hydrate fires
 * before any `ready` event has supplied a pid/startedAt. That placeholder is
 * NOT a comparable real instance key — it exists purely so the cache latches
 * *something* until the next `ready` replaces it — so it is intentionally not
 * minted here.
 */
export function makeDaemonInstanceKey(
  daemonPid: number,
  startedAt: number,
): string {
  return `pid:${daemonPid}@${startedAt}`;
}
