import { describe, expect, it } from "vitest";
import { workspaceScopeQuery, type AgentWorkspaceSource } from "./hooks";

// The Agent Workspace browser is source-blind; the only wire-visible difference
// between the full page (home/L1) and the side panel (workspace L2) is this
// query fragment. The param name is a contract with the backend resolver (Cindy
// #task:1190) — if it drifts, the side panel silently reads home, so pin it.
describe("workspaceScopeQuery", () => {
  it("home source sends no param (→ existing agent-home/L1 behaviour)", () => {
    expect(workspaceScopeQuery({ kind: "home" })).toBe("");
  });

  it("workspace source scopes by workspace_id", () => {
    const source: AgentWorkspaceSource = { kind: "workspace", workspaceId: "ws_1" };
    expect(workspaceScopeQuery(source)).toBe("workspace_id=ws_1");
  });

  it("encodes the workspace id", () => {
    const source: AgentWorkspaceSource = { kind: "workspace", workspaceId: "a/b c" };
    expect(workspaceScopeQuery(source)).toBe("workspace_id=a%2Fb%20c");
  });
});
