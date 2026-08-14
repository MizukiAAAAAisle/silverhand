/**
 * Agent failed-row recovery surface tests.
 *
 * Origin: D4.d D5. Pins the D5 deliverables:
 *
 *   1. DELETE branches:
 *      - `failed`  → 204 row-only delete (no dependents to sweep)
 *      - `pending_materialization` → 409 `materialization_in_progress`
 *      - `active`  → existing destructive flow (regression pin only;
 *                    the heavy detail is owned by `agents.test.ts`).
 *
 *   2. `?include_failed=1` widener semantics (Q6.a):
 *      - GET list: default hides `failed`, widener exposes the
 *        caller's own failed rows.
 *      - GET single: default returns 404 for `failed`, widener
 *        returns 200 for the caller's own failed row.
 *      - Cross-user widener stays creator-scoped — the structural
 *        invariant is pinned in `agent-create-structural-invariants.test.ts`
 *        (Invariant 2); this file does NOT duplicate that.
 *
 *   3. `?retry=true` same-row retry matrix (§3.2 (a), Cindy D5
 *      guard rails):
 *      - failed + matching metadata + daemon attached → 201 with
 *        the same 4-field payload fresh-create returns, and the
 *        row reaches `materialization_status='active'`.
 *      - failed + mismatching metadata → 400
 *        `idempotency_metadata_mismatch` FIRST (retry verb does
 *        NOT silently re-arm metadata mutation).
 *      - failed + daemon offline → 503 `host_attach_pending` with
 *        the row STAYING in `failed` (no failed → pending bounce;
 *        guard rail #2).
 *      - failed + dispatch wire error (response error) → row flips
 *        back to `failed` with refreshed `materialization_failed_code`
 *        + `materialization_failed_at`, not preserved-old; guard
 *        rail #2.
 *      - failed + dispatch transport error → same, with the
 *        appropriate failed_code mapping
 *        (`HostWsCommandTransportError`).
 *      - active + retry=true → 200 echo (no-op for already-good
 *        rows; the existing-row arm short-circuits before the
 *        retry-specific logic).
 *      - pending + retry=true → 409 `materialization_in_progress`
 *        (same regardless of retryFlag; the sibling in-flight
 *        attempt owns the outcome).
 *      - no-row + retry=true → 404 `retry_target_not_found` (NOT
 *        silent fresh-create fallthrough).
 *      - retry does NOT re-run name-uniqueness against the row's
 *        own name (guard rail #3 — retry hits the exact same
 *        post-reserve helper; the no-row fresh path is the only
 *        place name uniqueness lives).
 */

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { X_SILVERHAND_LEGACY_USER_ID_HEADER } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { createSqliteAgentProvisioningPersistence } from '../../src/repos/agent-provisioning-persistence.js';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../../src/ws/host-ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

function freshKey(): string {
  return `k-${randomBytes(8).toString('base64url')}`;
}

