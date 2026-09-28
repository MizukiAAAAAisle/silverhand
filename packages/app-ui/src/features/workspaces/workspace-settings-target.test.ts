import { describe, expect, it, vi } from "vitest";
import {
  resolveWorkspaceSettingsTarget,
  workspaceDeletionDestination,
} from "./workspace-settings-target";

import { api } from "@/lib/api";
import { useAddWorkspaceMember, useDeleteWorkspace, useRenameWorkspace } from "./hooks";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  const client = new original.QueryClient();
  return {
    ...original,
    useQueryClient: () => client,
    useMutation: (options: { mutationFn: (value: unknown) => Promise<unknown> }) => ({
      mutateAsync: options.mutationFn,
    }),
  };
});

const workspaces = [
  { id: "a", name: "Same name", owner_agent_id: null },
  { id: "b", name: "Same name", owner_agent_id: null },
];

describe("workspace settings target", () => {
  it("resolves B independently of current A and refuses an absent target", () => {
    expect(resolveWorkspaceSettingsTarget(workspaces, "b")).toBe(workspaces[1]);
    expect(resolveWorkspaceSettingsTarget(workspaces, "missing")).toBeNull();
    expect(resolveWorkspaceSettingsTarget(workspaces, null)).toBeNull();
  });

  it("sends member, rename and delete commands to B while A remains selected", async () => {
    const target = resolveWorkspaceSettingsTarget(workspaces, "b")!;
    vi.mocked(api).mockResolvedValue({ workspace: { ...target, workspace_scope_ids: [] } });
    await useAddWorkspaceMember(target.id).mutateAsync({ kind: "agent", agent_id: "agent-b" });
    await useRenameWorkspace().mutateAsync({ id: target.id, name: "Renamed B" });
    await useDeleteWorkspace().mutateAsync(target.id);
    expect(vi.mocked(api).mock.calls.map(([path, options]) => [path, options?.method])).toEqual([
      ["/api/workspaces/b/members", "POST"],
      ["/api/workspaces/b", "PATCH"],
      ["/api/workspaces/b", "DELETE"],
    ]);
    expect(workspaceDeletionDestination(workspaces, target.id, "a")).toEqual({ kind: "stay" });
  });

  it("keeps A when B is deleted, and only chooses a fallback when A is deleted", () => {
    expect(workspaceDeletionDestination(workspaces, "b", "a")).toEqual({ kind: "stay" });
    expect(workspaceDeletionDestination(workspaces, "a", "a")).toEqual({
      kind: "workspace",
      workspaceId: "b",
    });
    expect(workspaceDeletionDestination(workspaces.slice(0, 1), "a", "a")).toEqual({
      kind: "chat",
    });
  });
});
