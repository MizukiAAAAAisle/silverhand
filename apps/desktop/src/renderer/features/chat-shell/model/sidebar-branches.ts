import { SIDEBAR_FIXED_BRANCH_IDS, sidebarWorkspaceBranchId } from "@silverhand/shared";
import type { WorkspaceItem } from "../sidebar/workspaces-panel";

export type SidebarBranch =
  | { id: string; kind: "starred" | "direct-messages" | "hidden" }
  | { id: string; kind: "workspace"; workspace: WorkspaceItem };

export function sidebarBranches(
  workspaces: WorkspaceItem[],
  order: readonly string[],
): SidebarBranch[] {
  const byId = new Map(
    workspaces
      .filter((workspace) => !workspace.archived)
      .map((workspace) => [sidebarWorkspaceBranchId(workspace.id), workspace]),
  );
  return order.map((id): SidebarBranch => {
    if (id === SIDEBAR_FIXED_BRANCH_IDS[0]) {
      return { id, kind: "starred" };
    }
    if (id === SIDEBAR_FIXED_BRANCH_IDS[1]) {
      return { id, kind: "direct-messages" };
    }
    const workspace = byId.get(id);
    return workspace ? { id, kind: "workspace", workspace } : { id, kind: "hidden" };
  });
}
