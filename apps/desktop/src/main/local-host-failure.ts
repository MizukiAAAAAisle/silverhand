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
 * the review diff. The production chokepoint is
 * {@link applyFatalExitToClaim} — grepping for `applyFatalExitToClaim`
 * should always return exactly one production call site (the
 * supervisor `daemon.onExit` handler in `main/index.ts`); if it
 * returns more, the strict source rule above has been broken.
 * {@link flipToFailedOnBudgetExhausted} is an internal helper of
 * {@link applyFatalExitToClaim} (it implements the revoked carve-out
 * + flip step) and must NOT acquire a second production caller — new
 * fatal-exit consumers route through `applyFatalExitToClaim` so the
 * `kind` gate stays in one place.
 *
 * Terminal-state framing: like the rest of the supervisor adapter
 * (`spawnDaemonChild`, `onDaemonGenerationChanged`,
 * `waitForDaemonGeneration`), this whole concept of "desktop main
 * tracking daemon liveness" goes away when daemon is launchd-managed
 * and self-attaches with its local host credential — at that point the local host
 * row is just a server-side resource and `local_host_status:
 * 'failed'` is no longer a useful client concept.
 */
import type { DaemonFatalExitInfo } from '@silverhand/host';
import type { LocalHostClaimStatus } from './local-host-claim.js';

/**
 * Compute the next `LocalHostClaimStatus` given that the daemon
 * supervisor just emitted its fatal budget-exhausted `onExit`.
 * Pure function — no I/O, no logger side-effects. Caller is
 * responsible for assigning the return value back to the live
 * `localHostClaim` slot and for any logging.
 *
 * Special case (Cindy `#task:629` P1-B): if the current state is
 * already `revoked`, return it unchanged. The credential has been
 * deliberately removed server-side; recovery requires re-claim via
 * the Hosts settings page, NOT "restart the daemon" — flipping to
 * `failed` would route the user to the wrong remediation. The
 * supervisor's terminal liveness signal and the credential lifecycle
 * are two different surfaces; if the product later needs to express
 * "revoked AND local daemon also dead" simultaneously, that belongs
 * in a separate diagnostic/overlay field, not in this single UI-
 * facing status enum.
 *
 * `hostId` from the incoming state is preserved for internal logging
 * / diagnostic emission only. It is **NOT** currently surfaced to
 * the renderer when `status === 'failed'` — the `BackendInfo`
 * snapshot only exposes `local_host_id` in the `claimed` path
 * (`main/index.ts`). A future UI commit that wants to render
 * "Host <id> stopped responding" must extend the snapshot
 * explicitly; until then this field is main-process-local.
 */
export function flipToFailedOnBudgetExhausted(
  current: LocalHostClaimStatus,
): LocalHostClaimStatus {
  if (current.status === 'revoked') {
    // Credential removal trumps daemon liveness. The host row is
    // gone server-side; user needs re-claim, not restart. Keep the
    // revoked state untouched so the renderer keeps pointing at the
    // right remediation path.
    return current;
  }
  return {
    status: 'failed',
    hostId: current.hostId,
  };
}

/**
 * Single chokepoint for routing a supervisor `DaemonFatalExitInfo`
 * to a state mutation. Combines two strict-source rules:
 *
 *   1. Only `kind === 'restart_budget_exhausted'` may flip into
 *      `failed`. `respawn_handshake_failed` is recovery-surface
 *      ambiguous (the failure may be a fixable config / binary
 *      problem the user can correct on next launch) and must not
 *      lock the UI into the supervisor-gave-up end-state.
 *   2. The `revoked` carve-out from {@link flipToFailedOnBudgetExhausted}
 *      still applies even on a budget-exhausted exit.
 *
 * `main/index.ts` `daemon.onExit` handler is the SINGLE production
 * caller; future fatal-exit consumers must route through here so the
 * gate stays in one place. Returns the new state — caller assigns
 * back to the live slot.
 */
export function applyFatalExitToClaim(
  current: LocalHostClaimStatus,
  info: Pick<DaemonFatalExitInfo, 'kind'>,
): LocalHostClaimStatus {
  if (info.kind !== 'restart_budget_exhausted') {
    // `respawn_handshake_failed` (or any future fatal kind that
    // isn't budget exhaustion) is logged by the caller but does
    // NOT mutate the claim status. The supervisor has stopped
    // scheduling further respawns, but a fresh app launch may
    // succeed; flipping to `failed` would over-promise terminality.
    return current;
  }
  return flipToFailedOnBudgetExhausted(current);
}
