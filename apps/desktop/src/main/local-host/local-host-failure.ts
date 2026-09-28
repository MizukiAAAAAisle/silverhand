import type { DaemonFatalExitInfo } from "@silverhand/host";
import type { LocalHostClaimStatus } from "./local-host-claim.js";

export function applyFatalExitToClaim(
  current: LocalHostClaimStatus,
  info: Pick<DaemonFatalExitInfo, "kind">,
): LocalHostClaimStatus {
  // Credential removal requires re-claim, not a daemon restart. A handshake
  // failure likewise does not imply that the crash budget was exhausted.
  if (info.kind !== "restart_budget_exhausted" || current.status === "revoked") {
    return current;
  }
  return { status: "failed", hostId: current.hostId };
}