interface CreateAgentOk {
  agent: {
    id: string;
    name: string;
    materialization_status: 'pending_materialization' | 'active' | 'failed';
  };
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
              materialization_failed_code,
              materialization_failed_at
         FROM agents WHERE id = ?`,
    )
    .get(agentId) as RowSnapshot | undefined;
  return row ?? null;
}

/** This agent's inbox placement id, read through the repository. Identity, not
 *  a count: the partial UNIQUE already makes >1 impossible, so the two ways this
 *  can go wrong are `null` (born too late — never, or only on the success path)
 *  and a DIFFERENT id after a retry (born again, which the collision would
 *  actually turn into a rolled-back retry). Comparing ids catches both, and the
 *  second is the one a count cannot see. */
function inboxIdOf(t: TestApp, agentId: string): string | null {
  return new ConversationRepo(t.ctx.db).getAgentInbox(agentId)?.id ?? null;
}

/**
 * Seed a `failed` agent row that matches the production L3b shape:
 * the AGGREGATE (agents row + its inbox placement, v71 §4.2) and nothing
 * else — no dependent agent_home / DM / membership rows. See the matching
 * helper in `agent-create-structural-invariants.test.ts` for the long-form
 * rationale.
 *
 * Goes through `reserveAgentAggregate`, not the bare `reserveForMaterialize`,
 * because the retry matrix below is exactly where the difference shows: a
 * fixture without the inbox could not observe a second insert colliding on
 * `idx_conversations_inbox_agent`.
 */
function seedFailedAgent(
  t: TestApp,
  createdByUserId: string,
  input: { name: string; model?: string | null; description?: string | null },
  idempotencyKey: string,
  failedCode = 'host_attach_pending',
): string {
  const hosts = new HostRepo(t.ctx.db);
  const owned = hosts.listOwnedActiveLocalForUser(createdByUserId);
  if (owned.length === 0) {
    throw new Error(
      `seedFailedAgent: user ${createdByUserId} has no owned local host`,
    );
  }
  const hostId = owned[0]!.id;
  const agents = new AgentRepo(t.ctx.db);
  const row = createSqliteAgentProvisioningPersistence(
    t.ctx.db,
  ).reserveAgentAggregate({
    input: {
      name: input.name,
      runtime: 'claude',
      model: input.model ?? undefined,
      description: input.description ?? undefined,
    },
    defaultHostId: hostId,
    createdByUserId,
    idempotencyKey,
  });
  agents.flipToFailed(row.id, failedCode, Date.now());
  return row.id;
}

/**
 * Seed a `pending_materialization` agent row (post-reserve, pre-L3a).
 * Used to exercise the 409 in_progress dispatch arms. Same aggregate factory:
 * `pending_materialization` is a legal state of a WHOLE Agent, inbox included.
 */
function seedPendingAgent(
  t: TestApp,
  createdByUserId: string,
  name: string,
  idempotencyKey: string,
): string {
  const hosts = new HostRepo(t.ctx.db);
  const hostId = hosts.listOwnedActiveLocalForUser(createdByUserId)[0]!.id;
  const row = createSqliteAgentProvisioningPersistence(
    t.ctx.db,
  ).reserveAgentAggregate({
    input: { name, runtime: 'claude' },
    defaultHostId: hostId,
    createdByUserId,
    idempotencyKey,
  });
  return row.id;
}

describe('D4.d D5: failed-row recovery surface', () => {
  const tests: TestApp[] = [];
  afterEach(() => {
    for (const t of tests) t.cleanup();
    tests.length = 0;
  });

  // ──────────────────────────────────────────────────────────────────
  //   DELETE branches
  // ──────────────────────────────────────────────────────────────────
  describe('DELETE /api/agents/:id materialization dispatch', () => {
    it('failed → 204 row-only delete', async () => {
      const t = buildTestApp();
      tests.push(t);
      const agentId = seedFailedAgent(
        t,
        t.viewerUserId,
        { name: `del-failed-${freshKey()}` },
        freshKey(),
      );
      // DELETE without a `{confirm:true}` body — the active-row
      // confirm-guard is bypassed for failed rows.
      const res = await http(t).del(`/api/agents/${agentId}`);
      expect(res.status, await res.clone().text()).toBe(204);
      // Row is gone from the DB.
      expect(readRow(t, agentId)).toBeNull();
      // And invisible via include_failed widener too.
      const get = await http(t).get(`/api/agents/${agentId}?include_failed=1`);
      expect(get.status).toBe(404);
    });

    it('pending_materialization → 409 materialization_in_progress', async () => {
      const t = buildTestApp();
      tests.push(t);
      const agentId = seedPendingAgent(
        t,
        t.viewerUserId,
        `del-pending-${freshKey()}`,
        freshKey(),
      );
      const res = await http(t).del(`/api/agents/${agentId}`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('materialization_in_progress');
      // Row untouched.
      const row = readRow(t, agentId);
      expect(row?.materialization_status).toBe('pending_materialization');
    });

    it('active → unchanged destructive flow (regression pin)', async () => {
      // Heavy detail (DM sweep, L1/L2 rm, runtime stop) is owned by
      // `agents.test.ts`. This is just a regression pin that D5's
      // status-dispatch DOES NOT swallow the active branch.
      const t = buildTestApp();
      tests.push(t);
      const created = (await http(t)
        .post('/api/agents', { name: `del-active-${freshKey()}`, runtime: 'claude' })
        .then(r => r.json())) as CreateAgentOk;
      expect(created.agent.materialization_status).toBe('active');
      const res = await http(t).del(`/api/agents/${created.agent.id}`, {
        body: JSON.stringify({ confirm: true }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status, await res.clone().text()).toBe(204);
      expect(readRow(t, created.agent.id)).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //   ?include_failed=1 widener
  // ──────────────────────────────────────────────────────────────────
  describe('?include_failed=1 widener semantics', () => {
    it('list: default hides failed, widener exposes caller own failed', async () => {
      const t = buildTestApp();
      tests.push(t);
      const name = `inc-list-${freshKey()}`;
      const agentId = seedFailedAgent(t, t.viewerUserId, { name }, freshKey());

      const defaultList = (await http(t)
        .get('/api/agents')
        .then(r => r.json())) as { agents: Array<{ id: string }> };
      expect(defaultList.agents.map(a => a.id)).not.toContain(agentId);

      const widenedList = (await http(t)
        .get('/api/agents?include_failed=1')
        .then(r => r.json())) as { agents: Array<{ id: string }> };
      expect(widenedList.agents.map(a => a.id)).toContain(agentId);
    });

    it('single: default returns 404 for failed, widener returns 200 for caller own failed', async () => {
      const t = buildTestApp();
      tests.push(t);
      const agentId = seedFailedAgent(
        t,
        t.viewerUserId,
        { name: `inc-get-${freshKey()}` },
        freshKey(),
      );
      const def = await http(t).get(`/api/agents/${agentId}`);
      expect(def.status).toBe(404);
      const wide = await http(t).get(`/api/agents/${agentId}?include_failed=1`);
      expect(wide.status).toBe(200);
      const body = (await wide.json()) as {
        agent: { id: string; materialization_status: string };
      };
      expect(body.agent.id).toBe(agentId);
      expect(body.agent.materialization_status).toBe('failed');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //   ?retry=true matrix
  // ──────────────────────────────────────────────────────────────────
  describe('?retry=true same-row retry matrix', () => {
    it('failed + matching metadata + daemon attached → 201 + row reaches active', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-ok-${freshKey()}`;
      const agentId = seedFailedAgent(t, t.viewerUserId, { name }, key);

