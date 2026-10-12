import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AddWorkspaceMemberInput,
  AgentCapabilitiesDto,
  AgentCapability,
  UpdateAgentCapabilitiesInput,
  UpdateWorkspaceHumanMemberRoleResponse,
  WorkspaceMembersResponse,
  WorkspaceRole,
} from "@silverhand/shared";
import { apiPaths } from "@silverhand/shared";
import { api } from "@/lib/api";
import { capabilitiesKey, membersKey, workspacesKey } from "./query-keys";

export function useAddWorkspaceMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddWorkspaceMemberInput) => {
      if (!workspaceId) throw new Error("no workspace selected");
      // Backend returns `{member, human_member}` for the human branch
      // and `{member}` for both agent shapes (legacy `{agent_id}` and
      // tagged `{kind:'agent', agent_id}`). Renderer doesn't need the
      // exact response — it invalidates the workspace-members query so
      // the next fetch reseats both `agents` and `humans`.
      await api<unknown>(apiPaths.workspaceMembers(workspaceId), {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

export function useRemoveWorkspaceMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!workspaceId) throw new Error("no workspace selected");
      await api(apiPaths.workspaceMember(workspaceId, agentId), {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

/** Pure optimistic removal: return a members response with `userId` dropped
 *  from the human list, leaving every other field untouched. Exported for
 *  unit tests. */
export function removeHumanMemberFromList(
  response: WorkspaceMembersResponse,
  userId: string,
): WorkspaceMembersResponse {
  return {
    ...response,
    human_members: response.human_members.filter((h) => h.user_id !== userId),
  };
}

/** Remove a human member from a workspace. Owner-only on the backend
 *  (`DELETE …/members/users/:userId`, 204 No Content — no body to parse).
 *  Optimistic: drops the row from the cached members list, restores the
 *  snapshot on error, refetches as the authority. The removed user's OWN
 *  client downgrades via the `removed` viewer event (`useViewerWorkspacesSync`),
 *  not this hook. */
export function useRemoveWorkspaceHumanMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      if (!workspaceId) throw new Error("no workspace selected");
      await api(apiPaths.workspaceHumanMember(workspaceId, userId), {
        method: "DELETE",
      });
    },
    onMutate: async (userId) => {
      if (!workspaceId) return { previous: undefined };
      const key = membersKey(workspaceId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WorkspaceMembersResponse>(key);
      if (previous) {
        qc.setQueryData<WorkspaceMembersResponse>(key, removeHumanMemberFromList(previous, userId));
      }
      return { previous };
    },
    onError: (_err, _userId, ctx) => {
      if (workspaceId && ctx?.previous) {
        qc.setQueryData(membersKey(workspaceId), ctx.previous);
      }
    },
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

/** Pure optimistic patch: return a members response with `userId`'s role set
 *  to `role`, leaving every other member untouched. Owner rows are never a
 *  legal target (the caller only offers admin↔member), but this helper does
 *  not re-enforce that — it just maps by `user_id`. Exported for unit tests. */
export function patchHumanMemberRole(
  response: WorkspaceMembersResponse,
  userId: string,
  role: WorkspaceRole,
): WorkspaceMembersResponse {
  return {
    ...response,
    human_members: response.human_members.map((h) => (h.user_id === userId ? { ...h, role } : h)),
  };
}

/** Update a human member's workspace role (admin↔member). Owner-only on the
 *  backend (`PATCH …/members/users/:userId/role`); the renderer mirrors that
 *  gate by only mounting the control for owner viewers and never offering
 *  `owner` as a target. Optimistic: patches the member row in the cached
 *  members list, then refetches as the authority. On error the snapshot is
 *  restored and the cache invalidated. Cross-end live sync (a role change
 *  initiated elsewhere) rides `useViewerWorkspacesSync`, not this hook. */
export function useUpdateWorkspaceHumanMemberRole(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { userId: string; role: Exclude<WorkspaceRole, "owner"> }) => {
      if (!workspaceId) throw new Error("no workspace selected");
      return api<UpdateWorkspaceHumanMemberRoleResponse>(
        apiPaths.workspaceHumanMemberRole(workspaceId, vars.userId),
        { method: "PATCH", body: JSON.stringify({ role: vars.role }) },
      );
    },
    onMutate: async (vars) => {
      if (!workspaceId) return { previous: undefined };
      const key = membersKey(workspaceId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WorkspaceMembersResponse>(key);
      if (previous) {
        qc.setQueryData<WorkspaceMembersResponse>(
          key,
          patchHumanMemberRole(previous, vars.userId, vars.role),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (workspaceId && ctx?.previous) {
        qc.setQueryData(membersKey(workspaceId), ctx.previous);
      }
    },
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

/** Owner hands the workspace to another human member; the caller becomes admin. */
export function useTransferWorkspaceOwnership(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      if (!workspaceId) throw new Error("no workspace selected");
      await api<{ ok: true }>(apiPaths.workspaceTransferOwnership(workspaceId), {
        method: "POST",
        body: JSON.stringify({ user_id: userId }),
      });
    },
    onSettled: () => {
      if (!workspaceId) return;
      qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
      qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

/** Replace-set edit of an agent's capabilities (PUT). The caller sends the
 *  FULL desired set; the backend diffs against stored rows. On success the
 *  returned DTO seats the cache; on failure the mutation rejects and the
 *  caller is responsible for rollback + refetch (see `AgentPermissionsPanel`). */
export function useUpdateAgentCapabilities(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { agentId: string; capabilities: AgentCapability[] }) => {
      if (!workspaceId) throw new Error("no workspace selected");
      const body: UpdateAgentCapabilitiesInput = {
        capabilities: vars.capabilities,
      };
      return api<AgentCapabilitiesDto>(
        apiPaths.workspaceAgentCapabilities(workspaceId, vars.agentId),
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
    onSuccess: (dto, vars) => {
      if (workspaceId) {
        qc.setQueryData(capabilitiesKey(workspaceId, vars.agentId), dto);
      }
    },
  });
}
