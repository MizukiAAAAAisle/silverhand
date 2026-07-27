import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * #task:1664 — the client-diagnostics intake for layout-v2 migration failures.
 *
 * The failure being reported happened on a boot that never reached a server, so
 * this route is the ONLY way the fact arrives. Pins:
 *   1. A valid report is accepted with 204 and logged as one line PER entry,
 *      attributed to the principal's user id (never a caller-declared field).
 *   2. An invalid body — unknown key, wrong shape, non-JSON, oversized — is
 *      refused 400 and its bytes are NEVER logged. 400 is a permanent verdict
 *      the client consumes by deleting its breadcrumb.
 *   3. Nothing is persisted: this is observability, not a table.
 */

interface LogLine {
  fields: Record<string, unknown>;
  msg: string;
}

function captureLogs(t: TestApp): LogLine[] {
  const lines: LogLine[] = [];
  const record = (fields: unknown, msg?: string) => {
    lines.push({
      fields: (fields ?? {}) as Record<string, unknown>,
      msg: msg ?? '',
    });
  };
  // Direct ctx mutation is the fixture's supported way to observe backend
  // behavior that has no read side (see utils/app.ts).
  t.ctx.logger = {
    info: record,
    warn: record,
    error: record,
  } as typeof t.ctx.logger;
  return lines;
}

const DESKTOP_ENTRY = {
  component: 'desktop',
  app_version: '0.2.0',
  stage: 'engine',
  code: 'layout_conflict',
  layout_version: 2,
  count: 3,
};

const DAEMON_ENTRY = {
  component: 'daemon',
  daemon_version: '0.2.1',
  stage: 'workspace_data_convergence',
  code: 'flatten_move_failed',
  layout_version: 2,
  count: 1,
};

describe(`POST ${apiPaths.clientLayoutMigrationDiagnostics}`, () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('accepts a report and logs one attributed line per entry', async () => {
    t = await buildTestApp();
    const lines = captureLogs(t);

    const res = await http(t).post(apiPaths.clientLayoutMigrationDiagnostics, {
      reports: [DESKTOP_ENTRY, DAEMON_ENTRY],
    });

    expect(res.status).toBe(204);
    const reported = lines.filter(
      l => l.fields.action === 'layout_migration_failed',
    );
    expect(reported).toHaveLength(2);
    expect(reported[0]!.fields).toEqual({
      action: 'layout_migration_failed',
      user_id: 'local',
      component: 'desktop',
      stage: 'engine',
      code: 'layout_conflict',
      layout_version: 2,
      count: 3,
      app_version: '0.2.0',
    });
    // The daemon arm carries its OWN version field and never the desktop one.
    expect(reported[1]!.fields).toEqual({
      action: 'layout_migration_failed',
      user_id: 'local',
      component: 'daemon',
      stage: 'workspace_data_convergence',
      code: 'flatten_move_failed',
      layout_version: 2,
      count: 1,
      daemon_version: '0.2.1',
    });
  });

  it('refuses a smuggled free-text key without logging its bytes', async () => {
    t = await buildTestApp();
    const lines = captureLogs(t);
    const secret = 'EACCES: /Users/someone/.silverhand/workspace-data';

    const res = await http(t).post(apiPaths.clientLayoutMigrationDiagnostics, {
      reports: [{ ...DESKTOP_ENTRY, message: secret }],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_report' });
    expect(
      lines.some(l => l.fields.action === 'layout_migration_failed'),
    ).toBe(false);
    expect(JSON.stringify(lines)).not.toContain(secret);
    expect(
      lines.some(
        l =>
          l.fields.action === 'layout_migration_diagnostics_rejected' &&
          l.fields.status === 'invalid',
      ),
    ).toBe(true);
  });

  it('refuses a non-JSON body, an empty report, and an oversized body', async () => {
    t = await buildTestApp();
    captureLogs(t);
    const send = (body: string) =>
      http(t!).post(apiPaths.clientLayoutMigrationDiagnostics, undefined, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

    expect((await send('nope')).status).toBe(400);
    expect((await send(JSON.stringify({ reports: [] }))).status).toBe(400);
    expect(
      (
        await send(
          JSON.stringify({
            reports: Array.from({ length: 400 }, () => DESKTOP_ENTRY),
          }),
        )
      ).status,
    ).toBe(400);
  });
});
