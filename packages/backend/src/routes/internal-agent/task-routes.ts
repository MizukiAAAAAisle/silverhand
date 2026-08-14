// Agent task facet: list / create / claim / unclaim / update-status. All hang
// off the calling conversation; the `--workspace-id` / `--workspace` selectors
// are validated at the route layer (existence + membership) before the service
// widens reads/writes across workspaces.
import type { Hono } from 'hono';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import {
  canAgentAccessWorkspace,
  canPostToConversation,
  canViewConversation,
} from '../../permissions.js';
import { requireAgentCapability } from '../capability.js';
import {
  ClaimTasksInputSchema,
  CreateTasksInputSchema,
  EditTaskInputSchema,
  ListTasksQuerySchema,
  UnclaimTaskInputSchema,
  UpdateTaskStatusInputSchema,
  internalPaths,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';
import { resolveAgentQueryWorkspaceId } from './workspace-scope.js';

export function registerTaskRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, agents, conversations, workspaces } = deps;

  app.get(internalPaths.agentListConversationTasks(':cid', ':aid'), c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const conversation = conversations.get(cid);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    // status / task_number are repeatable; `?status=in_progress&status=in_review`
    // and `?task_number=190&task_number=191` are the canonical multi-value form.
    // 'all' is a legacy alias for no-filter — drop it before validation.
    const statusValues = (c.req.queries('status') ?? []).filter(s => s !== 'all');
    const taskNumberValues = c.req.queries('task_number') ?? [];
    const parsed = ListTasksQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || undefined,
      conversation_id: c.req.query('conversation_id') || undefined,
      status: statusValues.length > 0 ? statusValues : undefined,
      task_number: taskNumberValues.length > 0 ? taskNumberValues : undefined,
      assignee_id: c.req.query('assignee_id') || undefined,
      limit: c.req.query('limit') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Agent-side --workspace-id: default is the actor's current conversation's
    // workspace; if the agent passes a different
    // workspace_id we must validate existence + membership at the route
    // layer so the service doesn't silently widen reads across
    // workspaces. We don't accept --workspace <name> for list — only
    // claim/unclaim/status need the disambiguation.
    // A task Board belongs to a workspace and an `agent_inbox` has none (doc
    // §4.2), so from an inbox session the board question has no ambient answer:
    // name a workspace explicitly rather than read an empty board (v71).
    const scope = resolveAgentQueryWorkspaceId(
      c,
      conversation,
      parsed.data.workspace_id,
    );
    if (!scope.ok) return scope.response;
    const effectiveWorkspaceId = scope.workspaceId;
    if (effectiveWorkspaceId !== conversation.workspace_id) {
      const targetWs = workspaces.get(effectiveWorkspaceId);
      if (!targetWs) {
        return c.json(
          { error: `workspace ${effectiveWorkspaceId} not found`, code: 'unknown_workspace' },
          404,
        );
      }
      const isMember =
        targetWs.workspace_kind === 'agent_home'
          ? targetWs.owner_agent_id === aid
          : workspaces.isMember(targetWs.id, aid);
      if (!isMember) {
        return c.json(
          {
            error: `agent is not a member of workspace ${targetWs.id}`,
            code: 'workspace_membership_required',
          },
          403,
        );
      }
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'read_tasks', effectiveWorkspaceId);
      if (denied) return denied;
    }
    return c.json({
      tasks: ctx.taskService.list({
        actor: principal,
        workspaceId: effectiveWorkspaceId,
        conversationId: parsed.data.conversation_id,
        status: parsed.data.status,
        taskNumbers: parsed.data.task_number,
        assigneeAgentId: parsed.data.assignee_id,
        limit: parsed.data.limit,
      }),
    });
  });

  app.post(internalPaths.agentCreateConversationTasks(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.target !== undefined && parsed.data.reply_to_message_id !== undefined) {
      return c.json(
        {
          error: 'target and reply_to_message_id are mutually exclusive',
          code: 'target_conflict',
        },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    // Destination conversation: an explicit `--conversation-id` lands the
    // task(s) in ANOTHER conversation (the cross-conversation case — discuss in
    // A, file the work in B); omitted = the agent's current conversation (legacy
    // default).
    const destination = parsed.data.conversation_id ?? principal.conversationId;
    // Cross-conversation create (explicit destination ≠ the calling conversation) is
    // a DISPATCH: the task is filed UNCLAIMED so a member of the DESTINATION
    // conversation picks it up. `--claim` self-assigns to the CALLER, which defeats
    // that intent and would let A pin work it cannot execute onto B. Reject the
    // combination BEFORE any destination lookup or authorization — so it writes
    // no task/event AND never probes whether the destination exists (no side
    // channel). Returned as the typed 200 op-error envelope (like
    // source_conflict) so the CLI classifies it by `code` and owns the sole
    // human-readable reason string. Same-channel create+claim is untouched
    // (destination === principal.conversationId).
    if (parsed.data.claim === true && destination !== principal.conversationId) {
      return c.json({ error: 'cross_conversation_claim' });
    }
    // Create-specific NARROW authorization against the DESTINATION. We cannot
    // reuse `canPostToConversation` / `canViewConversation` here: their agent
    // branches are origin-bound (they require `principal.conversationId ===
    // conversation.id` AND derive the workspace from the ORIGIN conversation),
    // so they would 403 every cross-conversation create. Instead authorize B
    // directly with the origin-free primitives — workspace access + destination
    // membership — which reproduces the same membership floor a
    // same-conversation create requires WITHOUT relaxing the ~90-call-site
    // global post/view predicates. Unknown destination and non-member
    // destination collapse to ONE 403 shape: never probe existence.
    // A task Board belongs to a WORKSPACE (doc §4.2: an `agent_inbox` has no
    // board), so a workspace-less destination is not a place work can be filed.
    // That joins the same single 403 as unknown/non-member destination — the
    // caller must not be able to tell those apart.
    const destConv = conversations.get(destination);
    const destWorkspaceId = destConv?.workspace_id ?? null;
    const authorized =
      !!destConv &&
      destWorkspaceId !== null &&
      canAgentAccessWorkspace(ctx, principal.agentId, destWorkspaceId) &&
      conversations.getAgent(destination, principal.agentId) != null;
    if (!destConv || destWorkspaceId === null || !authorized) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Capabilities are judged on the DESTINATION's workspace — a cross-workspace
    // create needs create_tasks (and write_tasks for --claim) in B, not in the
    // origin workspace.
    {
      const denied = requireAgentCapability(c, ctx, principal, 'create_tasks', destWorkspaceId);
      if (denied) return denied;
    }
    // `--claim` self-assigns the created task, which is a task write — gate it
    // on write_tasks in addition to create_tasks (same capability claim needs).
    if (parsed.data.claim === true) {
      const denied = requireAgentCapability(c, ctx, principal, 'write_tasks', destWorkspaceId);
      if (denied) return denied;
    }
    const result = await ctx.taskService.createTasks({
      conversationId: destination,
      actor: principal,
      // Map the wire (snake_case) task items to the service contract shape
      // (camelCase `sourceMessageId`).
      tasks: parsed.data.tasks.map(item => ({
        title: item.title,
        ...(item.body !== undefined ? { body: item.body } : {}),
        ...(item.source_message_id !== undefined
          ? { sourceMessageId: item.source_message_id }
          : {}),
      })),
      claim: parsed.data.claim,
      target: parsed.data.target,
      legacyReplyToMessageId: parsed.data.reply_to_message_id,
    });
    // Business failures (source_conflict, source_*_not_found/mismatch, …) AND
    // success both return HTTP 200 with the typed envelope — mirroring
    // claim/unclaim/status/edit — so the agent CLI reads the structured
    // `error` (+ `existing_task`) from the body instead of a thrown HTTP status
    // that would strip it. `task create` translates a failure envelope into a
    // NON-zero CliError (never prints failure as success). Malformed input
    // still fails earlier at the 400 parse gate.
    return c.json(result);
  });

  app.post(internalPaths.agentClaimConversationTasks(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ClaimTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const actor = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, actor, actor.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Wire optional --workspace-id / --workspace selector.
    // Schema XOR enforces exclusivity; the service does membership +
    // existence checks per result entry.
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const results = [];
    for (const taskNumber of parsed.data.task_numbers) {
      results.push(
        await ctx.taskService.claimTask({ actor, by: { taskNumber }, workspaceSelector }),
      );
    }
    return c.json({ results });
  });

  app.post(internalPaths.agentUnclaimConversationTask(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UnclaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.unclaimTask({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
      workspaceSelector,
    });
    return c.json(result);
  });

  app.post(internalPaths.agentUpdateConversationTaskStatus(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.updateStatus({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
      status: parsed.data.status,
      workspaceSelector,
    });
    return c.json(result);
  });

  app.post(internalPaths.agentEditConversationTask(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = EditTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // write_tasks is gated INSIDE the service on the RESOLVED task workspace
    // (the selector-resolved or current-conversation workspace), mirroring
    // claim/unclaim/status.
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.editTask({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
      // An omitted flag means "leave unchanged" → null; the service COALESCEs
      // nulls against the stored value. An explicit empty body ("") clears.
      title: parsed.data.title ?? null,
      body: parsed.data.body ?? null,
      workspaceSelector,
    });
    // Always 200 with the typed envelope (like claim/unclaim/status) so the
    // CLI reads success / code from the body rather than a thrown HTTP error.
    return c.json(result);
  });

  app.get(internalPaths.agentGetConversationTaskDetail(':cid', ':aid'), c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const taskNumberRaw = c.req.query('task_number');
    const taskNumber = taskNumberRaw ? Number(taskNumberRaw) : NaN;
    if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
      return c.json({ error: 'task_number required', code: 'invalid_input' }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // The agent selects a task by its per-workspace number. Resolve + authorize
    // the target workspace (selector, default = current conversation's
    // workspace; agent must be a member — same cross-workspace model as `task
    // list --workspace-id`), gate `read_tasks` on THAT workspace, then read by
    // number. A missing task is a 404 (never leak existence outside the agent's
    // authorized scope).
    const selector = {
      ...(c.req.query('workspace_id') ? { workspaceId: c.req.query('workspace_id')! } : {}),
      ...(c.req.query('workspace_name') ? { workspaceName: c.req.query('workspace_name')! } : {}),
    };
    const resolved = ctx.taskService.resolveAgentDetailWorkspace(principal, selector);
    if (!('workspaceId' in resolved)) {
      const status =
        resolved.code === 'workspace_membership_required'
          ? 403
          : resolved.code === 'ambiguous_workspace'
            ? 409
            : 404;
      return c.json({ error: resolved.reason, code: resolved.code }, status);
    }
    {
      const denied = requireAgentCapability(c, ctx, principal, 'read_tasks', resolved.workspaceId);
      if (denied) return denied;
    }
    const detail = ctx.taskService.getTaskDetailByNumber(
      taskNumber,
      principal,
      resolved.workspaceId,
    );
    if (!detail) return c.json({ error: 'task not found', code: 'not_found' }, 404);
    return c.json({ task: detail });
  });
}
