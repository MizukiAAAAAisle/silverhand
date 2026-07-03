// Observability-only CLI diagnostics facet. The CLI's fire-and-forget
// pre-flight failure trace: excluded from the cli.invoke middleware (the
// middleware checks the suffix and skips it) and logged here as
// `cli.preflight_failure`. Registered FIRST in the composition root so it keeps
// its original position ahead of the membership mount and data-plane facets.
import type { Hono } from 'hono';
import {
  getAgentPrincipal,
  type AppEnv,
} from '../../auth/principal.js';
import {
  CliTraceInputSchema,
  internalPaths,
} from '@silverhand/shared';
import type { InternalRouteDeps } from './deps.js';

export function registerDiagnosticsRoutes(
  app: Hono<AppEnv>,
  deps: InternalRouteDeps,
): void {
  const { ctx } = deps;

  app.post(internalPaths.agentCliTrace(':cid', ':aid'), async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CliTraceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    ctx.loggers.cli.warn(
      {
        category: 'cli.preflight_failure',
        conversationId: principal.conversationId,
        agentId: principal.agentId,
        noun: parsed.data.noun ?? null,
        verb: parsed.data.verb ?? null,
        flags_seen: parsed.data.flags_seen ?? [],
        error_code: parsed.data.error_code ?? null,
        error_subkind: parsed.data.error_subkind ?? null,
        error_message: parsed.data.error_message ?? null,
        duration_ms: parsed.data.duration_ms ?? null,
        status: 'failure',
      },
      'cli.preflight_failure',
    );
    return c.json({ ok: true });
  });
}
