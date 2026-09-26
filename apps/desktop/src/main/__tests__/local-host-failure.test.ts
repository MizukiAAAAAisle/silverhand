import { describe, expect, it } from "vitest";
import type { LocalHostClaimStatus } from "../local-host-claim.js";
import { applyFatalExitToClaim } from "../local-host-failure.js";

const states: LocalHostClaimStatus[] = [
  { status: "unclaimed", hostId: null },
  { status: "claimed", hostId: "host-claimed" },
  { status: "error", hostId: "host-error" },
  { status: "failed", hostId: "host-failed" },
  { status: "revoked", hostId: "host-revoked" },
  { status: "revoked", hostId: null },
];

describe("daemon fatal-exit claim transition", () => {
  it.each(states)(
    "budget exhaustion for $status/$hostId preserves identity and revocation",
    (input) => {
      const current = Object.freeze({ ...input });
      const result = applyFatalExitToClaim(current, { kind: "restart_budget_exhausted" });
      expect(result).toEqual({
        status: input.status === "revoked" ? "revoked" : "failed",
        hostId: input.hostId,
      });
      expect(current).toEqual(input);
      if (input.status === "revoked") expect(result).toBe(current);
    },
  );

  it.each(states)("handshake failure does not rewrite $status/$hostId", (input) => {
    const current = Object.freeze({ ...input });
    expect(applyFatalExitToClaim(current, { kind: "respawn_handshake_failed" })).toBe(current);
  });
});
