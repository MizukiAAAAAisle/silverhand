import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * POST /api/register — the one-shot registration endpoint, sole
 * creator of `users` rows. Asserts:
 *   - happy path INSERTs a new user and writes
 *     `app_settings.viewer_user_id` atomically
 *   - second call (viewer already registered) → 409 `already_registered`
 *   - colliding name → 409 `name_taken` (cross-namespace trigger)
 *   - schema rejects malformed names with 400
 *
 * The test fixture pre-registers a `'local'` user (see tests/utils/db.ts);
 * registration tests `unregisterViewer` to recreate the pre-registration
 * state (no row + no viewer pointer) before exercising the endpoint.
 */
describe('POST /api/register', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /**
   * Reset the fixture into the production pre-registration state:
   * `users` row absent + `app_settings.viewer_user_id` unset.
   */
  function unregisterViewer(test: TestApp): void {
    test.ctx.db
      .prepare(`DELETE FROM app_settings WHERE key = 'viewer_user_id'`)
      .run();
    test.ctx.db.prepare(`DELETE FROM users WHERE id = 'local'`).run();
  }

  it('atomically INSERTs the user row and writes viewer_user_id', async () => {
    t = buildTestApp();
    unregisterViewer(t);

    const res = await http(t).post(apiPaths.register, {
      name: 'shiki',
      display_name: 'Shiki',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.name).toBe('shiki');
    expect(body.display_name).toBe('Shiki');

    // Atomic guarantee: the same id is written into app_settings.
    const pointer = t.ctx.db
      .prepare(
        `SELECT value FROM app_settings WHERE key = 'viewer_user_id'`,
      )
      .get() as { value: string } | undefined;
    expect(pointer?.value).toBe(body.id);

    // The user row exists with the same id.
    const row = t.ctx.db
      .prepare(`SELECT id, name, display_name FROM users WHERE id = ?`)
      .get(body.id) as
      | { id: string; name: string; display_name: string }
      | undefined;
    expect(row?.name).toBe('shiki');
    expect(row?.display_name).toBe('Shiki');
  });

  it('display_name defaults to name when omitted', async () => {
    t = buildTestApp();
    unregisterViewer(t);

    const res = await http(t).post(apiPaths.register, { name: 'shiki' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe('shiki');
    expect(body.display_name).toBe('shiki');
  });

  it('rejects a second call with 409 already_registered', async () => {
    t = buildTestApp();
    // Fixture has viewer_user_id set + 'local' user row inserted, so
    // calling /api/register models a duplicate registration.
    const res = await http(t).post(apiPaths.register, { name: 'shiki' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe('already_registered');
  });

  it('rejects a name that collides with an existing agents.name', async () => {
    t = buildTestApp();
    // Seed the colliding agent BEFORE unregistering — POST /api/agents
    // requires a registered viewer (the public-principal gate).
    await http(t).post('/api/agents', { name: 'collide', runtime: 'claude' });
    unregisterViewer(t);

    const res = await http(t).post(apiPaths.register, { name: 'collide' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe('name_taken');
  });

  it('rejects malformed names with 400', async () => {
    t = buildTestApp();
    unregisterViewer(t);

    // Too short.
    const tooShort = await http(t).post(apiPaths.register, { name: 'a' });
    expect(tooShort.status).toBe(400);

    // Disallowed character.
    const bad = await http(t).post(apiPaths.register, { name: 'has space' });
    expect(bad.status).toBe(400);

    // Numeric-first names break MENTION_RE (@<name>) which requires an
    // alpha first char. `users.name` is the permanent identity anchor,
    // so the registration schema must keep numeric-first out — otherwise
    // a user could register `123` and no one could ever @-mention them.
    const numericFirst = await http(t).post(apiPaths.register, {
      name: '123abc',
    });
    expect(numericFirst.status).toBe(400);

    // Dash- / underscore-leading is also out (same alpha-first contract).
    const dashFirst = await http(t).post(apiPaths.register, { name: '-shiki' });
    expect(dashFirst.status).toBe(400);
  });

  it('backfills workspace_users and conversation_users for every existing row at registration time', async () => {
    t = buildTestApp();
    // Drop the test-fixture auto-seed triggers so we can observe
    // *only* the register-time backfill behavior without other
    // fixture users being snapshot in. Production has no such triggers.
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    unregisterViewer(t);
    // Also drop the other fixture users so the post-register row set
    // we assert on is unambiguously the one written by register().
    t.ctx.db.exec(`DELETE FROM users`);

    // Insert a workspace + conversation pair *before* registration so
    // the v25 register-time backfill path (the "DB ran v25 with no
    // viewer, then registers later" branch in UserService.register)
    // has something to walk over. The fixture already ensures a
    // 'local' host row.
    const now = Date.now();
    const hostId = (
      t.ctx.db
        .prepare<[], { id: string }>(`SELECT id FROM hosts LIMIT 1`)
        .get()!
    ).id;
    t.ctx.db
      .prepare(
        `INSERT INTO workspaces
           (id, name, description, workspace_path, workspace_kind,
            workspace_host_id, owner_agent_id, created_at, updated_at)
         VALUES ('ws1', 'pre', NULL, '/tmp/x', 'regular', ?, NULL, ?, ?)`,
      )
      .run(hostId, now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO conversations
           (id, workspace_id, kind, title, workspace_path, status,
            created_at, updated_at)
         VALUES ('c1', 'ws1', 'channel', 't', '/tmp/x', 'open', ?, ?)`,
      )
      .run(now, now);

    const res = await http(t).post(apiPaths.register, { name: 'shiki' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const newId: string = body.id;

    // Membership edges exist for the freshly-registered viewer.
    const wsRow = t.ctx.db
      .prepare<[], { workspace_id: string; user_id: string }>(
        `SELECT workspace_id, user_id FROM workspace_users`,
      )
      .all();
    expect(wsRow).toEqual([{ workspace_id: 'ws1', user_id: newId }]);
    const convRow = t.ctx.db
      .prepare<[], { conversation_id: string; user_id: string }>(
        `SELECT conversation_id, user_id FROM conversation_users`,
      )
      .all();
    expect(convRow).toEqual([{ conversation_id: 'c1', user_id: newId }]);
  });

  it('rejects display_name with control chars or Unicode line separators (400)', async () => {
    // Defense-in-depth: prompt-side `quotePromptValue` escapes these,
    // but the write-side `DisplayNameSchema` keeps them out of the DB
    // entirely. See dto.ts `DISPLAY_NAME_FORBIDDEN_RE`.
    const cases = [
      'first\nsecond', // U+000A LF
      'tab\there', // U+0009 HTAB
      'cr\rhere', // U+000D CR
      'null\x00here', // U+0000
      'nel\u0085here', // U+0085 NEXT LINE
      'ls\u2028here', // U+2028 LINE SEPARATOR
      'ps\u2029here', // U+2029 PARAGRAPH SEPARATOR
    ];
    for (const display_name of cases) {
      t = buildTestApp();
      // Each iteration owns its own app (single-shot register endpoint).
      t.ctx.db
        .prepare(`DELETE FROM app_settings WHERE key = 'viewer_user_id'`)
        .run();
      t.ctx.db.prepare(`DELETE FROM users WHERE id = 'local'`).run();

      const res = await http(t).post(apiPaths.register, {
        name: 'shiki',
        display_name,
      });
      expect(res.status, `display_name=${JSON.stringify(display_name)}`).toBe(
        400,
      );
      t.cleanup();
      t = null;
    }
  });
});
