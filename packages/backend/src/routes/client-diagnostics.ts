// #task:1664 — the intake for client-side diagnostics that CANNOT be observed
// from the server at the time they happen.
//
// Today there is exactly one: a layout-v2 migration failure. It blocks desktop
// startup by design and the daemon never connects, so nothing reaches the
// server through the normal handshake (`LayoutMigrationOutcome` can only carry
// `migrated | already_current`). The desktop keeps a local breadcrumb and posts
// it on its next authenticated start.
//
// Observability only, like `cli.preflight_failure` and the #task:1530
// release-telemetry line: ONE structured log line per accepted report, no table,
// no read side. Nothing in the product reads this back — if a future feature
// needs to, it needs a persistence design, not a quiet insert here.
//
// Auth/principal is inherited from the parent api app middleware (user-session
// bearer). There is no ACL beyond "authenticated": the payload carries no
// resource id to authorize against — it is a fact about the caller's own
// machine, attributed to the caller's user id by the principal, never by a
// caller-declared field (invariant 4).
import { Hono } from 'hono';
import {
  LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES,
  apiPaths,
  parseLayoutMigrationDiagnosticsReport,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import { requireViewerUserId } from '../auth/principal.js';

export interface ClientDiagnosticsRouteDeps {
  ctx: BackendContext;
}

export function createClientDiagnosticsApp(
  deps: ClientDiagnosticsRouteDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx } = deps;

  /**
   * Accept a layout-v2 migration failure report.
   *
   * The body is untrusted (#task:1530 precedent): read as TEXT and put through
   * the SAME bounded parse the local reader uses, so the byte cap and the
   * `.strict()` schema are one contract instead of two. A rejected body is
   * answered `400 invalid_report` and never logged — the raw bytes are exactly
   * what we refuse to ingest, so echoing them into the log would defeat the
   * closed-payload guarantee.
   *
   * `400` is a DELIVERED verdict: the client deletes its breadcrumb on it. That
   * is correct — bytes this server rejects will be rejected identically forever,
   * so retrying them is a permanent no-op, and a client that keeps them would
   * carry them across every launch.
   */
  app.post(apiPaths.clientLayoutMigrationDiagnostics, async c => {
    const viewerUserId = requireViewerUserId(c);
    const raw = await c.req.text();
    const parsed = parseLayoutMigrationDiagnosticsReport(raw);
    if (parsed.status !== 'valid') {
      ctx.logger.warn(
        {
          action: 'layout_migration_diagnostics_rejected',
          user_id: viewerUserId,
          status: parsed.status,
          byte_limit: LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES,
        },
        'rejected a layout-v2 migration diagnostics report',
      );
      return c.json({ error: 'invalid_report' }, 400);
    }

    // One line per entry, fields copied EXPLICITLY (never a spread of parsed
    // JSON): the log schema is then a property of this file, not of whatever a
    // future payload version happens to carry.
    for (const entry of parsed.value.reports) {
      ctx.logger.info(
        {
          action: 'layout_migration_failed',
          user_id: viewerUserId,
          component: entry.component,
          stage: entry.stage,
          code: entry.code,
          layout_version: entry.layout_version,
          count: entry.count,
          ...(entry.component === 'desktop'
            ? { app_version: entry.app_version }
            : { daemon_version: entry.daemon_version }),
        },
        'client reported a layout-v2 migration failure',
      );
    }
    return c.body(null, 204);
  });

  return app;
}
