// Agent-owned schedule facet (silverhand CLI → backend). Per-agent surface.
// The route hangs off the calling conversation so the existing internal
// principal middleware (cid+aid → AgentPrincipal) authenticates the request
// without a second auth path. That path is the CREDENTIAL's coordinate and
// nothing more: `create` takes the wake destination as ONE ABSOLUTE ADDRESS
// in the body (#task:2021 P4-4), because under an agent-scoped session a single
// process serves many conversations and "where the call arrived from" is not a
// place. The old default — omit the field and fire wherever you called from —
// is gone, and with it the last ambient destination on this facet.
//
// `list` and `cancel` take no address by construction: schedules are owned by
// the AGENT, so the list is a union over every conversation and a cancel is
// addressed by the schedule's own id. Neither has a single stream to name.
//
// Errors map ScheduleError.code → structured `{ error, code }` JSON via
// scheduleServiceErrorResponse so the agent sees stable codes; the address's own
// refusals come from the one P4 mapping (`delivery-target.ts`).
import type { Hono } from 'hono';
import {
  agentPrincipalIn,
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import { scheduleServiceErrorResponse } from '../responses.js';
import {
  ScheduleCancelInputSchema,
  ScheduleCreateInputSchema,
  ScheduleListInputSchema,
} from '@silverhand/shared';
import { requireAgentConversationCapability } from './capability-scope.js';
import { resolveConversationTargetForRoute } from './delivery-target.js';
import type { InternalRouteDeps } from './deps.js';
import { internalAgentRoutePaths } from './paths.js';

export function registerScheduleRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx, conversations } = deps;

  app.post(internalAgentRoutePaths.schedules, async c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
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
    // The address is resolved BEFORE the service sees it, so the service is
    // handed a conversation id it never has to interpret. `write` intent is the
    // honest one: a fire INSERTS a wake there, which is also why an agent inbox
    // is refused here rather than at fire time, and why `dm:@handle` opens the
    // pair — a destination has to exist to be stored as a stable id.
    const resolved = resolveConversationTargetForRoute(c, deps, {
      address: parsed.data.target_conversation,
      operation: 'schedule_create',
      intent: 'write',
      now: Date.now(),
    });
    if (!resolved.ok) return resolved.response;
    const destination = resolved.target.stream.conversationId;
    const targetPrincipal = agentPrincipalIn(c, destination);
    // `manage_schedules` is judged where the wake LANDS, by the placement rule —
    // not by the calling conversation's workspace, and not by a raw
    // `workspace_id` (a `direct_pair` has none, and reading its null coordinate
    // as "no grant can exist here" would make every DM unschedulable).
    {
      const denied = requireAgentConversationCapability(
        c,
        ctx,
        targetPrincipal,
        'manage_schedules',
        conversations.getIdentity(destination),
      );
      if (denied) return denied;
    }
    try {
      // The address is dropped here, not merely unread downstream: the service's
      // input TYPE has no destination field, and stripping the value makes the
      // object match the type instead of quietly exceeding it. What it is handed
      // states the destination exactly once, as the id argument beside it.
      const { target_conversation: _address, ...definition } = parsed.data;
      const schedule = ctx.scheduleService.create(
        definition,
        principal.agentId,
        destination,
      );
      return c.json({ schedule });
    } catch (err) {
      const mapped = scheduleServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalAgentRoutePaths.scheduleList, async c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
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

  app.post(internalAgentRoutePaths.scheduleCancel, async c => {
    const aid = c.req.param('aid');
    if (!aid) {
      return c.json({ error: 'agent id required' }, 400);
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
