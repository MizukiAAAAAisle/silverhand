/**
 * Agent-create / failed-row read-path structural invariants.
 *
 * Origin: D4.d structural-invariant tests — three invariants Cindy
 * declared at design-pass close (and Alice agreed to pin explicitly
 * across D1–D5). D1 landed them as `.skip` stubs; D3 un-skips
 * invariants 1 + 3; D5 un-skips invariant 2.
 *
 * These pin the failure modes that are easy to re-introduce when
 * D3 / D5 re-shape the route. They are NOT happy-path coverage —
 * there are separate tests for that. Each invariant captures one
 * specific regression mode the design pass spent the most rounds
 * locking down.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { X_SILVERHAND_LEGACY_USER_ID_HEADER } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { createSqliteAgentProvisioningPersistence } from '../../src/repos/agent-provisioning-persistence.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

/**
 * Seed a `materialization_status = 'failed'` row that matches the
 * shape a real L3b leaves behind: the AGGREGATE ONLY — the `agents`
 * row plus its inbox placement (v71 §4.2) — and NO dependent rows
 * (no `agent_home` workspace, no DM channel, no `workspace_users`
 * membership entry). The L3a transaction that inserts those
 * dependents rolls back atomically on failure, while the aggregate
 * was committed earlier by `reserveAgentAggregate`, so that pair is
 * what a "failed" row is in production.
 *
 * The cross-user ACL pins below depend on this shape: with no
 * dependent workspaces, `canViewAgent` short-circuits to creator-only,
 * which is exactly the structural property the "ACL-first" contract
 * relies on. Routing through `POST /api/agents` first (full L3a) and
 * then flipping the status leaves an agent_home workspace + a
 * workspace_users row behind, which would let `canViewAgent` match
 * via the workspace branch and mask the contract this test is meant
 * to lock down. The inbox does NOT reopen that branch: it is not a
 * workspace and carries no human membership row (§4.2), so
 * `canViewAgent` still short-circuits to creator-only.
 */
function seedFailedAgent(
  t: TestApp,
  createdByUserId: string,
  name: string,
  idempotencyKey: string,
): string {
  const hosts = new HostRepo(t.ctx.db);
  const owned = hosts.listOwnedActiveLocalForUser(createdByUserId);
  if (owned.length === 0) {
    throw new Error(
      `seedFailedAgent: user ${createdByUserId} has no owned local host (test fixture did not pre-claim)`,
    );
  }
  const hostId = owned[0]!.id;
  const agents = new AgentRepo(t.ctx.db);
  const row = createSqliteAgentProvisioningPersistence(
    t.ctx.db,
  ).reserveAgentAggregate({
    input: { name, runtime: 'claude' },
    defaultHostId: hostId,
    createdByUserId,
    idempotencyKey,
  });
  agents.flipToFailed(row.id, 'host_attach_pending', Date.now());
  return row.id;
}

function freshKey(): string {
  return `k-${randomBytes(8).toString('base64url')}`;
}

interface CreateAgentOk {
  agent: { id: string; name: string; model?: string | null };
  agent_home_workspace_id: string;
  dm_channel_id: string;
  onboarding_message_id: string;
}

