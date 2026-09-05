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
  CanonicalPositiveIntegerQuerySchema,
} from '@silverhand/shared';
import { isAgentHomeWorkspace, isAgentHomeWorkspaceOf } from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';
import { resolveDeliveryTargetForRoute } from './delivery-target.js';
import { internalAgentRoutePaths } from './paths.js';
import { resolveAgentQueryWorkspaceId } from './workspace-scope.js';

export function registerTaskRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, agents, conversations, workspaces } = deps;

  /** Task-domain actor: the verified principal plus the P1 runtime-scope
   *  projection (#task:2018 B1). The mapping is TOTAL over the verified
   *  RuntimePrincipal union — a missing principal after the auth middleware
   *  is an invariant breach and fails loud (500), never a silent
   *  reinterpretation as conversation scope. */
  const taskActorFrom = (
    c: Parameters<typeof getAgentPrincipal>[0],
  ) => {
    const principal = getAgentPrincipal(c);
    const runtime = c.get('runtimePrincipal');
    if (!runtime) {
      throw new Error(
        'runtimePrincipal missing after internal auth middleware — task routes cannot derive a scope',
      );
    }
    return runtime.kind === 'agent_slot'
      ? {
          kind: 'agent' as const,
          agentId: principal.agentId,
          conversationId: null,
          runtimeScope: 'agent' as const,
        }
      : {
          kind: 'agent' as const,
          agentId: principal.agentId,
          conversationId: runtime.conversationId,
          runtimeScope: 'conversation' as const,
        };
  };

  app.get(internalAgentRoutePaths.tasks, c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
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
    const actor = taskActorFrom(c);
    const conversation = actor.runtimeScope === 'conversation'
      ? conversations.get(actor.conversationId)
      : null;
    if (actor.runtimeScope === 'conversation' && !conversation) {
      return c.json({ error: 'conversation not found' }, 404);
    }

    // Agent-slot default list = the UNION of every board the actor can read
    // (§7.2.2, #task:2018): no ambient board is resolved and no single-board
    // capability gate applies — the service filters per board (membership ∧
    // read_tasks) and the repo narrows per task. An explicit workspace_id
    // keeps the validated single-board lane below (narrowing only, with its
    // typed board errors).
    if (actor.runtimeScope === 'agent' && parsed.data.workspace_id === undefined) {
      return c.json({
        tasks: ctx.taskService.list({
          actor,
          conversationId: parsed.data.conversation_id,
          status: parsed.data.status,
          taskNumbers: parsed.data.task_number,
          assigneeAgentId: parsed.data.assignee_id,
          limit: parsed.data.limit,
        }),
      });
    }

    // Conversation frame on a NON-workspace placement (P0-f): a DirectPair
    // frame reads its OWN board — the service derives it by placement, no
    // workspace resolution and no workspace capability table applies
    // (participation is the pair's authority; the frame gate above already
    // proved it). An explicit workspace selector keeps the validated
    // workspace lane below; the inbox still has no board and falls through to
    // the typed refusal in resolveAgentQueryWorkspaceId.
    if (
      parsed.data.workspace_id === undefined &&
      actor.runtimeScope === 'conversation' &&
      conversation!.workspace_id === null &&
      ctx.taskService.boardOfConversation(actor.conversationId) !== null
    ) {
      return c.json({
        tasks: ctx.taskService.list({
          actor,
          conversationId: parsed.data.conversation_id,
          status: parsed.data.status,
          taskNumbers: parsed.data.task_number,
          assigneeAgentId: parsed.data.assignee_id,
          limit: parsed.data.limit,
        }),
      });
    }

    // Agent-side --workspace-id: default is the actor's current conversation's
    // workspace; if the agent passes a different
    // workspace_id we must validate existence + membership at the route
    // layer so the service doesn't silently widen reads across
    // workspaces. We don't accept --workspace <name> for list — only
    // claim/unclaim/status need the disambiguation.
    // The workspace this narrowing needs is the calling conversation's, and a
    // `direct_pair` has none (doc §4.2) — so from a DM session the question has no
    // ambient answer: name a workspace explicitly rather than read across all of
    // them (v71).
    if (conversation === null && parsed.data.workspace_id === undefined) {
      return c.json({
        error: 'agent-scoped task board reads must name workspace_id when narrowing',
        code: 'workspace_scope_required',
      }, 400);
    }
    const scope = conversation === null
      ? { ok: true as const, workspaceId: parsed.data.workspace_id! }
      : resolveAgentQueryWorkspaceId(c, conversation, parsed.data.workspace_id);
    if (!scope.ok) return scope.response;
    const effectiveWorkspaceId = scope.workspaceId;
    if (effectiveWorkspaceId !== conversation?.workspace_id) {
      const targetWs = workspaces.get(effectiveWorkspaceId);
      if (!targetWs) {
        return c.json(
          { error: `workspace ${effectiveWorkspaceId} not found`, code: 'unknown_workspace' },
          404,
        );
      }
      const isMember =
        isAgentHomeWorkspace(targetWs)
          ? isAgentHomeWorkspaceOf(targetWs, aid)
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
        actor,
        workspaceId: effectiveWorkspaceId,
        conversationId: parsed.data.conversation_id,
        status: parsed.data.status,
        taskNumbers: parsed.data.task_number,
        assigneeAgentId: parsed.data.assignee_id,
        limit: parsed.data.limit,
      }),
    });
  });

  app.post(internalAgentRoutePaths.taskCreate, async c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    // The DESTINATION is whatever the required address resolves to — one
    // coordinate, one resolver, no ambient "here" (#task:2021 P4-4). Filing a
    // task is a single-stream write, so it goes through the SAME resolution as a
    // message send: grammar, then participation, then the inbox refusal, then the
    // thread suffix as a cluster root. Two things fall out of that and are worth
    // naming, because this door used to own both: an unknown destination and one
    // the agent may not use are now indistinguishable BY CONSTRUCTION rather than
    // by this route remembering to collapse them into `forbidden`, and a
    // mid-cluster reply id is refused instead of being widened to its root.
    const resolved = resolveDeliveryTargetForRoute(c, deps, {
      address: parsed.data.target,
      operation: 'task_create',
      intent: 'write',
      now: Date.now(),
    });
    if (!resolved.ok) return resolved.response;
    const destination = resolved.target.stream.conversationId;
    // Cross-conversation create (the address named a stream other than the one
    // this session is anchored in) is a dispatch: the task is filed unclaimed so a
    // member of the destination picks it up. `--claim` self-assigns to the caller,
    // which defeats that intent and would let A pin work it cannot execute onto B.
    // Refused before any task/event is written, as the typed 200 op-error envelope
    // (like source_conflict) so the CLI classifies it by `code` and owns the sole
    // human-readable reason string. Same-stream create+claim is untouched.
    //
    // "Cross" is a fact about the runtime actor, not the auth principal — the same
    // predicate the service's `crossConversation` bit uses (task-service.ts),
    // defined only for a ConversationSlot (`runtimeScope === 'conversation'`), which
    // has an origin anchor to compare against the destination. An AgentSlot has no
    // anchor (`conversationId` is null), so "cross" does not apply to it: it falls
    // through to the normal create_tasks/write_tasks (workspace) or participation
    // (direct_pair) gate below — the same authority the two-step
    // "create → by-id claim" spends (#task:2150).
    //
    // Decided after resolution, because "another conversation" is a fact about the
    // resolved stream and not a flag this route can read off the request. That
    // costs nothing in disclosure — being a participant is already observable to a
    // participant, which is the only case that gets this far — and `--claim` with a
    // `dm:@handle` that has no pair yet opens the pair (main-line write intent) and
    // lands here: an empty pair between two principals who may DM is not a leak, and
    // bending the intent to avoid it would make the same address answer differently
    // depending on an unrelated flag.
    const actor = taskActorFrom(c);
    if (
      parsed.data.claim === true
      && actor.runtimeScope === 'conversation'
      && destination !== actor.conversationId
    ) {
      return c.json({ error: 'cross_conversation_claim' });
    }
    // What the resolver has NOT answered: the workspace axis. Participation and
    // existence are its verdict, so what is left here is which
    // axis authorizes and judges capabilities:
    //  - workspace placement: the destination workspace must be accessible to the
    //    agent, and its create_tasks (plus write_tasks for --claim) decide;
    //  - direct_pair: PARTICIPATION is the whole authority — a pair has no
    //    workspace, no roster and no capability rows (P0-b owner-self precedent).
    // `canPostToConversation` / `canViewConversation` are still unusable here:
    // their agent branches are origin-bound (they require `principal
    // .conversationId === conversation.id` AND derive the workspace from the
    // ORIGIN), so they would refuse every cross-conversation create.
    const destWorkspaceId =
      resolved.target.placementKind === 'workspace'
        ? (ctx.taskService.boardOfConversation(destination)?.workspaceId ?? null)
        : null;
    if (
      resolved.target.placementKind === 'workspace' &&
      (destWorkspaceId === null ||
        !canAgentAccessWorkspace(ctx, principal.agentId, destWorkspaceId))
    ) {
      // Same shape as an address that resolves to nothing: a workspace the agent
      // cannot reach must not be distinguishable from one that is not there.
      return c.json({ error: 'forbidden' }, 403);
    }
    // Capabilities are judged on the DESTINATION's workspace — a cross-workspace
    // create needs create_tasks (and write_tasks for --claim) in B, not in the
    // origin workspace. A pair board has no capability table (above).
    if (destWorkspaceId !== null) {
      const denied = requireAgentCapability(c, ctx, principal, 'create_tasks', destWorkspaceId);
      if (denied) return denied;
    }
    // `--claim` self-assigns the created task, which is a task write — gate it
    // on write_tasks in addition to create_tasks (same capability claim needs).
    if (parsed.data.claim === true && destWorkspaceId !== null) {
      const denied = requireAgentCapability(c, ctx, principal, 'write_tasks', destWorkspaceId);
      if (denied) return denied;
    }
    const result = await ctx.taskService.createTasks({
      conversationId: destination,
      actor,
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
      threadRootId: resolved.target.stream.threadRootId,
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

  app.post(internalAgentRoutePaths.taskClaim, async c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ClaimTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const taskActor = taskActorFrom(c);
    // Wire optional --workspace-id / --workspace selector.
    // Schema XOR enforces exclusivity; the service does membership +
    // existence checks per result entry.
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    // P0-g (#task:2018): the schema guarantees EXACTLY ONE of task_numbers /
    // task_ids, so the batch is homogeneous — numbers resolve on one explicit
    // board, ids resolve globally (and are folded per the caller's principal
    // scope inside the service).
    const refs =
      parsed.data.task_ids !== undefined
        ? parsed.data.task_ids.map(taskId => ({ taskId }))
        : (parsed.data.task_numbers ?? []).map(taskNumber => ({ taskNumber }));
    const results = [];
    for (const by of refs) {
      results.push(await ctx.taskService.claimTask({ actor: taskActor, by, workspaceSelector }));
    }
    return c.json({ results });
  });

  app.post(internalAgentRoutePaths.taskUnclaim, async c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UnclaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.unclaimTask({
      actor: taskActorFrom(c),
      by:
        parsed.data.task_id !== undefined
          ? { taskId: parsed.data.task_id }
          : { taskNumber: parsed.data.task_number! },
      workspaceSelector,
    });
    return c.json(result);
  });

  app.post(internalAgentRoutePaths.taskUpdateStatus, async c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.updateStatus({
      actor: taskActorFrom(c),
      by:
        parsed.data.task_id !== undefined
          ? { taskId: parsed.data.task_id }
          : { taskNumber: parsed.data.task_number! },
      status: parsed.data.status,
      workspaceSelector,
    });
    return c.json(result);
  });

  app.post(internalAgentRoutePaths.taskEdit, async c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = EditTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    // write_tasks is gated INSIDE the service on the RESOLVED task workspace
    // (the selector-resolved or current-conversation workspace), mirroring
    // claim/unclaim/status.
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.editTask({
      actor: taskActorFrom(c),
      by:
        parsed.data.task_id !== undefined
          ? { taskId: parsed.data.task_id }
          : { taskNumber: parsed.data.task_number! },
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

  app.get(internalAgentRoutePaths.taskDetail, c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
    }
    const taskNumberRaw = c.req.query('task_number');
    const taskIdRaw = c.req.query('task_id');
    // P0-g (#task:2018): exactly ONE of task_number / task_id. The id arm
    // takes no workspace selector — a global id already determines its board.
    if (taskIdRaw !== undefined && taskNumberRaw !== undefined) {
      return c.json(
        { error: 'provide exactly one of task_number or task_id', code: 'invalid_input' },
        400,
      );
    }
    if (taskIdRaw !== undefined) {
      if (taskIdRaw === '') {
        return c.json({ error: 'task_id must be non-empty', code: 'invalid_input' }, 400);
      }
      if (c.req.query('workspace_id') || c.req.query('workspace_name')) {
        return c.json(
          {
            error: 'workspace selectors only apply to task_number; a task id already determines its board',
            code: 'invalid_input',
          },
          400,
        );
      }
      // NO route-level workspace resolution or capability gate here: for a
      // by-id read both axes are folded into the service's indistinguishable
      // gate (participation ∧ read_tasks ∧ ambient board), and every failure
      // is the SAME 404 a by-number miss produces — a typed 403 would be an
      // id-probing oracle (agent-scoped-session-v1 §4.5).
      const detail = ctx.taskService.getTaskDetailByGlobalId(taskIdRaw, taskActorFrom(c));
      if (!detail) return c.json({ error: 'task not found', code: 'not_found' }, 404);
      return c.json({ task: detail });
    }
    const parsedTaskNumber = CanonicalPositiveIntegerQuerySchema.safeParse(taskNumberRaw);
    if (!parsedTaskNumber.success) {
      return c.json({ error: 'task_number required', code: 'invalid_input' }, 400);
    }
    const taskNumber = parsedTaskNumber.data;
    const principal = getAgentPrincipal(c);
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
    const actor = taskActorFrom(c);
    const resolved = ctx.taskService.resolveAgentDetailWorkspace(actor, selector);
    if (!('boardKey' in resolved)) {
      const status =
        resolved.code === 'workspace_membership_required'
          ? 403
          : resolved.code === 'ambiguous_workspace'
            ? 409
            : 404;
      return c.json({ error: resolved.reason, code: resolved.code }, status);
    }
    // Capability is a WORKSPACE-board fact; a pair board's read authority is
    // participation, already validated by the frame gate above (P0-f §4.4).
    if (resolved.workspaceId !== null) {
      const denied = requireAgentCapability(c, ctx, principal, 'read_tasks', resolved.workspaceId);
      if (denied) return denied;
    }
    const detail = ctx.taskService.getTaskDetailByNumber(
      taskNumber,
      actor,
      resolved.boardKey,
    );
    if (!detail) return c.json({ error: 'task not found', code: 'not_found' }, 404);
    return c.json({ task: detail });
  });
}
