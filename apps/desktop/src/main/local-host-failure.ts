import type { DaemonFatalExitInfo } from "@silverhand/host";
import type { LocalHostClaimStatus } from "./local-host-claim.js";

export function flipToFailedOnBudgetExhausted(current: LocalHostClaimStatus): LocalHostClaimStatus {
  if (current.status === "revoked") {
    // Credential removal trumps daemon liveness. The host row is
    // gone server-side; user needs re-claim, not restart. Keep the
    // revoked state untouched so the renderer keeps pointing at the
    // right remediation path.
    return current;
  }
  return {
    status: "failed",
    hostId: current.hostId,
  };
}

export function applyFatalExitToClaim(
  current: LocalHostClaimStatus,
  info: Pick<DaemonFatalExitInfo, "kind">,
): LocalHostClaimStatus {
  if (info.kind !== "restart_budget_exhausted") {
    // `respawn_handshake_failed` (or any future fatal kind that
    // isn't budget exhaustion) is logged by the caller but does
    // NOT mutate the claim status. The supervisor has stopped
    // scheduling further respawns, but a fresh app launch may
    // succeed; flipping to `failed` would over-promise terminality.
    return current;
  }
  return flipToFailedOnBudgetExhausted(current);
}
