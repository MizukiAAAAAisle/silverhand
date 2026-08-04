/**
 * Create-agent provisioning saga — characterization tests (P5 pre-refactor net).
 *
 * Origin: #task:971. Before P5 extracts the `POST /api/agents` saga
 * (`d3InsertDependentRowsAtomic` + `d5RunMaterializeFromReserved` + the route
 * body) into an application-layer use case, every branch the extraction could
 * silently drop must be pinned. The coverage audit
 * found the load-bearing spine already
 * covered (happy path, idempotency dispatch, the whole `?retry=true` matrix, L3a
 * atomicity / no-partial-rows / L3b compensation, deliver best-effort) but 7
 * failure/edge arms unpinned. This file pins those 7 so the refactor is
 * behavior-preserving by construction.
 *
 * Each test maps to a row in the audit's gap list:
 *   #28  §6.5 daemon ack cross-check (agent_dir != home path) → 502
 *   #12  failed + NO retry → 409 materialization_previously_failed (+ failed_*)
 *   #21  retry race (row left failed-state under us) → 409 retry_target_not_failed
 *   #26  reserve INSERT conflict → 409 agent_name_taken (no row leaked)
 *   #10b active-echo with DM channel externally deleted → 500 internal_error
 *   #30  L4 start() throws (separate from deliver) → still 201, row active
 *   #6   malformed Idempotency-Key (not just missing) → 400, no DB write
 *
 * Mechanisms mirror the existing create-saga suites
 * (`agent-create-structural-invariants.test.ts`, `agent-failed-recovery.test.ts`):
 * `buildTestApp` + the default fake daemon, error injection via
 * `t.fakeHostWs.{sendCommandError,agentMaterializeAckOverride}` and
 * `t.fake.{deliverError,startError}`, and deterministic DB triggers
 * (`RAISE(ABORT)` / `RAISE(IGNORE)`) for the two no-window race/conflict arms.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

function freshKey(): string {
  return `k-${randomBytes(8).toString('base64url')}`;
}

interface CreateAgentOk {
  agent: { id: string; name: string; materialization_status?: string };
  agent_home_workspace_id: string;
  dm_channel_id: string;
  onboarding_message_id: string;
}

interface RowSnapshot {
  id: string;
  name: string;
  materialization_status: string;
  materialization_failed_code: string | null;
  materialization_failed_at: number | null;
}

function readRow(t: TestApp, agentId: string): RowSnapshot | null {
  const row = t.ctx.db
    .prepare(
      `SELECT id, name, materialization_status,
              materialization_failed_code, materialization_failed_at
         FROM agents WHERE id = ?`,
    )
    .get(agentId) as RowSnapshot | undefined;
  return row ?? null;
}

/**
 * Seed a structurally-bare `failed` row (only the agents row, no dependents) —
 * the exact shape a real L3b leaves behind. Mirrors the helper in
 * `agent-failed-recovery.test.ts`.
 */
function seedFailedAgent(
  t: TestApp,
  createdByUserId: string,
  name: string,
  idempotencyKey: string,
  failedCode = 'host_attach_pending',
): string {
  const hosts = new HostRepo(t.ctx.db);
  const owned = hosts.listOwnedActiveLocalForUser(createdByUserId);
  if (owned.length === 0) {
    throw new Error(`seedFailedAgent: user ${createdByUserId} has no owned local host`);
  }
  const agents = new AgentRepo(t.ctx.db);
  const row = agents.reserveForMaterialize(
    { name, runtime: 'claude' },
    owned[0]!.id,
    createdByUserId,
    idempotencyKey,
  );
  agents.flipToFailed(row.id, failedCode, Date.now());
  return row.id;
}

function agentCount(t: TestApp): number {
  return t.ctx.db
    .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM agents')
    .get()!.c;
}

