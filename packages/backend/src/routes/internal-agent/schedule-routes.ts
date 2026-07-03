// Agent-owned schedule facet (silverhand CLI → backend). Per-agent surface.
// The route hangs off the calling conversation so the existing internal
// principal middleware (cid+aid → AgentPrincipal) authenticates the request
// without a second auth path; the calling `cid` is also passed into the service
// as the default `target_conversation_id` so creating a schedule in DM defaults
// to firing in DM, in a channel defaults to firing in that channel, etc. (the
// agent can always override with `target_conversation_id` in the body to fire
// elsewhere it's a member of). Errors map ScheduleError.code → structured
// `{ error, code }` JSON via scheduleServiceErrorResponse so the agent sees
// stable codes.
import type { Hono } from 'hono';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import { scheduleServiceErrorResponse } from '../responses.js';
import {
  ScheduleCancelInputSchema,
  ScheduleCreateInputSchema,
  ScheduleListInputSchema,
  internalPaths,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';

export function registerScheduleRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx } = deps;

  app.post(internalPaths.agentScheduleCreate(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    try {
      const schedule = ctx.scheduleService.create(
        parsed.data,
        principal.agentId,
        cid,
      );
      return c.json({ schedule });
    } catch (err) {
      const mapped = scheduleServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentScheduleList(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleListInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    const schedules = ctx.scheduleService.list(
      principal.agentId,
      parsed.data.status,
      parsed.data.limit,
    );
    return c.json({ schedules });
  });

  app.post(internalPaths.agentScheduleCancel(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleCancelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    try {
      const schedule = ctx.scheduleService.cancel(
        parsed.data.schedule_id,
        principal.agentId,
      );
      return c.json({ schedule });
    } catch (err) {
      const mapped = scheduleServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });
}
