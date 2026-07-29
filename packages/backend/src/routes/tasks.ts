// Human-facing task board: list + claim / unclaim / status overrides + edit
// (title/content, last-write-wins) + single-task detail read. All
// handlers delegate to ctx.taskService (the status state machine, edit, and
// capability gating all live in the service).
import { Hono } from 'hono';
import {
  apiPaths,
  HumanClaimTaskInputSchema,
  HumanCreateTaskInputSchema,
  HumanEditTaskInputSchema,
  HumanUpdateTaskStatusInputSchema,
  ListTasksQuerySchema,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { getUserPrincipal } from '../auth/principal.js';
import { canPostToConversation } from '../permissions.js';

export interface TasksRouteDeps {
  ctx: BackendContext;
}

export function createTasksApp(deps: TasksRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx } = deps;

  // ── Tasks (human-facing list + overrides) ────────────────────────
  app.get(apiPaths.tasks, c => {
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
    return c.json({
      tasks: ctx.taskService.list({
        actor: getUserPrincipal(c),
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        status: parsed.data.status,
        taskNumbers: parsed.data.task_number,
        assigneeAgentId: parsed.data.assignee_id,
        limit: parsed.data.limit,
      }),
    });
  });

  // Human panel direct-create. Shares the ONE actor-agnostic
  // `taskService.createTasks` with the agent CLI — task row + `task_create`
  // system event + `created_event_message_id` backfill in one txn. The
  // human-policy edges: sourceless (no `source_message_id`), unassigned (no
  // `claim` — a user actor's claim is ignored by the service), authorized by
  // `canPostToConversation` (membership + view), NOT a `create_tasks`
  // capability (that is an agent concept). The target conversation is the
  // EXPLICIT `conversation_id` from the writable-channel selector, never an
  // ambient current channel. On success returns ONLY the identity the create
  // txn authoritatively produced (`id`/`task_number`/`title`) — the SAME shape
  // the agent create returns; the panel opens the modal by `id` and reads the
  // detail via GET /api/tasks/:id, so the ACK never depends on a post-commit
  // re-read that could report a committed write as a failure and drive a
  // duplicate retry.
  app.post(apiPaths.tasks, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanCreateTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const actor = getUserPrincipal(c);
    const conversationId = parsed.data.conversation_id;
    // Fail-closed authz — the SAME membership/view primitive the agent create
    // route uses. A non-member (incl. a public-channel viewer, or an unknown
    // conversation) is rejected before the service runs. We surface the SAME
    // discriminated `{success:false, code}` envelope as the service-level
    // failures so the renderer classifies on `code` alone (never a reason
    // string): `not_conversation_member` conflates unknown + non-member, so
    // existence never leaks, while a member of a closed/archived conversation
    // still reaches the service and gets the distinct typed code.
    if (!canPostToConversation(ctx, actor, conversationId)) {
      return c.json({ success: false, code: 'not_conversation_member' as const }, 403);
    }
    const result = await ctx.taskService.createTasks({
      conversationId,
      actor,
      tasks: [
        {
          title: parsed.data.title,
          ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
        },
      ],
    });
    if ('error' in result) {
      switch (result.error) {
        case 'conversation_not_found':
          return c.json({ success: false, code: result.error }, 404);
        case 'conversation_closed':
        case 'conversation_archived':
          return c.json({ success: false, code: result.error }, 409);
        case 'not_conversation_member':
          return c.json({ success: false, code: result.error }, 403);
        default:
          // source_* / agent_not_found are unreachable for a sourceless human
          // create — surface as a 500 rather than silently claiming success.
          return c.json({ error: 'unexpected create failure', code: result.error }, 500);
      }
    }
    const created = result.tasks[0];
    if (!created) {
      // The create txn produced no row — a genuine internal invariant break,
      // not a projection miss. This is the ONLY 500 the success path can hit.
      return c.json({ error: 'create produced no task', code: 'internal' }, 500);
    }
    return c.json({ success: true, task: created }, 201);
  });

  app.post('/api/tasks/:taskId/claim', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanClaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await ctx.taskService.claimTask({
      actor: getUserPrincipal(c),
      by: { taskId: c.req.param('taskId') },
      assignee: { agentId: parsed.data.agent_id },
    });
    return c.json(result, result.success ? 200 : 409);
  });

  // Clear the assignee. Assignment-only: the task's status and close timestamp
  // are untouched, and a `done`/`closed` task is refused (409) rather than
  // silently reopened.
  app.post('/api/tasks/:taskId/unclaim', async c => {
    const result = await ctx.taskService.unclaimTask({
      actor: getUserPrincipal(c),
      by: { taskId: c.req.param('taskId') },
    });
    return c.json(result, result.success ? 200 : 409);
  });

  app.post('/api/tasks/:taskId/status', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanUpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await ctx.taskService.updateStatus({
      actor: getUserPrincipal(c),
      by: { taskId: c.req.param('taskId') },
      status: parsed.data.status,
    });
    return c.json(result, result.success ? 200 : 409);
  });

  app.post('/api/tasks/:taskId/edit', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanEditTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await ctx.taskService.editTask({
      actor: getUserPrincipal(c),
      by: { taskId: c.req.param('taskId') },
      // Omitted flag → null ("leave unchanged"); explicit "" clears the body.
      title: parsed.data.title ?? null,
      body: parsed.data.body ?? null,
    });
    if (result.success) return c.json(result);
    const status = result.code === 'task_not_found' ? 404 : 400;
    return c.json(result, status);
  });

  app.get('/api/tasks/:taskId', c => {
    const detail = ctx.taskService.getTaskDetail(
      c.req.param('taskId'),
      getUserPrincipal(c),
    );
    if (!detail) return c.json({ error: 'task not found', code: 'not_found' }, 404);
    return c.json({ task: detail });
  });

  return app;
}