describe('D4.d structural invariants', () => {
  describe('Invariant 1: metadata mismatch precedence (§3.2 / §6.1)', () => {
    // For each (row-status, field) pair: prime the DB so a same-key
    // agent row exists in row-status, then POST /api/agents with the
    // same idempotency key + a body that differs in `field`. The
    // route MUST return 400 `idempotency_metadata_mismatch` with
    // `mismatched_field === field`, NOT a status-dispatch response
    // (200 echo / 409 in-progress / 409 previously-failed).
    //
    // `template_choice` is excluded from the matrix: the route
    // hardcodes 'default' for both stored and request snapshot (D2
    // ships only 'default'), so mismatch on that axis is structurally
    // impossible until a later stage introduces a `template_choice`
    // column. The 5 remaining fields are exercised below.
    //
    // `host_id` mismatch needs the second user to have their own
    // local host — `TEST_FIXTURE_USER_IDS` provisions one per user,
    // so passing a different `host_id` in the body resolves to a
    // host the caller doesn't own → 403 placement_error BEFORE the
    // mismatch check (placement resolves first by design). To keep
    // host_id in the matrix we exercise it via a placement-valid but
    // semantically-different path: insert two owned local hosts for
    // the caller (via the test helper) and have the reserved row
    // carry one while the request carries the other.

    const ROW_STATUSES = ['pending_materialization', 'active', 'failed'] as const;
    type RowStatus = (typeof ROW_STATUSES)[number];

    interface FieldCase {
      field: 'name' | 'runtime' | 'model' | 'description' | 'host_id';
      base: {
        name: string;
        runtime: string;
        model?: string | null;
        description?: string | null;
      };
      // Returns body mutating only `field`.
      mutate: (
        body: ReturnType<FieldCase['baseFor']>,
      ) => Record<string, unknown>;
      baseFor: () => {
        name: string;
        runtime: string;
        model?: string | null;
        description?: string | null;
      };
    }

    const fieldCases: FieldCase[] = [
      {
        field: 'name',
        baseFor: () => ({ name: 'mm-name', runtime: 'claude' }),
        base: { name: 'mm-name', runtime: 'claude' },
        mutate: body => ({ ...body, name: `${body.name}-differs` }),
      },
      {
        field: 'runtime',
        baseFor: () => ({ name: 'mm-runtime', runtime: 'claude' }),
        base: { name: 'mm-runtime', runtime: 'claude' },
        mutate: body => ({ ...body, runtime: 'codex' }),
      },
      {
        field: 'model',
        baseFor: () => ({
          name: 'mm-model',
          runtime: 'claude',
          model: 'sonnet',
        }),
        base: { name: 'mm-model', runtime: 'claude', model: 'sonnet' },
        mutate: body => ({ ...body, model: 'opus' }),
      },
      {
        field: 'description',
        baseFor: () => ({
          name: 'mm-desc',
          runtime: 'claude',
          description: 'original',
        }),
        base: { name: 'mm-desc', runtime: 'claude', description: 'original' },
        mutate: body => ({ ...body, description: 'modified' }),
      },
      {
        field: 'host_id',
        baseFor: () => ({ name: 'mm-host', runtime: 'claude' }),
        base: { name: 'mm-host', runtime: 'claude' },
        // host_id mutation handled per-test (needs a second host id
        // owned by the same user) — mutate is the identity here and
        // the test overrides the field directly.
        mutate: body => body,
      },
    ];

    async function primeRow(
      t: TestApp,
      key: string,
      base: FieldCase['base'],
      status: RowStatus,
      hostIdOverride?: string,
    ): Promise<string> {
      // For active rows: hit the route normally so dependent rows
      // exist (the active dispatch path requires a DM channel to
      // echo back); we then snapshot the agent id and rewrite its
      // status to whatever the test needs. For pending/failed rows
      // we still hit the route to get dependent rows in place,
      // then flip the status by direct UPDATE. This isolates the
      // L0 mismatch comparator from any L1/L2/L3 plumbing details.
      const created = (await http(t)
        .post(
          '/api/agents',
          hostIdOverride ? { ...base, host_id: hostIdOverride } : base,
          {
            headers: { 'Idempotency-Key': key },
          },
        )
        .then(r => r.json())) as CreateAgentOk;
      expect(created.agent?.id, 'agent prime failed').toBeTruthy();
      const id = created.agent.id;
      if (status === 'pending_materialization') {
        t.ctx.db
          .prepare(
            `UPDATE agents
                SET materialization_status = 'pending_materialization',
                    materialization_failed_code = NULL,
                    materialization_failed_at = NULL
              WHERE id = ?`,
          )
          .run(id);
      } else if (status === 'failed') {
        t.ctx.db
          .prepare(
            `UPDATE agents
                SET materialization_status = 'failed',
                    materialization_failed_code = 'host_attach_pending',
                    materialization_failed_at = ?
              WHERE id = ?`,
          )
          .run(Date.now(), id);
      }
      return id;
    }

    for (const status of ROW_STATUSES) {
      for (const fcase of fieldCases) {
        it(`status=${status} × field=${fcase.field} → 400 idempotency_metadata_mismatch (mismatch BEFORE dispatch)`, async () => {
          const t = buildTestApp();
          tests.push(t);
          const key = freshKey();
          // Cindy D3 round-1 P1: existing-row dispatch path does
          // NOT call placement. The mismatch comparator compares
          // `request.host_id ?? row.host_id` literally to
          // `row.host_id` — any differing string trips mismatch
          // without ownership checks. The test no longer needs a
          // second owned-active local host; we just hand the
          // request a literal string that differs from the stored
          // row's host_id.
          await primeRow(t, key, fcase.base, status);

          // Build the mismatched body.
          let body: Record<string, unknown>;
          if (fcase.field === 'host_id') {
            const storedHostId = t.ctx.db
              .prepare<[string], { host_id: string }>(
                `SELECT host_id FROM agents WHERE idempotency_key = ?`,
              )
              .get(key)!.host_id;
            body = {
              ...fcase.base,
              host_id: `${storedHostId}-mismatch`,
            };
          } else {
            body = fcase.mutate({ ...fcase.base });
          }

          const res = await http(t).post('/api/agents', body, {
            headers: { 'Idempotency-Key': key },
          });

          // The load-bearing invariant: mismatch BEFORE dispatch.
          expect(res.status, await res.clone().text()).toBe(400);
          const payload = (await res.json()) as {
            code: string;
            mismatched_field?: string;
            error?: string;
          };
          expect(payload.code).toBe('idempotency_metadata_mismatch');
          expect(payload.mismatched_field).toBe(fcase.field);

          // Negative pins: NONE of the status-dispatch shapes are
          // returned. This is what makes the test exercise
          // "precedence", not just "mismatch is detected somewhere".
          expect(payload.code).not.toBe('materialization_in_progress');
          expect(payload.code).not.toBe('materialization_previously_failed');
          // 200 echo would have status 200 and code undefined — the
          // 400 status assertion above already rules it out.
        });
      }
    }

    // Cindy D3 round-1 P1 negative pin: same-key retry that
    // OMITS host_id MUST treat the stored row's host_id as the
    // effective value and short-circuit to the dispatch path
    // (here, 200 echo on an active row). Without the
    // `?? existingRow.host_id` fallback the comparator would
    // either flag mismatch (if it stored undefined) or call
    // placement (which is the bug). This test pins the omission
    // semantics.
    it('same-key retry omitting host_id → 200 echo on active row (no placement call)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const created = (await http(t)
        .post(
          '/api/agents',
          { name: 'omit-host-id', runtime: 'claude' },
          { headers: { 'Idempotency-Key': key } },
        )
        .then(r => r.json())) as CreateAgentOk;
      expect(created.agent?.id).toBeTruthy();
      const retry = await http(t).post(
        '/api/agents',
        // Body OMITS host_id; comparator must fall back to
        // stored row's host_id and NOT trip mismatch.
        { name: 'omit-host-id', runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(retry.status, await retry.clone().text()).toBe(200);
      const body = (await retry.json()) as CreateAgentOk;
      expect(body.agent.id).toBe(created.agent.id);
    });
  });

  describe('Invariant 2: ?include_failed=1 ACL-first (§4.1 / §7.3 / §10.3)', () => {
    // D5 un-skips. The regression mode this guards against: a future
    // refactor reordering `?include_failed=1` so it widens the result
    // set BEFORE the ACL gate runs. That would leak the existence of
    // every other user's failed agent rows through the management
    // view — a privilege-escalation side channel.
    //
    // The "ACL-first" contract is enforced by the structure of the
    // route filter: `canViewAgent` runs second, and for failed rows
    // `canViewAgent` already short-circuits to creator-only (failed
    // rows have NO dependent workspaces, so the workspace-membership
    // branch of `canViewAgent` can never match). Both tests below
    // exercise the cross-user negative path; the third
    // (own-rows-visible) pin is in `agent-failed-recovery.test.ts`.

    it('list: ?include_failed=1 from user B does NOT widen to user A failed rows', async () => {
      const t = buildTestApp();
      tests.push(t);

      // user A primes a failed row in its production shape: ONLY
      // the agents row, no dependent agent_home / DM / membership
      // rows. See `seedFailedAgent` for why a POST-then-flip
      // shortcut would mask the ACL contract this test pins.
      const userA = 'alice';
      const userB = 'bob';
      const failedAgentName = `inv2-user-a-failed-${freshKey()}`;
      const userAAgentId = seedFailedAgent(
        t,
        userA,
        failedAgentName,
        freshKey(),
      );

      // user B lists with ?include_failed=1. They should see their
      // own agents (none failed in this fixture) but NOT user A's
      // failed row.
      const userBList = await http(t).get('/api/agents?include_failed=1', {
        headers: {
          [X_SILVERHAND_LEGACY_USER_ID_HEADER]: userB,
        },
      });
      expect(userBList.status, await userBList.clone().text()).toBe(200);
      const body = (await userBList.json()) as {
        agents: Array<{ id: string; name: string }>;
      };
      const ids = body.agents.map(a => a.id);
      expect(ids).not.toContain(userAAgentId);
      const names = body.agents.map(a => a.name);
      expect(names).not.toContain(failedAgentName);
    });

    it('get: cross-user GET /api/agents/:id with ?include_failed=1 returns 404', async () => {
      const t = buildTestApp();
      tests.push(t);

      const userA = 'alice';
      const userB = 'bob';
      const userAAgentId = seedFailedAgent(
        t,
        userA,
        `inv2-cross-${freshKey()}`,
        freshKey(),
      );

      // user B → 404 even with the widener. ACL gate fires after
      // the failed-status filter, so cross-user lookup of someone
      // else's failed row stays invisible.
      const cross = await http(t).get(
        `/api/agents/${userAAgentId}?include_failed=1`,
        {
          headers: {
            [X_SILVERHAND_LEGACY_USER_ID_HEADER]: userB,
          },
        },
      );
      expect(cross.status).toBe(404);
    });
  });

  describe('Invariant 3: L3a tx atomicity (§6.3 L3a/L3b)', () => {
    // Force a dependent-row INSERT inside the L3a transaction to
    // throw by installing a `BEFORE INSERT` trigger on
    // `conversations` that ABORTs when the row is a DM channel.
    // `conversations.insertDmChannel` is the 2nd dependent op in
    // the route's L3a tx (right after `workspaces.insertAgentHome`),
    // so the trigger fires inside the transaction, the tx rolls
    // back, and the route's catch arm MUST flip the row to failed
    // via a SEPARATE tx — that's the structural call Cindy locked
    // down: "do NOT rely on implicit rollback leaving the row in
    // pending_materialization for a boot reconciler to clean up".
    //
    // Single test asserts all three observables simultaneously
    // because they're all consequences of the same L3a failure.

    it('L3a dependent-row failure → (a) status != active, (b) zero dependent rows, (c) explicit L3b failed + code + ts', async () => {
      const t = buildTestApp();
      tests.push(t);

      // Install the trigger BEFORE the POST. ABORT inside a tx
      // rolls the whole tx back.
      //
      // `placement_kind = 'workspace'` is load-bearing (v71): `kind` is a
      // GENERATED column and an `agent_inbox` also reads as `dm_channel`, so a
      // predicate on `kind` alone would abort the L1 AGGREGATE reserve instead —
      // a different phase, a different failure (409 `agent_name_taken`), and the
      // L3a arm this test exists for would never run.
      t.ctx.db.exec(
        `CREATE TRIGGER d4d_inv3_fail_dm_insert
           BEFORE INSERT ON conversations
           WHEN NEW.kind = 'dm_channel' AND NEW.placement_kind = 'workspace'
         BEGIN
           SELECT RAISE(ABORT, 'd4d-inv3: forced dependent-row failure');
         END`,
      );

      const beforeAgents = t.ctx.db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM agents')
        .get()!.c;

      const res = await http(t).post('/api/agents', {
        name: 'inv3-l3a-fail',
        runtime: 'claude',
      });

      // The route reports dependent_row_insert_failed (500) when
      // the L3a tx throws.
      expect(res.status, await res.clone().text()).toBe(500);
      const body = (await res.json()) as { code: string; error?: string };
      expect(body.code).toBe('dependent_row_insert_failed');

      // Drop the trigger so subsequent DB inspection isn't affected
      // (it would only fire on further DM inserts, but cleaner to
      // drop it before assertions read other tables).
      t.ctx.db.exec(`DROP TRIGGER d4d_inv3_fail_dm_insert`);

      const agentRows = t.ctx.db
        .prepare<
          [],
          {
            id: string;
            name: string;
            materialization_status: string;
            materialization_failed_code: string | null;
            materialization_failed_at: number | null;
          }
        >(
          `SELECT id, name, materialization_status,
                  materialization_failed_code, materialization_failed_at
             FROM agents
            WHERE name = 'inv3-l3a-fail'`,
        )
        .all();
      expect(agentRows).toHaveLength(1);
      const agent = agentRows[0]!;

      // (a) status does NOT flip to 'active' (Cindy invariant #1).
      expect(agent.materialization_status).not.toBe('active');
      // (c) explicit L3b flipped row to failed with the typed code
      //     + non-null failed_at (Cindy invariant #3 — explicit L3b
      //     catch, NOT implicit rollback).
      expect(agent.materialization_status).toBe('failed');
      expect(agent.materialization_failed_code).toBe(
        'dependent_row_insert_failed',
      );
      expect(agent.materialization_failed_at).not.toBeNull();
      expect(typeof agent.materialization_failed_at).toBe('number');

      // (b) zero dependent rows survive across every dependent
      //     table. Each count below is keyed by the agent id so a
      //     dirty leftover from a different agent row in the same
      //     fixture wouldn't mask the assertion.
      const dependentCounts = {
        agent_home: t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM workspaces
              WHERE workspace_kind = 'agent_home'
                AND owner_agent_id = ?`,
          )
          .get(agent.id)!.c,
        dm_channels: t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM conversations c
               JOIN conversation_agents ca ON ca.conversation_id = c.id
              WHERE c.kind = 'dm_channel' AND ca.agent_id = ?`,
          )
          .get(agent.id)!.c,
        conversation_agents: t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM conversation_agents WHERE agent_id = ?`,
          )
          .get(agent.id)!.c,
        workspace_users: t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM workspace_users
              WHERE workspace_id = ?`,
          )
          .get(`wsah_${agent.id}`)!.c,
        conversation_users: t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM conversation_users
              WHERE conversation_id IN (
                SELECT id FROM conversations WHERE workspace_id = ?
              )`,
          )
          .get(`wsah_${agent.id}`)!.c,
        onboarding_messages: t.ctx.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM messages
              WHERE conversation_id IN (
                SELECT id FROM conversations WHERE workspace_id = ?
              )`,
          )
          .get(`wsah_${agent.id}`)!.c,
      };
      // Every dependent count is exactly 0.
      expect(dependentCounts).toEqual({
        agent_home: 0,
        dm_channels: 0,
        conversation_agents: 0,
        workspace_users: 0,
        conversation_users: 0,
        onboarding_messages: 0,
      });

      // Sanity: exactly one new agent row exists (the failed one);
      // no orphan duplicates from re-tries inside the failed path.
      const afterAgents = t.ctx.db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM agents')
        .get()!.c;
      expect(afterAgents).toBe(beforeAgents + 1);
    });
  });

  describe('Standalone happy path (D4.d D3 lift)', () => {
    // The standalone gate (D4.c C4 marker) was removed in D3. POST
    // /api/agents in standalone mode now dispatches the
    // `agent_materialize` wire intent and, on ack, lands the same
    // 201 payload as embedded mode. This pin makes the lift
    // observable: if a regression brings back the 409
    // `host_runtime_disabled` short-circuit it fails here first.
    it('standalone backend with healthy controller → 201 with agent + DM + onboarding ids', async () => {
      const t = buildTestApp({ deploymentMode: 'standalone' });
      tests.push(t);
      const res = await http(t).post('/api/agents', {
        name: `standalone-happy-${randomBytes(4).toString('base64url')}`,
        runtime: 'claude',
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as CreateAgentOk;
      expect(body.agent?.id).toBeTruthy();
      expect(body.agent_home_workspace_id).toBe(`wsah_${body.agent.id}`);
      expect(body.dm_channel_id).toBeTruthy();
      expect(body.onboarding_message_id).toBeTruthy();
      // The newly-created agent row should be active + clean.
      const row = t.ctx.db
        .prepare<
          [string],
          {
            materialization_status: string;
            materialization_failed_code: string | null;
            materialization_failed_at: number | null;
          }
        >(
          `SELECT materialization_status, materialization_failed_code,
                  materialization_failed_at
             FROM agents WHERE id = ?`,
        )
        .get(body.agent.id)!;
      expect(row.materialization_status).toBe('active');
      expect(row.materialization_failed_code).toBeNull();
      expect(row.materialization_failed_at).toBeNull();
      // And the wire intent was actually dispatched on this host.
      const calls =
        t.fakeHostWs?.calls.filter(c => c.kind === 'agent_materialize') ?? [];
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(
        (call.params as { agent_id: string }).agent_id,
      ).toBe(body.agent.id);
    });
  });

  describe('Runtime create defaults', () => {
    it('qoder create without explicit model stores and materializes Ultimate', async () => {
      const t = buildTestApp();
      tests.push(t);
      const res = await http(t).post('/api/agents', {
        name: `qoder-default-model-${randomBytes(4).toString('base64url')}`,
        runtime: 'qoder',
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as CreateAgentOk;
      expect(body.agent.model).toBe('Ultimate');

      const row = t.ctx.db
        .prepare<[string], { model: string | null }>(
          `SELECT model FROM agents WHERE id = ?`,
        )
        .get(body.agent.id)!;
      expect(row.model).toBe('Ultimate');

      const calls =
        t.fakeHostWs?.calls.filter(c => c.kind === 'agent_materialize') ?? [];
      expect(calls).toHaveLength(1);
      expect((calls[0]!.params as { model: string | null }).model).toBe(
        'Ultimate',
      );
    });
  });

  describe('Round-1 P1.3 — active idempotent echo shape == 201 fresh shape', () => {
    // Cindy D3 round-1 P1.3: same-key retry on an active row must
    // return the EXACT same 4-field payload as the fresh 201 success
    // (agent / agent_home_workspace_id / dm_channel_id /
    // onboarding_message_id). Without this, clients can't treat
    // retry and original create as interchangeable.
    it('active row same-key retry → 200 with identical 4-field shape (agent + home + DM + onboarding)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const first = await http(t).post(
        '/api/agents',
        { name: 'echo-shape', runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(first.status, await first.clone().text()).toBe(201);
      const firstBody = (await first.json()) as CreateAgentOk;

      const retry = await http(t).post(
        '/api/agents',
        { name: 'echo-shape', runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(retry.status, await retry.clone().text()).toBe(200);
      const echoBody = (await retry.json()) as CreateAgentOk;

      // Same shape: every key is present and the dependent ids
      // round-trip to the same values the 201 returned.
      expect(echoBody.agent.id).toBe(firstBody.agent.id);
      expect(echoBody.agent_home_workspace_id).toBe(
        firstBody.agent_home_workspace_id,
      );
      expect(echoBody.dm_channel_id).toBe(firstBody.dm_channel_id);
      expect(echoBody.onboarding_message_id).toBe(
        firstBody.onboarding_message_id,
      );
      // Negative pin: echo NEVER strips a field to undefined / null.
      expect(echoBody.onboarding_message_id).toBeTruthy();
      expect(echoBody.agent_home_workspace_id).toBeTruthy();
    });

    // Cindy refinement `m-K0qV09mGuRqwtu` #2: if a dependent-row
    // lookup fails on the echo path (DM or onboarding missing), the
    // route MUST 500 `internal_error` — never silently downgrade to
    // a null field. An active agent row without its onboarding seed
    // is a corrupt dependent graph, not a permitted state.
    it('active row whose onboarding message was deleted → 500 internal_error (no null fallback)', async () => {
      const t = buildTestApp();
      tests.push(t);
      const key = freshKey();
      const created = (await http(t)
        .post(
          '/api/agents',
          { name: 'echo-corrupt', runtime: 'claude' },
          { headers: { 'Idempotency-Key': key } },
        )
        .then(r => r.json())) as CreateAgentOk;
      // External mutation: wipe the onboarding system message in
      // the DM.
      t.ctx.db
        .prepare(
          `DELETE FROM messages
            WHERE conversation_id = ?
              AND from_kind = 'system'
              AND json_extract(metadata, '$.subtype') = 'onboarding'`,
        )
        .run(created.dm_channel_id);
      const retry = await http(t).post(
        '/api/agents',
        { name: 'echo-corrupt', runtime: 'claude' },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(retry.status, await retry.clone().text()).toBe(500);
      const body = (await retry.json()) as { code: string };
      expect(body.code).toBe('internal_error');
    });
  });

  describe('Round-1 P1.4 — L4 post-commit best-effort', () => {
    // Cindy D3 round-1 P1.4: L3a commit IS the create-succeeded
    // boundary. L4 `deliverMessage` / `start` failures only log; the
    // HTTP response stays 201, the row stays active, and all
    // dependent rows are present. Without this, a transient daemon
    // hiccup between materialize ack and deliver leaves an active
    // agent that the route reported as failed — and the next
    // same-key retry would 200 echo, the worst possible
    // "looks-failed-but-already-created" UX.
    it('deliverMessage throws after L3a commit → still 201 + row active + dependent rows present', async () => {
      const t = buildTestApp();
      tests.push(t);
      t.fake.deliverError = new Error('simulated post-commit deliver failure');
      const res = await http(t).post('/api/agents', {
        name: 'l4-deliver-fail',
        runtime: 'claude',
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as CreateAgentOk;
      // Row active + clean.
      const row = t.ctx.db
        .prepare<
          [string],
          {
            materialization_status: string;
            materialization_failed_code: string | null;
            materialization_failed_at: number | null;
          }
        >(
          `SELECT materialization_status, materialization_failed_code,
                  materialization_failed_at
             FROM agents WHERE id = ?`,
        )
        .get(body.agent.id)!;
      expect(row.materialization_status).toBe('active');
      expect(row.materialization_failed_code).toBeNull();
      expect(row.materialization_failed_at).toBeNull();
      // Dependent rows all present (the L3a tx committed
      // BEFORE deliverMessage was attempted).
      const dm = t.ctx.db
        .prepare<[string], { id: string }>(
          `SELECT c.id FROM conversations c
             JOIN conversation_agents ca ON ca.conversation_id = c.id
            WHERE c.kind = 'dm_channel' AND ca.agent_id = ?`,
        )
        .get(body.agent.id);
      expect(dm?.id).toBeTruthy();
      const onboardingCount = t.ctx.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM messages
            WHERE conversation_id = ?
              AND from_kind = 'system'
              AND json_extract(metadata, '$.subtype') = 'onboarding'`,
        )
        .get(dm!.id)!.c;
      expect(onboardingCount).toBe(1);
      // The fake recorded zero delivers (the throw fired before
      // `delivered.push`). A successful create would have recorded 1.
      expect(t.fake.delivered).toHaveLength(0);
    });
  });

  describe('Round-1 P1.2 — Idempotency-Key header required', () => {
    // Cindy D3 round-1 P1.2: `POST /api/agents` requires an
    // `Idempotency-Key` header per design §14 Q1. The
    // `tests/utils/app.ts` http helper auto-injects a random one
    // so legacy tests stay valid; this test deliberately bypasses
    // the helper to pin the unmediated public contract — a request
    // without the header MUST 400 before any DB write.
    //
    // This catches the regression mode that masked the renderer
    // hook bug (`apps/desktop/.../hooks.ts` was sending no header
    // until D3 round-1 fixup); the auto-inject in test scaffolding
    // would have hidden the bad client.
    it('missing Idempotency-Key (raw app.fetch) → 400 + agent count unchanged', async () => {
      const t = buildTestApp();
      tests.push(t);
      const before = t.ctx.db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM agents')
        .get()!.c;
      // Bypass the http() helper's auto-injected `Idempotency-Key`: build
      // the Request manually so the ONE header under test is genuinely
      // absent. The desktop API epoch header is still sent — an epoch-less
      // client is refused at admission (426) and would never reach the
      // idempotency parse this pins.
      const res = await t.app.fetch(
        new Request('http://localhost/api/agents', {
          method: 'POST',
          headers: {
            ...CURRENT_DESKTOP_EPOCH_HEADERS,
            'content-type': 'application/json',
            authorization: `Bearer ${t.authToken}`,
          },
          body: JSON.stringify({ name: 'no-key', runtime: 'claude' }),
        }),
      );
      expect(res.status, await res.clone().text()).toBe(400);
      const body = (await res.json()) as { code?: string; error?: string };
      // The exact code key is whatever d3ParseIdempotencyKey returns
      // — assert it surfaces a typed code and that the error text
      // mentions the header name so the regression is unambiguous.
      expect(body.code ?? body.error).toBeTruthy();
      expect(JSON.stringify(body)).toContain('dempotency-Key');
      // No DB write happened.
      const after = t.ctx.db
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM agents')
        .get()!.c;
      expect(after).toBe(before);
    });
  });

  const tests: TestApp[] = [];
  afterEach(() => {
    while (tests.length > 0) {
      tests.pop()!.cleanup();
    }
  });
});
