import type { BackendContext } from '../context.js';
import type { UserPrincipal } from '../auth/principal.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import { canGovernWorkspace } from '../permissions.js';
import { assertWorkspaceAgentsMatchHost } from './workspace-placement.js';

/**
 * DeleteWorkspace use case (#task:983 — P13a spec).
 *
 * Owns the full `DELETE /api/workspaces/:id` destructive cascade that previously
 * lived in the route body: idempotency / kind guard, owner-gate authorization,
 * the fail-closed placement preflight (BEFORE any side effect), the runtime stop
 * fan-out (`resolveConversationRuns('conversation_closed')` + per-agent hard
 * `stop`, fire-and-forget), the best-effort attachment-blob sweep, and the final
 * workspace-row delete (DB rows cascade via FK).
 *
 * HTTP-agnostic by construction (mirror of `delete-agent.ts`): it returns a typed
 * {@link DeleteWorkspaceResult}; the route maps kind → HTTP status + body with an
 * exhaustive `switch` + `never` fallback. It never imports Hono `Context` and
 * never builds a `Response`. The `placementRejected` arm carries the raw thrown
 * `err` so the route can reuse `placementErrorResponse` (Cindy ruling a — no
 * duplicated status table) and rethrow on an unmapped error.
 *
 * Side-effect ORDERING is the contract (Cindy ruling 5): preflight strictly
 * before the stop fan-out, sweep, and delete. There is intentionally NO outer
 * `db.transaction` — the unit of work is a single repo `delete` + FK CASCADE, and
 * P13a is a pure lift that neither adds nor removes a unit of work.
 */
export interface DeleteWorkspaceDeps {
  ctx: BackendContext;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
}

export interface DeleteWorkspaceCommand {
  workspaceId: string;
  /** Route passes `getUserPrincipal(c).userId`. */
  requesterUserId: string;
}

export type DeleteWorkspaceResult =
  | { kind: 'deleted' } //                         → 204
  | { kind: 'idempotentNoop' } //                  unknown id → 204
  | { kind: 'notDeletableKind' } //                existing non-regular workspace → 409
  | { kind: 'forbidden' } //                       owner-gate → 403
  | { kind: 'placementRejected'; err: unknown }; // → route maps via placementErrorResponse

export async function deleteWorkspace(
  deps: DeleteWorkspaceDeps,
  cmd: DeleteWorkspaceCommand,
): Promise<DeleteWorkspaceResult> {
  const { ctx, workspaces, conversations } = deps;

  const workspace = workspaces.get(cmd.workspaceId);
  if (!workspace) {
    return { kind: 'idempotentNoop' };
  }
  if (workspace.workspace_kind !== 'regular') {
    return { kind: 'notDeletableKind' };
  }
  const principal: UserPrincipal = { kind: 'user', userId: cmd.requesterUserId };
  if (!canGovernWorkspace(ctx, principal, workspace.id, 'owner')) {
    return { kind: 'forbidden' };
  }

  const workspaceConversations = conversations
    .list()
    .filter(conversation => conversation.workspace_id === workspace.id);

  // Capture viewer members BEFORE the cascade delete — afterwards the
  // `workspace_users` rows are gone, so we could no longer address them. Used to
  // emit `viewer_workspaces_changed(removed)` post-commit (#task:1404).
  const viewerUserIds = workspaces.listUserMemberIds(workspace.id);

  // D4.c C3 — replaced the standalone-mode `host_runtime_disabled` short-circuit
  // with an explicit placement preflight that runs in both deployment modes. This
  // MUST run before any side effect: `runtimeHost.resolveConversationRuns`,
  // runtime stop, `attachmentService.sweepForChannel`, `workspaces.delete`. If any
  // agent's host placement no longer matches the workspace, fail-closed and leave
  // every conversation / blob / row untouched.
  try {
    assertWorkspaceAgentsMatchHost(
      { ctx, conversations },
      workspace.id,
      workspace.workspace_host_id,
    );
  } catch (err) {
    return { kind: 'placementRejected', err };
  }

  for (const conversation of workspaceConversations) {
    ctx.runtimeHost.resolveConversationRuns(conversation.id, 'conversation_closed');
    for (const ca of conversations.listAgents(conversation.id)) {
      void ctx.runtimeHost.stop(conversation.id, ca.agent_id, 'hard').catch(err =>
        ctx.logger.warn(
          {
            workspaceId: workspace.id,
            conversationId: conversation.id,
            agentId: ca.agent_id,
            err,
          },
          'delete workspace: runtime stop failed (continuing)',
        ),
      );
    }
  }
  // Sweep physical attachment blobs for every top-level channel before dropping
  // the workspace. attachments.channel_id only points at channel/dm_channel rows
  // (threads upload via parent), so iterate those — DB rows go via CASCADE, blobs
  // need an explicit delete.
  for (const conversation of workspaceConversations) {
    if (conversation.kind === 'channel' || conversation.kind === 'dm_channel') {
      await ctx.attachmentService
        .sweepForChannel(conversation.id)
        .catch(err =>
          ctx.logger.warn(
            { workspaceId: workspace.id, conversationId: conversation.id, err },
            'delete workspace: attachment sweep failed (continuing)',
          ),
        );
    }
  }
  workspaces.delete(workspace.id);

  // The workspace is gone — tell every viewer member so their UI drops it whole,
  // list AND unread contribution (#task:1404). delete-workspace previously
  // emitted NOTHING to viewers, so a viewer with unread in the deleted workspace
  // kept a phantom workspace/total badge (the #1284 summary cache is patched in
  // place, never refetched, until this signal or a manual reload). Post-commit,
  // per-viewer on the `viewer:<id>` scope, mirroring conversation-member's
  // `viewer_workspaces_changed` shape (change/workspace_id; the wire stays
  // `unknown` and each side validates independently —
  // docs/viewer-visibility-sync-v1.md). The renderer half (#task:1404) drops the
  // removed workspace's unread contribution from the summary on this same event.
  for (const userId of viewerUserIds) {
    ctx.events.publishToScope(`viewer:${userId}`, 'viewer_workspaces_changed', {
      change: 'removed',
      workspace_id: workspace.id,
    });
  }
  return { kind: 'deleted' };
}
