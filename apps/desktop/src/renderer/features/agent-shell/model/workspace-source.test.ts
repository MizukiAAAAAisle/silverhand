import { describe, expect, it } from "vitest";
import { AGENT_HOME_SOURCE, sideAgentWorkspaceSource } from "./workspace-source";

describe("agent workspace source", () => {
  it("uses the full-page home source for agent scope in every docked workspace", () => {
    for (const workspace of ["workspace-a", "workspace-b", null]) {
      expect(sideAgentWorkspaceSource("agent", workspace)).toBe(AGENT_HOME_SOURCE);
    }
  });

  it("preserves each workspace target for conversation-scoped agents", () => {
    expect(sideAgentWorkspaceSource("conversation", "workspace-a")).toEqual({
      kind: "workspace",
      workspaceId: "workspace-a",
    });
    expect(sideAgentWorkspaceSource("conversation", "workspace-b")).toEqual({
      kind: "workspace",
      workspaceId: "workspace-b",
    });
    expect(sideAgentWorkspaceSource("conversation", null)).toBe(AGENT_HOME_SOURCE);
  });
});
