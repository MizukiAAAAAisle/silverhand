import { describe, expect, it } from "vitest";
import type { WorkspaceRole } from "@silverhand/shared";
import {
  canLeaveWorkspace,
  canManageWorkspaceLifecycle,
  canRenameWorkspace,
} from "./workspace-permissions";

// These predicates are the renderer mirror of the backend `canGovernWorkspace`
// thresholds (rename = admin, archive/delete = owner). They gate which write
// affordances the Workspace Settings General page renders, so a drift from the
// route gates would silently reintroduce the click→403 dead affordance
// (#task:1772). The `null` case is the fail-closed contract: an unknown or
// still-loading role must resolve to NO write access.
describe("workspace-permissions — renderer gate mirrors the backend governance thresholds", () => {
  const ALL_ROLES: (WorkspaceRole | null)[] = ["owner", "admin", "member", null];

  describe("canRenameWorkspace (owner | admin)", () => {
    it("allows owner and admin", () => {
      expect(canRenameWorkspace("owner")).toBe(true);
      expect(canRenameWorkspace("admin")).toBe(true);
    });
    it("denies member", () => {
      expect(canRenameWorkspace("member")).toBe(false);
    });
    it("denies a null role (non-member / still loading) — fail-closed", () => {
      expect(canRenameWorkspace(null)).toBe(false);
    });
  });

  describe("canManageWorkspaceLifecycle — archive + delete (owner only)", () => {
    it("allows only owner", () => {
      expect(canManageWorkspaceLifecycle("owner")).toBe(true);
    });
    it("denies admin (archive/delete are strictly owner-only, unlike rename)", () => {
      expect(canManageWorkspaceLifecycle("admin")).toBe(false);
    });
    it("denies member", () => {
      expect(canManageWorkspaceLifecycle("member")).toBe(false);
    });
    it("denies a null role (non-member / still loading) — fail-closed", () => {
      expect(canManageWorkspaceLifecycle(null)).toBe(false);
    });
  });

  it("lifecycle management is strictly narrower than rename (owner ⊂ owner|admin)", () => {
    // Anyone who can manage lifecycle can also rename, never the reverse — the
    // admin tier is exactly the gap. Pins the two gates from silently merging.
    for (const role of ALL_ROLES) {
      if (canManageWorkspaceLifecycle(role)) expect(canRenameWorkspace(role)).toBe(true);
    }
    expect(canManageWorkspaceLifecycle("admin")).toBe(false);
    expect(canRenameWorkspace("admin")).toBe(true);
  });

  describe("canLeaveWorkspace — self-leave (member | admin, owner rejected)", () => {
    it("allows member and admin", () => {
      expect(canLeaveWorkspace("member")).toBe(true);
      expect(canLeaveWorkspace("admin")).toBe(true);
    });
    it("denies owner — the owner exit is Delete, not Leave (no ownership transfer)", () => {
      expect(canLeaveWorkspace("owner")).toBe(false);
    });
    it("denies a null role (non-member / still loading) — fail-closed", () => {
      expect(canLeaveWorkspace(null)).toBe(false);
    });
  });

  it("leave and lifecycle-manage never overlap — owner deletes, everyone else leaves", () => {
    // Exactly one workspace exit per non-null role: owner → Delete,
    // member/admin → Leave. Pins the danger zone from ever showing both.
    for (const role of ALL_ROLES) {
      if (role === null) continue;
      expect(canLeaveWorkspace(role)).toBe(!canManageWorkspaceLifecycle(role));
    }
  });
});
