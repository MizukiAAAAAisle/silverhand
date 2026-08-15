// Identity-creation convergence (#task:1707).
//
// A genuine first-time identity creation must announce itself on the `app`
// scope exactly like a profile edit does, so every already-open client
// converges its `['users']` / `['agents']` directory and identity carriers
// without a remount. This reuses the existing id-only `user_changed` /
// `agent_changed` events — no new event kind, no authoritative payload
// (recovery still flows through the subject-kind snapshot consumers).
//
// What these tests pin is the SIGNAL and its gating: real creation publishes
// once, and an idempotent echo or a rejected creation stays silent. Positive
// and silent cases share one capture helper per actor, so a silent-case
// assertion cannot pass vacuously.
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentChangedEventSchema,
  UserChangedEventSchema,
  authPaths,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('identity-creation app-scope broadcast (#task:1707)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /** Capture `user_changed` ids from the moment of the call. */
  function captureUserChanged(app: TestApp): string[] {
    const ids: string[] = [];
    app.ctx.events.subscribeScope('app', e => {
      if (e.kind !== 'user_changed') return;
      const parsed = UserChangedEventSchema.safeParse(e.payload);
      if (parsed.success) ids.push(parsed.data.user_id);
    });
    return ids;
  }

  /** Capture `agent_changed` ids from the moment of the call. */
  function captureAgentChanged(app: TestApp): string[] {
    const ids: string[] = [];
    app.ctx.events.subscribeScope('app', e => {
      if (e.kind !== 'agent_changed') return;
      const parsed = AgentChangedEventSchema.safeParse(e.payload);
      if (parsed.success) ids.push(parsed.data.agent_id);
    });
    return ids;
  }

  /** Drop the fixture viewer so the next creation is a genuine first one. */
  function unregisterViewer(app: TestApp): void {
    app.ctx.db
      .prepare(`DELETE FROM app_settings WHERE key = 'viewer_user_id'`)
      .run();
    app.ctx.db.prepare(`DELETE FROM users`).run();
  }

  // ── embedded first-boot creator: UserService.register ──────────────

  it('register publishes once, id-only, on the genuine first user', () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const changed = captureUserChanged(t);

    const user = t.ctx.userService.register({
      name: 'shiki',
      display_name: 'Shiki',
    });

    expect(changed).toEqual([user.id]);
  });

  it('register stays silent when a viewer already exists (rejected write)', () => {
    // Default fixture already has `local`, so the single-user gate throws
    // `already_registered` before any row is written.
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const changed = captureUserChanged(t);

    expect(() =>
      t!.ctx.userService.register({ name: 'second', display_name: 'Second' }),
    ).toThrow(/already registered/i);

    expect(changed).toEqual([]);
  });

  // ── standalone multi-user creator: UserAuthService.signup ──────────

  it('signup publishes once on a genuine new account', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    const changed = captureUserChanged(t);

    const res = await http(t).post(authPaths.signup, {
      email: 'shiki@example.test',
      password: 'correct horse battery staple',
      name: 'shiki',
      display_name: 'Shiki',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };

    expect(changed).toEqual([body.user.id]);
  });

  it('signup stays silent when the email already exists (no creation)', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    unregisterViewer(t);
    // Seed the account through the real path, THEN start observing.
    const first = await http(t).post(authPaths.signup, {
      email: 'dup@example.test',
      password: 'correct horse battery staple',
      name: 'dup-first',
      display_name: 'First',
    });
    expect(first.status).toBe(200);
    const changed = captureUserChanged(t);

    const repeat = await http(t).post(authPaths.signup, {
      email: 'dup@example.test',
      password: 'correct horse battery staple',
      name: 'dup-second',
      display_name: 'Second',
    });
    // Existing email resolves to auth_failed, never a second creation.
    expect(repeat.status).not.toBe(200);

    expect(changed).toEqual([]);
  });

  // ── agent provisioning: createAgent ────────────────────────────────

  it('agent creation publishes once, id-only, on the genuine create', async () => {
    t = buildTestApp();
    const changed = captureAgentChanged(t);

    const res = await http(t).post('/api/agents', {
      name: 'alice',
      runtime: 'claude',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { id: string } };

    expect(changed).toEqual([body.agent.id]);
  });

  it('agent creation stays silent on an idempotent echo', async () => {
    t = buildTestApp();
    const key = 'idem-1707-echo';
    // First create materializes the agent and announces it.
    const first = await http(t).post(
      '/api/agents',
      { name: 'alice', runtime: 'claude' },
      { headers: { 'Idempotency-Key': key } },
    );
    expect(first.status).toBe(201);
    // Observe only the replay: the same key must echo without re-announcing.
    const changed = captureAgentChanged(t);

    const echo = await http(t).post(
      '/api/agents',
      { name: 'alice', runtime: 'claude' },
      { headers: { 'Idempotency-Key': key } },
    );
    expect(echo.status).toBe(200);

    expect(changed).toEqual([]);
  });

  it('agent creation stays silent when materialization fails (the core negative contract)', async () => {
    // The announce is a post-commit effect built ONLY on the `created`
    // result, so a materialization that never commits must never announce.
    // Echo alone can't prove this — it only shows a replay doesn't re-emit;
    // this pins that no one can move the publish ahead of the L3a commit.
    // Deterministic real failure: a BEFORE INSERT trigger ABORTs the DM
    // dependent-row insert inside the L3a tx (same seam as
    // `agent-create-structural-invariants` Invariant 3), so createAgent
    // returns `materializeFailed` and 500 — not `created`.
    // The `placement_kind` clause is load-bearing: an `agent_inbox` also uses
    // a fixed roster, so without it this
    // trigger would abort the L1 aggregate reserve instead and the route would
    // answer 409 `agent_name_taken` — a different contract than the one here.
    t = buildTestApp();
    t.ctx.db.exec(
      `CREATE TRIGGER idem1707_fail_dm_insert
         BEFORE INSERT ON conversations
         WHEN NEW.roster_policy = 'fixed' AND NEW.placement_kind = 'workspace'
       BEGIN
         SELECT RAISE(ABORT, 'idem1707: forced dependent-row failure');
       END`,
    );
    const changed = captureAgentChanged(t);

    const res = await http(t).post('/api/agents', {
      name: 'doomed',
      runtime: 'claude',
    });
    expect(res.status).toBe(500);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'dependent_row_insert_failed',
    });

    expect(changed).toEqual([]);
  });
});
