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
import { bodyLimit } from 'hono/body-limit';
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
   * Pre-parse bound (#task:1665): reject an oversized body — declared or
   * chunked — BEFORE it is buffered. The bounded parse below measures the string
   * it was handed, which means the bytes are already in memory by the time it
   * can say "too big"; a byte cap inside a parser is a cap on what we ACCEPT,
   * never on what we BUFFER. This endpoint is reachable by any authenticated
   * caller over the public API, so the buffering side needs its own bound.
   *
   * Both bounds are the SAME constant on purpose: our own client structurally
   * cannot reach it (a full 12-entry report with 40-char version strings is
   * ~2.6 KiB), so "over the bound" already means "not our client" — one number
   * keeps the two checks from ever disagreeing about who is compliant.
   */
  const reportBodyLimit = bodyLimit({
    maxSize: LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES,
    onError: c =>
      c.json(
        {
          error: 'request body exceeds the client-diagnostics bound',
          code: 'content_too_large',
          max_body_bytes: LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES,
        },
        413,
      ),
  });

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
   * The response code does not steer client retention: reporting is at-most-once
   * by contract, so the client has already consumed its breadcrumb before it
   * sends and drops the sample on ANY outcome. Nothing here will ever be retried
   * with the same bytes.
   */
  app.post(apiPaths.clientLayoutMigrationDiagnostics, reportBodyLimit, async c => {
    const viewerUserId = requireViewerUserId(c);
    // `bodyLimit` signals a chunked-body overflow by erroring the wrapped stream
    // mid-read; rethrow it so the middleware's post-`next()` check turns it into
    // the 413, instead of degrading it to an empty body → 400 invalid_report.
    let raw: string;
    try {
      raw = await c.req.text();
    } catch (err) {
      if (err instanceof Error && err.name === 'BodyLimitError') throw err;
      raw = '';
    }
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
