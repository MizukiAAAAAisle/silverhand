import { SIDEBAR_FIXED_BRANCH_IDS, sidebarWorkspaceBranchId } from "@silverhand/shared";
import { isAgentSpace } from "@/features/workspaces/workspace-ownership";
import type { WorkspaceItem } from "../sidebar/workspaces-panel";

export type SidebarBranch =
  | { id: string; kind: "starred" | "direct-messages" | "hidden" }
  | { id: string; kind: "workspace"; workspace: WorkspaceItem };

export function sidebarBranches(
  workspaces: WorkspaceItem[],
  order: readonly string[] | undefined,
): SidebarBranch[] {
  const byId = new Map(
    workspaces
      .filter((workspace) => !workspace.archived)
      .map((workspace) => [sidebarWorkspaceBranchId(workspace.id), workspace]),
  );
  const resolvedOrder = order ?? [
    ...SIDEBAR_FIXED_BRANCH_IDS,
    ...[...byId.values()]
      .sort(
        (a, b) =>
          Number(isAgentSpace(a)) - Number(isAgentSpace(b)) ||
          a.created_at - b.created_at ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((workspace) => sidebarWorkspaceBranchId(workspace.id)),
  ];
  return resolvedOrder.map((id): SidebarBranch => {
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