      const res = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as CreateAgentOk;
      expect(body.agent.id).toBe(agentId);
      expect(body.agent.materialization_status).toBe('active');
      expect(typeof body.dm_channel_id).toBe('string');
      expect(typeof body.agent_home_workspace_id).toBe('string');
      expect(typeof body.onboarding_message_id).toBe('string');

      // Same-row contract: the agents row was flipped in place (not
      // re-inserted with a fresh id).
      const row = readRow(t, agentId);
      expect(row?.materialization_status).toBe('active');
      expect(row?.materialization_failed_code).toBeNull();
      expect(row?.materialization_failed_at).toBeNull();
    });

    it('retry of a failed row keeps EXACTLY ONE inbox and never reports dependent_row_insert_failed (v71 §4.2)', async () => {
      // The aggregate-ownership falsifier (#task:2014, @Cindy round-1 B1). The
      // v71 backfill gives every row of `agents` an inbox with no
      // `materialization_status` filter, so the create path has to agree about
      // WHEN the inbox is born. If it were born in the L3a dependent tx instead
      // of at reserve, this retry would insert a second one for the same owner,
      // hit `idx_conversations_inbox_agent`, and roll the whole retry back —
      // `dependent_row_insert_failed` forever, taking the home workspace, the DM
      // and the status flip with it. Asserted from BOTH sides: the id before
      // (the failed row already owns its inbox) and the SAME id after (the retry
      // added nothing), plus the failure code that a collision would produce.
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-inbox-${freshKey()}`;
      const agentId = seedFailedAgent(t, t.viewerUserId, { name }, key);

      const bornAtReserve = inboxIdOf(t, agentId);
      expect(bornAtReserve).not.toBeNull();

      const res = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(res.status, await res.clone().text()).toBe(201);
      const row = readRow(t, agentId);
      expect(row?.materialization_status).toBe('active');
      expect(row?.materialization_failed_code).toBeNull();
      expect(inboxIdOf(t, agentId)).toBe(bornAtReserve);
    });

    it('retry of a BOOT-RECONCILED pending → failed row behaves identically (one inbox, reaches active)', async () => {
      // The other way into `failed`: the row was reserved, the process died
      // before L3a/L3b, and the boot reconciler stamped it. It reaches `failed`
      // through a different transition than the L3b compensation above, so it is
      // a genuinely separate path into this retry — and its inbox came from the
      // same reserve, which is what makes the two isomorphic.
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-reconciled-${freshKey()}`;
      const agentId = seedPendingAgent(t, t.viewerUserId, name, key);
      const bornAtReserve = inboxIdOf(t, agentId);
      expect(bornAtReserve).not.toBeNull();
      new AgentRepo(t.ctx.db).flipToFailed(
        agentId,
        'materialize_timeout',
        Date.now(),
      );

      const res = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(res.status, await res.clone().text()).toBe(201);
      expect(readRow(t, agentId)?.materialization_status).toBe('active');
      expect(inboxIdOf(t, agentId)).toBe(bornAtReserve);
    });

    it('failed + mismatching metadata → 400 idempotency_metadata_mismatch FIRST (retry verb does NOT mutate)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-mm-${freshKey()}`;
      const agentId = seedFailedAgent(t, t.viewerUserId, { name }, key);

      const res = await http(t).post(
        '/api/agents?retry=true',
        // body.name differs from the stored row's name; mismatch
        // must fire FIRST, ahead of any retry-specific dispatch.
        { name: `${name}-differs`, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code?: string;
        mismatched_field?: string;
      };
      expect(body.code).toBe('idempotency_metadata_mismatch');
      expect(body.mismatched_field).toBe('name');
      // Row still failed — retry did NOT flip to pending.
      const row = readRow(t, agentId);
      expect(row?.materialization_status).toBe('failed');
    });

    it('failed + daemon offline → 503 host_attach_pending, row STAYS failed (no failed → pending bounce)', async () => {
      // Daemon offline path: pass `hostWsController: () => null` so
      // the route hits the "no controller" branch BEFORE flipping.
      const t = buildTestApp({ hostWsController: () => null });
      tests.push(t);
      const key = freshKey();
      const name = `retry-offline-${freshKey()}`;
      const agentId = seedFailedAgent(t, t.viewerUserId, { name }, key);
      const beforeFailedAt = readRow(t, agentId)?.materialization_failed_at;

      const res = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('host_attach_pending');

      // Row STAYS in failed with the ORIGINAL failed_at — the route
      // did not flip failed → pending → failed under us (Cindy D5
      // guard rail #2: online check BEFORE flipFailedToReserveAgain).
      const row = readRow(t, agentId);
      expect(row?.materialization_status).toBe('failed');
      expect(row?.materialization_failed_at).toBe(beforeFailedAt);
    });

    it('failed + dispatch wire error → row flips back to failed with REFRESHED code/at', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-wire-err-${freshKey()}`;
      const agentId = seedFailedAgent(
        t,
        t.viewerUserId,
        { name },
        key,
        'host_attach_pending', // original failed_code is host_attach_pending
      );
      const originalRow = readRow(t, agentId)!;

      // Inject a wire response error from the daemon on
      // sendCommand. The router catches it in
      // d5RunMaterializeFromReserved and flips to failed.
      t.fakeHostWs!.sendCommandError = new HostWsCommandResponseError(
        // Cast: the constructor narrowly types `code` to the
        // generic 5-enum, but at runtime materialize wire errors
        // carry the wider typed codes (see `d3MapMaterializeWireError`
        // in routes.ts for the parallel cast on the consumer side).
        'agent_dir_collision' as never,
        'daemon reports the agent dir collides with an existing path',
        {
          hostId: 'local',
          commandKind: 'agent_materialize',
          requestId: 'req-fake-1',
        },
      );

      const res = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('agent_dir_collision');

      // Row back to failed with REFRESHED failed_code (not the
      // original `host_attach_pending`) and a new failed_at (>= the
      // original — exact equality possible if Date.now() resolution
      // ties the seed and the L3b stamp).
      const row = readRow(t, agentId);
      expect(row?.materialization_status).toBe('failed');
      expect(row?.materialization_failed_code).toBe('agent_dir_collision');
      expect(row?.materialization_failed_code).not.toBe(
        originalRow.materialization_failed_code,
      );
      expect(row?.materialization_failed_at).toBeGreaterThanOrEqual(
        originalRow.materialization_failed_at ?? 0,
      );
    });

    it('failed + dispatch transport timeout → row back to failed with materialize_timeout', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-timeout-${freshKey()}`;
      const agentId = seedFailedAgent(t, t.viewerUserId, { name }, key);

      t.fakeHostWs!.sendCommandError = new HostWsCommandTransportError(
        'transport_timeout',
        'daemon did not respond within 60s',
        { hostId: 'local', commandKind: 'agent_materialize' },
      );

      const res = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(res.status).toBe(504);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('materialize_timeout');

      const row = readRow(t, agentId);
      expect(row?.materialization_status).toBe('failed');
      expect(row?.materialization_failed_code).toBe('materialize_timeout');
    });

    it('active + retry=true → 200 echo (no-op for already-good rows)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-active-${freshKey()}`;
      const first = (await http(t)
        .post(
          '/api/agents',
          { name, runtime: 'claude' },
          { headers: { 'Idempotency-Key': key } },
        )
        .then(r => r.json())) as CreateAgentOk;
      expect(first.agent.materialization_status).toBe('active');

      const echo = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(echo.status, await echo.clone().text()).toBe(200);
      const body = (await echo.json()) as CreateAgentOk;
      expect(body.agent.id).toBe(first.agent.id);
      expect(body.dm_channel_id).toBe(first.dm_channel_id);
    });

    it('pending + retry=true → 409 materialization_in_progress (same regardless of retry flag)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-pending-${freshKey()}`;
      seedPendingAgent(t, t.viewerUserId, name, key);

      const res = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('materialization_in_progress');
    });

    it('no-row + retry=true → 404 retry_target_not_found (not silent fresh-create)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const res = await http(t).post(
        '/api/agents?retry=true',
        { name: `retry-norow-${freshKey()}`, runtime: 'claude' },
        { headers: { 'Idempotency-Key': freshKey() } },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('retry_target_not_found');
    });

    it('retry does NOT re-check name uniqueness against the row\'s own name', async () => {
      // The failed row already owns its `name` (reserved at L1). The
      // fresh-create path's `agents.getByName(...)` check would 409
      // on this name, but retry MUST not run that check — it
      // bypasses L0.7 entirely and goes straight to L1 reserve →
      // L2/L3a/L3b via the shared helper.
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `retry-name-${freshKey()}`;
      seedFailedAgent(t, t.viewerUserId, { name }, key);

      const res = await http(t).post(
        '/api/agents?retry=true',
        { name, runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      // If the name uniqueness check had run, we'd get 409
      // agent_name_taken; instead retry succeeds.
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as CreateAgentOk;
      expect(body.agent.name).toBe(name);
      expect(body.agent.materialization_status).toBe('active');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //   canViewAgent status filter (D5 fixup, Cindy `vB9vzUo4y_vgSZf8`
  //   P1): pending and failed are invisible to default reads + to
  //   PATCH / avatar / workspace / runtime / schedules / stop. The
  //   filter is what locks the §3.2 immutable-metadata invariant —
  //   without it a creator could PATCH a failed row's snapshot and
  //   break `?retry=true`.
  // ──────────────────────────────────────────────────────────────────
  describe('default read paths hide non-active rows', () => {
    it('GET /api/agents (no flag) does NOT include pending rows', async () => {
      const t = buildTestApp();
      tests.push(t);
      const pendingName = `default-pending-${freshKey()}`;
      const pendingId = seedPendingAgent(
        t,
        t.viewerUserId,
        pendingName,
        freshKey(),
      );
      const list = (await http(t)
        .get('/api/agents')
        .then(r => r.json())) as { agents: Array<{ id: string }> };
      expect(list.agents.map(a => a.id)).not.toContain(pendingId);
      // `?include_failed=1` alone does NOT widen to pending —
      // the two flags are independent dimensions on the
      // includeStatuses tuple (D6 pin: pending widener is
      // `?include_pending=1`, not a side-effect of failed widener).
      const wideFailed = (await http(t)
        .get('/api/agents?include_failed=1')
        .then(r => r.json())) as { agents: Array<{ id: string }> };
      expect(wideFailed.agents.map(a => a.id)).not.toContain(pendingId);
    });

    it('GET /api/agents/:id (no flag) returns 404 for pending rows', async () => {
      const t = buildTestApp();
      tests.push(t);
      const pendingId = seedPendingAgent(
        t,
        t.viewerUserId,
        `default-pending-get-${freshKey()}`,
        freshKey(),
      );
      const res = await http(t).get(`/api/agents/${pendingId}`);
      expect(res.status).toBe(404);
      // `?include_failed=1` alone still 404s — flags are
      // independent.
      const wideFailed = await http(t).get(
        `/api/agents/${pendingId}?include_failed=1`,
      );
      expect(wideFailed.status).toBe(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //   D4.d D6 — `?include_pending=1` widener parity
  //   (Cindy `hguBjY1O1GMy2JSS` standards: same shape as the D5
  //   `?include_failed=1` widener — ACL-first, creator-scoped, not
  //   a cross-user enumeration surface; composes with
  //   `?include_failed=1` for the §7.3 management view).
  // ──────────────────────────────────────────────────────────────────
  describe('?include_pending=1 widener (D6)', () => {
    it('list: ?include_pending=1 widens to caller\'s own pending rows', async () => {
      const t = buildTestApp();
      tests.push(t);
      const pendingId = seedPendingAgent(
        t,
        t.viewerUserId,
        `inc-pend-${freshKey()}`,
        freshKey(),
      );
      const wide = (await http(t)
        .get('/api/agents?include_pending=1')
        .then(r => r.json())) as { agents: Array<{ id: string }> };
      expect(wide.agents.map(a => a.id)).toContain(pendingId);
    });

    it('list: ?include_failed=1&include_pending=1 widens to BOTH (management view)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const failedId = seedFailedAgent(
        t,
        t.viewerUserId,
        { name: `mgmt-failed-${freshKey()}` },
        freshKey(),
      );
      const pendingId = seedPendingAgent(
        t,
        t.viewerUserId,
        `mgmt-pending-${freshKey()}`,
        freshKey(),
      );
      const wide = (await http(t)
        .get('/api/agents?include_failed=1&include_pending=1')
        .then(r => r.json())) as { agents: Array<{ id: string }> };
      const ids = wide.agents.map(a => a.id);
      expect(ids).toContain(failedId);
      expect(ids).toContain(pendingId);
    });

    it('list: ?include_pending=1 from user B does NOT widen to user A\'s pending rows', async () => {
      // ACL-first invariant — mirrors `?include_failed=1` (Invariant 2
      // in `agent-create-structural-invariants.test.ts`). Pending rows have
      // no dependent workspaces (L3a never ran), so
      // `canViewAgent`'s workspace-membership branch can never match
      // cross-user, exactly like failed rows.
      const t = buildTestApp();
      tests.push(t);
      const userA = 'alice';
      const userB = 'bob';
      const userAPendingId = seedPendingAgent(
        t,
        userA,
        `inc-pend-cross-${freshKey()}`,
        freshKey(),
      );
      const wide = (await http(t).get('/api/agents?include_pending=1', {
        headers: { [X_SILVERHAND_LEGACY_USER_ID_HEADER]: userB },
      })) as Response;
      expect(wide.status).toBe(200);
      const body = (await wide.json()) as {
        agents: Array<{ id: string }>;
      };
      expect(body.agents.map(a => a.id)).not.toContain(userAPendingId);
    });

    it('single: ?include_pending=1 returns 200 for caller\'s own pending row', async () => {
      const t = buildTestApp();
      tests.push(t);
      const pendingId = seedPendingAgent(
        t,
        t.viewerUserId,
        `inc-pend-get-${freshKey()}`,
        freshKey(),
      );
      const res = await http(t).get(
        `/api/agents/${pendingId}?include_pending=1`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agent: { id: string; materialization_status: string };
      };
      expect(body.agent.id).toBe(pendingId);
      expect(body.agent.materialization_status).toBe(
        'pending_materialization',
      );
    });

    it('single: ?include_pending=1 cross-user → 404 (ACL-first creator-scoped)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const userA = 'alice';
      const userB = 'bob';
      const userAPendingId = seedPendingAgent(
        t,
        userA,
        `inc-pend-cross-get-${freshKey()}`,
        freshKey(),
      );
      const cross = await http(t).get(
        `/api/agents/${userAPendingId}?include_pending=1`,
        { headers: { [X_SILVERHAND_LEGACY_USER_ID_HEADER]: userB } },
      );
      expect(cross.status).toBe(404);
    });

    it('PATCH/avatar/etc still 404 for pending even with ?include_pending=1 (widener is read-only)', async () => {
      // The widener applies to the GET list / single routes only.
      // PATCH and other agent-id sub-routes do NOT honor the
      // query flag — they use `canViewAgent` default
      // (`['active']`) and stay 404 for pending. Otherwise the
      // PATCH metadata-mutation hole would re-open: a caller
      // could PATCH a pending row's snapshot before its L3a
      // finishes, breaking the §3.2 immutable-metadata invariant
      // mid-flight.
      const t = buildTestApp();
      tests.push(t);
      const pendingId = seedPendingAgent(
        t,
        t.viewerUserId,
        `inc-pend-patch-${freshKey()}`,
        freshKey(),
      );
      const res = await http(t).patch(
        // Even with the query flag, PATCH does not parse it.
        `/api/agents/${pendingId}?include_pending=1`,
        { description: 'should-not-apply' },
      );
      expect(res.status).toBe(404);
      const after = t.ctx.db
        .prepare(`SELECT description FROM agents WHERE id = ?`)
        .get(pendingId) as { description: string | null };
      expect(after.description).toBeNull();
    });
  });

  describe('PATCH /api/agents/:id: non-active rows are immutable (locks §3.2 snapshot invariant)', () => {
    // The most security-critical consequence of the
    // `canViewAgent` status filter: a creator can NOT mutate a
    // failed row's stored metadata snapshot. That snapshot is the
    // comparator for `?retry=true`; if PATCH could change it, a
    // retry would no longer be "same metadata" by any meaningful
    // definition and the §3.2 immutable-metadata invariant would
    // be a lie.

    it('PATCH on a failed row returns 404 and does NOT mutate description/runtime/model', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const name = `patch-failed-${freshKey()}`;
      const agentId = seedFailedAgent(
        t,
        t.viewerUserId,
        { name, description: 'original-description' },
        key,
      );
      const before = readRow(t, agentId)!;

      const res = await http(t).patch(`/api/agents/${agentId}`, {
        description: 'malicious-mutation',
        model: 'malicious-model',
      });
      expect(res.status).toBe(404);

      // Row metadata untouched. Re-read via raw SQL because the
      // public GET would also 404 on a failed row by default; we
      // want to confirm the underlying snapshot is intact, not
      // just hidden.
      const after = t.ctx.db
        .prepare(
          `SELECT description, model, runtime
             FROM agents WHERE id = ?`,
        )
        .get(agentId) as {
        description: string | null;
        model: string | null;
        runtime: string;
      };
      expect(after.description).toBe('original-description');
      expect(after.model).toBeNull();
      expect(after.runtime).toBe('claude');
      // Status unchanged too.
      expect(readRow(t, agentId)?.materialization_status).toBe(
        before.materialization_status,
      );

      // Subsequent `?retry=true` with the ORIGINAL body still
      // passes — the snapshot the retry compares against is the
      // one we asserted above, not the failed PATCH attempt.
      const retry = await http(t).post(
        '/api/agents?retry=true',
        {
          name,
          runtime: 'claude',
          description: 'original-description',
        },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(retry.status, await retry.clone().text()).toBe(201);
      const body = (await retry.json()) as CreateAgentOk;
      expect(body.agent.id).toBe(agentId);
      expect(body.agent.materialization_status).toBe('active');
    });

    it('PATCH on a pending row returns 404 (status filter applies to all non-active states)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const agentId = seedPendingAgent(
        t,
        t.viewerUserId,
        `patch-pending-${freshKey()}`,
        freshKey(),
      );
      const res = await http(t).patch(`/api/agents/${agentId}`, {
        description: 'should-not-apply',
      });
      expect(res.status).toBe(404);
      const after = t.ctx.db
        .prepare(`SELECT description FROM agents WHERE id = ?`)
        .get(agentId) as { description: string | null };
      expect(after.description).toBeNull();
    });
  });
});