describe('create-agent saga — P5 pre-refactor characterization (#task:971)', () => {
  const tests: TestApp[] = [];
  afterEach(() => {
    while (tests.length > 0) tests.pop()!.cleanup();
  });

  // #28 — §6.5 daemon ack cross-check. The daemon ack MUST carry
  // agent_dir === agent_home_workspace_path; a skew is a daemon-internal
  // fault. The route flips the reserved row to failed (daemon_internal_error,
  // separate L3b tx) and returns 502 — it must NOT proceed to insert
  // dependent rows on a mismatched path.
  it('#28 daemon ack agent_dir != agent_home_workspace_path → 502 daemon_internal_error, row failed, no dependents', async () => {
    const t = buildTestApp();
    tests.push(t);
    t.fakeHostWs!.agentMaterializeAckOverride = () => ({
      ok: true as const,
      agent_dir: '/skew/agent-dir',
      agent_home_workspace_path: '/skew/different-home-path',
      materialized_at: Date.now(),
    });

    const before = agentCount(t);
    const res = await http(t).post('/api/agents', {
      name: `ack-skew-${freshKey()}`,
      runtime: 'claude',
    });
    expect(res.status, await res.clone().text()).toBe(502);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('daemon_internal_error');

    // The reserved row was flipped to failed by the explicit L3b path
    // (not left pending), and no dependent graph was built on the bad path.
    const reserved = t.ctx.db
      .prepare<[], RowSnapshot>(
        `SELECT id, name, materialization_status,
                materialization_failed_code, materialization_failed_at
           FROM agents ORDER BY created_at DESC LIMIT 1`,
      )
      .get()!;
    expect(reserved.materialization_status).toBe('failed');
    expect(reserved.materialization_failed_code).toBe('daemon_internal_error');
    expect(reserved.materialization_failed_at).not.toBeNull();
    const homeWs = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspaces
          WHERE workspace_kind = 'agent_home' AND owner_agent_id = ?`,
      )
      .get(reserved.id)!.c;
    expect(homeWs).toBe(0);
    // Exactly one (failed) agent row — no orphan duplicate.
    expect(agentCount(t)).toBe(before + 1);
  });

  // #12 — a stored `failed` row hit WITHOUT ?retry=true is the §3.2 default
  // arm: 409 `materialization_previously_failed`, surfacing the stored
  // failed_code + failed_at so the client can decide to retry. (The retry
  // matrix covers the ?retry=true arms; this is the plain-resend arm, only
  // ever asserted negatively elsewhere.)
  it('#12 failed row + NO retry flag → 409 materialization_previously_failed (carries failed_code + failed_at)', async () => {
    const t = buildTestApp();
    tests.push(t);
    const key = freshKey();
    const name = `failed-no-retry-${freshKey()}`;
    const agentId = seedFailedAgent(t, t.viewerUserId, name, key, 'materialize_timeout');
    const seeded = readRow(t, agentId)!;

    const res = await http(t).post(
      '/api/agents',
      { name, runtime: 'claude' },
      { headers: { 'Idempotency-Key': key } },
    );
    expect(res.status, await res.clone().text()).toBe(409);
    const body = (await res.json()) as {
      code?: string;
      failed_code?: string;
      failed_at?: number;
    };
    expect(body.code).toBe('materialization_previously_failed');
    expect(body.failed_code).toBe('materialize_timeout');
    expect(body.failed_at).toBe(seeded.materialization_failed_at);
    // Row untouched by the plain resend (no failed → pending bounce).
    expect(readRow(t, agentId)?.materialization_status).toBe('failed');
  });

  // #21 — retry race: the row read as `failed` at L0.3 is no longer failed
  // by the time the route attempts `flipFailedToReserveAgain` (a sibling
  // mutation flipped it out from under us). The flip's `WHERE status='failed'`
  // guard returns 0 changes → 409 `retry_target_not_failed`, never a silent
  // re-flip. There is no async window in-process, so a BEFORE-UPDATE
  // RAISE(IGNORE) trigger deterministically simulates the lost race by making
  // the failed→pending update a no-op while the row stays failed.
  it('#21 retry race (flipFailedToReserveAgain no-ops) → 409 retry_target_not_failed', async () => {
    const t = buildTestApp();
    tests.push(t);
    const key = freshKey();
    const name = `retry-race-${freshKey()}`;
    const agentId = seedFailedAgent(t, t.viewerUserId, name, key);

    // Simulate the sibling mutation: the failed→pending reserve-again update
    // is skipped (row left failed), so the route sees 0 changes.
    t.ctx.db.exec(
      `CREATE TRIGGER p5_char_block_reserve_again
         BEFORE UPDATE ON agents
         WHEN OLD.materialization_status = 'failed'
          AND NEW.materialization_status = 'pending_materialization'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    );

    const res = await http(t).post(
      '/api/agents?retry=true',
      { name, runtime: 'claude' },
      { headers: { 'Idempotency-Key': key } },
    );
    t.ctx.db.exec('DROP TRIGGER p5_char_block_reserve_again');

    expect(res.status, await res.clone().text()).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('retry_target_not_failed');
    // The row was never re-flipped — still failed.
    expect(readRow(t, agentId)?.materialization_status).toBe('failed');
  });

  // #26 — the L1 reserve INSERT throwing (e.g. a race-induced unique conflict
  // the pre-reserve getByName check didn't catch) maps to 409
  // `agent_name_taken`, and no row is leaked. A BEFORE-INSERT RAISE(ABORT)
  // trigger forces reserveForMaterialize to throw deterministically.
  it('#26 reserveForMaterialize INSERT throws → 409 agent_name_taken, no row leaked', async () => {
    const t = buildTestApp();
    tests.push(t);
    const name = `reserve-conflict-${randomBytes(4).toString('base64url')}`;
    t.ctx.db.exec(
      `CREATE TRIGGER p5_char_block_reserve_insert
         BEFORE INSERT ON agents
         WHEN NEW.name = '${name}'
       BEGIN
         SELECT RAISE(ABORT, 'p5-char: forced reserve INSERT conflict');
       END`,
    );

    const before = agentCount(t);
    const res = await http(t).post('/api/agents', { name, runtime: 'claude' });
    t.ctx.db.exec('DROP TRIGGER p5_char_block_reserve_insert');

    expect(res.status, await res.clone().text()).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('agent_name_taken');
    // The aborted INSERT left no row behind.
    expect(agentCount(t)).toBe(before);
  });

  // #10b — active-echo path with the DM channel externally deleted. The echo
  // re-derives the 4-field payload from the dependent graph; a missing DM is a
  // corrupt graph, not a permitted state → 500 internal_error, never a null
  // field. (Sibling of the pinned onboarding-deleted → 500 case.)
  it('#10b active row echo whose DM channel was deleted → 500 internal_error (no null fallback)', async () => {
    const t = buildTestApp();
    tests.push(t);
    const key = freshKey();
    const name = `echo-dm-gone-${freshKey()}`;
    const created = (await http(t)
      .post('/api/agents', { name, runtime: 'claude' }, { headers: { 'Idempotency-Key': key } })
      .then(r => r.json())) as CreateAgentOk;

    // External mutation: remove the DM channel so findDmChannelForAgent → null.
    t.ctx.db
      .prepare(`DELETE FROM conversation_agents WHERE conversation_id = ?`)
      .run(created.dm_channel_id);
    t.ctx.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(created.dm_channel_id);

    const retry = await http(t).post(
      '/api/agents',
      { name, runtime: 'claude' },
      { headers: { 'Idempotency-Key': key } },
    );
    expect(retry.status, await retry.clone().text()).toBe(500);
    const body = (await retry.json()) as { code?: string };
    expect(body.code).toBe('internal_error');
  });

  // #30 — L4 best-effort: the auto-start spawn throwing (distinct from the
  // already-pinned deliver-throws case) must NOT roll back the create. L3a
  // commit is the success boundary; start failure only logs. Response stays
  // 201, row active.
  it('#30 L4 start() throws after L3a commit → still 201, row active', async () => {
    const t = buildTestApp();
    tests.push(t);
    t.fake.startError = new Error('simulated post-commit auto-start failure');

    const res = await http(t).post('/api/agents', {
      name: `l4-start-fail-${freshKey()}`,
      runtime: 'claude',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as CreateAgentOk;
    const row = readRow(t, body.agent.id)!;
    expect(row.materialization_status).toBe('active');
    expect(row.materialization_failed_code).toBeNull();
    expect(row.materialization_failed_at).toBeNull();
    // Deliver ran before start (separate best-effort arms); start threw but
    // create still succeeded.
    expect(t.fake.delivered.length).toBe(1);
  });

  // #6 — Idempotency-Key shape validation: malformed (illegal chars / >64)
  // is rejected like a missing key (400, no DB write). The http() helper
  // auto-injects a valid key, so this bypasses it with a raw fetch.
  it('#6 malformed Idempotency-Key (illegal chars) → 400, no agent row written', async () => {
    const t = buildTestApp();
    tests.push(t);
    const before = agentCount(t);
    const res = await t.app.fetch(
      new Request('http://localhost/api/agents', {
        method: 'POST',
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          'content-type': 'application/json',
          authorization: `Bearer ${t.authToken}`,
          'Idempotency-Key': 'has illegal spaces & symbols!',
        },
        body: JSON.stringify({ name: 'bad-key', runtime: 'claude' }),
      }),
    );
    expect(res.status, await res.clone().text()).toBe(400);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code ?? body.error).toBeTruthy();
    expect(JSON.stringify(body)).toContain('dempotency-Key');
    expect(agentCount(t)).toBe(before);
  });

  // #6b — over-length Idempotency-Key (>64 chars) → 400 (same arm, length bound).
  it('#6b over-length Idempotency-Key (>64 chars) → 400, no agent row written', async () => {
    const t = buildTestApp();
    tests.push(t);
    const before = agentCount(t);
    const tooLong = 'a'.repeat(65);
    const res = await t.app.fetch(
      new Request('http://localhost/api/agents', {
        method: 'POST',
        headers: {
          ...CURRENT_DESKTOP_EPOCH_HEADERS,
          'content-type': 'application/json',
          authorization: `Bearer ${t.authToken}`,
          'Idempotency-Key': tooLong,
        },
        body: JSON.stringify({ name: 'long-key', runtime: 'claude' }),
      }),
    );
    expect(res.status, await res.clone().text()).toBe(400);
    expect(agentCount(t)).toBe(before);
  });
});
