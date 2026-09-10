import { describe, expect, it } from "vitest";
import { SIDEBAR_FIXED_BRANCH_IDS } from "@silverhand/shared";
import { sidebarBranches } from "./sidebar-branches";
import type { WorkspaceItem } from "../sidebar/workspaces-panel";

const workspaces: WorkspaceItem[] = [
  { id: "agent-home", name: "Agent", owner_agent_id: "agent", created_at: 1 },
  { id: "team", name: "Team", owner_agent_id: null, created_at: 2 },
];

describe("sidebar branch projection", () => {
  it("consumes the server order without regrouping or sorting", () => {
    const order = [
      "workspace:agent-home",
      SIDEBAR_FIXED_BRANCH_IDS[1],
      "workspace:team",
      SIDEBAR_FIXED_BRANCH_IDS[0],
    ];
    expect(sidebarBranches(workspaces, order).map((branch) => branch.id)).toEqual(order);
    expect(sidebarBranches(workspaces, order).map((branch) => branch.kind)).toEqual([
      "workspace",
      "direct-messages",
      "workspace",
      "starred",
    ]);
  });

  it("preserves unavailable branch identities and both fixed sections", () => {
    const order = [SIDEBAR_FIXED_BRANCH_IDS[0], "workspace:missing", SIDEBAR_FIXED_BRANCH_IDS[1]];
    const projected = sidebarBranches(workspaces, order);
    expect(projected.map((branch) => branch.id)).toEqual(order);
    expect(projected[1]?.kind).toBe("hidden");
  });

  it("does not invent ordering for workspaces absent from the authority", () => {
    expect(sidebarBranches(workspaces, [])).toEqual([]);
  });

  it("hides archived workspace content without dropping its ordering identity", () => {
    expect(
      sidebarBranches([{ ...workspaces[0]!, archived: true }], ["workspace:agent-home"]),
    ).toEqual([{ id: "workspace:agent-home", kind: "hidden" }]);
  });
});
