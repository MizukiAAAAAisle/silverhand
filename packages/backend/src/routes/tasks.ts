// Human-facing task board: list + claim / unclaim / status overrides + edit
// (title/content, last-write-wins) + single-task detail read. All
// handlers delegate to ctx.taskService (the status state machine, edit, and
// capability gating all live in the service).
import { Hono } from 'hono';
import {
  apiPaths,
  HumanClaimTaskInputSchema,
  HumanEditTaskInputSchema,
  HumanUpdateTaskStatusInputSchema,
  ListTasksQuerySchema,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { getUserPrincipal } from '../auth/principal.js';

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
