import { describe, expect, it } from "vitest";
import type { WorkspaceRole } from "@silverhand/shared";
import { canEditAgentCapabilities } from "./agent-permissions";

// The renderer mirror of the composite backend edit gate (#task:1778, approved
// #task:1775 option A): a workspace governor (owner|admin) OR the selected
// agent's creator may edit its capabilities. This is the branch that decides
// whether the Permission editor renders Save, so a drift from the #task:1777
// backend gate would reintroduce the click→403 dead affordance. The two
// unresolved axes (null role, null viewer id) are the fail-closed contract.
describe("canEditAgentCapabilities — governor (owner|admin) OR agent creator", () => {
  const CREATOR = "user-creator";
  const OTHER = "user-other";
  const ALL_ROLES: (WorkspaceRole | null | undefined)[] = [
    "owner",
    "admin",
    "member",
    null,
    undefined,
  ];

  it("lets owner and admin edit ANY agent (governor axis, not the creator)", () => {
    for (const viewerRole of ["owner", "admin"] as const) {
      expect(
        canEditAgentCapabilities({
          viewerRole,
          viewerUserId: OTHER, // not the creator — governor alone suffices
          agentCreatedByUserId: CREATOR,
        }),
      ).toBe(true);
    }
  });

  it("lets a plain member edit ONLY the agent they created (per-agent creator axis)", () => {
    expect(
      canEditAgentCapabilities({
        viewerRole: "member",
        viewerUserId: CREATOR,
        agentCreatedByUserId: CREATOR,
      }),
    ).toBe(true);
    // Same member, a different agent they did NOT create → read-only.
    expect(
      canEditAgentCapabilities({
        viewerRole: "member",
        viewerUserId: OTHER,
        agentCreatedByUserId: CREATOR,
      }),
    ).toBe(false);
  });

  it("denies a NON-member creator — the member(ws) floor (removed creator ⇒ no stale Save)", () => {
    // Identity matches the agent's creator, but the viewer is no longer a
    // workspace member (role null) → backend #1777 would 403, so the editor
    // must stay read-only. Mirrors `member(ws) ∧ creator`.
    expect(
      canEditAgentCapabilities({
        viewerRole: null,
        viewerUserId: CREATOR,
        agentCreatedByUserId: CREATOR,
      }),
    ).toBe(false);
  });

  it("fails closed on an unresolved role when the viewer is not the creator", () => {
    for (const viewerRole of [null, undefined]) {
      expect(
        canEditAgentCapabilities({
          viewerRole,
          viewerUserId: OTHER,
          agentCreatedByUserId: CREATOR,
        }),
      ).toBe(false);
    }
  });

  it("fails closed on an unresolved viewer id (boot hydration not finished)", () => {
    // A null viewer id must never match a creator id, even a null-ish one.
    for (const viewerRole of ALL_ROLES) {
      const governor = viewerRole === "owner" || viewerRole === "admin";
      expect(
        canEditAgentCapabilities({
          viewerRole,
          viewerUserId: null,
          agentCreatedByUserId: CREATOR,
        }),
        // Only the governor axis can still grant edit with an unresolved id;
        // the creator axis is closed.
      ).toBe(governor);
    }
  });

  it("creator match is exact identity equality, not a substring/prefix", () => {
    expect(
      canEditAgentCapabilities({
        viewerRole: "member",
        viewerUserId: "user-1",
        agentCreatedByUserId: "user-12",
      }),
    ).toBe(false);
  });
});
