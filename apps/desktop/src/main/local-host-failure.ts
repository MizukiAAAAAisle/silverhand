/**
 * D3.b Commit 2 — single chokepoint for "what counts as a daemon-side
 * failure that should surface to UI as `local_host_status: 'failed'`".
 *
 * Strict scope (Cindy `#task:627` D3.b review gate, restated):
 *
 *   YES — daemon supervisor budget exhaustion. The supervisor's
 *         `onExit` fatal callback fires when `spawnDaemonChild` has
 *         exceeded `maxRestarts` within `restartWindowMs` and decided
 *         to stop scheduling respawns. At that point the local
 *         daemon process is gone and no automatic recovery is in
 *         flight; the user has to restart the app.
 *
 *   NO  — `host_outbound_attach` typed failure (`reason: 'config_invalid'`,
 *         `'config_unreadable'`, etc). The host row server-side is
 *         still valid; rotate-token / re-login can re-attempt the
 *         attach. These stay diagnostic (logged), they do NOT mutate
 *         `localHostClaim`.
 *
 *   NO  — attach watchdog timeout. The freshness watchdog times out
 *         when the daemon doesn't surface a fresh attachment within
 *         budget — but the daemon may attach moments after the
 *         budget expires, or main may simply have lost visibility
 *         into the registry. Surfacing this as `failed` would
 *         conflate transport observability with daemon liveness.
 *
 *   NO  — backend 401 / host_revoked. Those route through
 *         `revoked` / `error` (see {@link LocalHostClaimStatus}) and
 *         carry different recovery semantics (re-login / re-claim
 *         via Hosts settings).
 *
 * Centralising the transition here means a future commit that
 * considers routing a new failure mode through `failed` has to
 * change THIS file, which surfaces the gate question explicitly in
 * the review diff. Grepping for `flipToFailedOnBudgetExhausted`
 * should always return exactly one call site (the supervisor
 * `daemon.onExit` handler in `main/index.ts`); if it returns more,
 * the strict source rule above has been broken.
 *
 * Terminal-state framing: like the rest of the supervisor adapter
 * (`spawnDaemonChild`, `onDaemonGenerationChanged`,
 * `waitForDaemonGeneration`), this whole concept of "desktop main
 * tracking daemon liveness" goes away when daemon is launchd-managed
 * and self-attaches via keychain — at that point the local host
 * row is just a server-side resource and `local_host_status:
 * 'failed'` is no longer a useful client concept.
 */
import type { LocalHostClaimStatus } from './local-host-claim.js';

/**
 * Compute the next `LocalHostClaimStatus` given that the daemon
 * supervisor just emitted its fatal budget-exhausted `onExit`.
 * Pure function — no I/O, no logger side-effects. Caller is
 * responsible for assigning the return value back to the live
 * `localHostClaim` slot and for any logging.
 *
 * Preserves `hostId` from whatever state we were in so the renderer
 * can show "Host <id> stopped responding" rather than a context-free
 * "Host unavailable". For `unclaimed` (no host id ever existed)
 * that field is `null`.
 */
export function flipToFailedOnBudgetExhausted(
  current: LocalHostClaimStatus,
): LocalHostClaimStatus {
  return {
    status: 'failed',
    hostId: current.hostId,
  };
}
