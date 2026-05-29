import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiPaths,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
  type ScheduleDto,
} from '@silverhand/shared';
import { HostRepo } from '../../src/repos/host-repo.js';
import { ScheduleRepo } from '../../src/repos/schedule-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * User-facing public routes for the agent panel's Schedules tab.
 *
 * These are thin wrappers over `ScheduleService` (same code path the
 * agent's CLI `schedule list` / `schedule cancel` commands use). Service-
 * level behavior is covered by tests/services/schedule-service.test.ts;
 * agent-side internal routes by tests/routes/schedules.test.ts. This file
 * specifically verifies the user-principal entry points behind
 * `/api/agents/:id/schedules` and `/api/agents/:id/schedules/:sid/cancel`.
 *
 * Why a separate user-side route at all (vs. reusing the internal
 * agent-principal path)? The internal route requires an agent
 * principal — i.e. a `(conversation_id, agent_id)` pair authenticated
 * by the per-agent CLI bearer. The desktop UI runs as the user principal
 * and has no agent context, so we expose a public agent-scoped route
 * with the same backing service.
 */

interface Setup {
  aliceId: string;
  bobId: string;
}

async function setupTwoAgents(t: TestApp): Promise<Setup> {
  const a = await (await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })).json() as any;
  const b = await (await http(t).post('/api/agents', { name: 'bob', runtime: 'claude' })).json() as any;
  return { aliceId: a.agent.id as string, bobId: b.agent.id as string };
}

/** Insert a schedule for `ownerAgentId` directly through the repo so
 *  these tests don't depend on the agent-principal path being correct. */
function seedSchedule(
  t: TestApp,
  ownerAgentId: string,
  overrides: Partial<{
    title: string;
    message: string;
    status: ScheduleDto['status'];
    nextFireAt: number;
  }> = {},
): ScheduleDto {
  const repo = new ScheduleRepo(t.ctx.db);
  const now = Date.now();
  const dto = repo.insert({
    ownerAgentId,
    // The Agent Schedules panel renders schedules regardless of target,
    // so seed with a placeholder string. Tests that exercise wake routing
    // live in `schedule-service.test.ts` against the real service.
    targetConversationId: 'panel-seed-target',
    title: overrides.title ?? 'Panel seed',
    message: overrides.message ?? 'panel-seed',
    spec: { kind: 'once', fire_at: overrides.nextFireAt ?? now + 60_000 },
    nextFireAt: overrides.nextFireAt ?? now + 60_000,
    maxOccurrences: null,
    untilAt: null,
  });
  if (overrides.status && overrides.status !== 'pending') {
    // Drive the row into a non-default status via a raw write — only
    // used for the "list filter" / "cancel terminal" assertions.
    t.ctx.db
      .prepare(`UPDATE schedules SET status = ? WHERE id = ?`)
      .run(overrides.status, dto.id);
    return { ...dto, status: overrides.status };
  }
  return dto;
}

describe('GET /api/agents/:id/schedules', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns the agent\'s schedules ordered by next_fire_at', async () => {
    t = buildTestApp();
    const { aliceId } = await setupTwoAgents(t);
    const later = seedSchedule(t, aliceId, {
      message: 'later',
      nextFireAt: Date.now() + 600_000,
    });
    const sooner = seedSchedule(t, aliceId, {
      message: 'sooner',
      nextFireAt: Date.now() + 60_000,
    });
    const res = await http(t).get(apiPaths.agentSchedules(aliceId));
    expect(res.status).toBe(200);
    const body = await res.json() as { schedules: ScheduleDto[] };
    expect(body.schedules.map(s => s.id)).toEqual([sooner.id, later.id]);
  });

  it('isolates schedules between agents', async () => {
    t = buildTestApp();
    const { aliceId, bobId } = await setupTwoAgents(t);
    seedSchedule(t, aliceId, { message: 'alice-1' });
    seedSchedule(t, bobId, { message: 'bob-1' });
    const res = await http(t).get(apiPaths.agentSchedules(aliceId));
    const body = await res.json() as { schedules: ScheduleDto[] };
    expect(body.schedules.map(s => s.message)).toEqual(['alice-1']);
  });

  it('respects the active alias filter', async () => {
    t = buildTestApp();
    const { aliceId } = await setupTwoAgents(t);
    seedSchedule(t, aliceId, { message: 'pending-row' });
    seedSchedule(t, aliceId, { message: 'cancelled-row', status: 'cancelled' });
    const active = await (
      await http(t).get(`${apiPaths.agentSchedules(aliceId)}?status=active`)
    ).json() as { schedules: ScheduleDto[] };
    expect(active.schedules.map(s => s.message)).toEqual(['pending-row']);

    const cancelled = await (
      await http(t).get(`${apiPaths.agentSchedules(aliceId)}?status=cancelled`)
    ).json() as { schedules: ScheduleDto[] };
    expect(cancelled.schedules.map(s => s.message)).toEqual(['cancelled-row']);
  });

  it('coerces ?limit string into a number', async () => {
    t = buildTestApp();
    const { aliceId } = await setupTwoAgents(t);
    for (let i = 0; i < 5; i++) {
      seedSchedule(t, aliceId, { message: `s${i}`, nextFireAt: Date.now() + 60_000 + i });
    }
    const res = await http(t).get(`${apiPaths.agentSchedules(aliceId)}?limit=2`);
    const body = await res.json() as { schedules: ScheduleDto[] };
    expect(body.schedules).toHaveLength(2);
  });

  it('400 invalid query — bogus status enum', async () => {
    t = buildTestApp();
    const { aliceId } = await setupTwoAgents(t);
    const res = await http(t).get(`${apiPaths.agentSchedules(aliceId)}?status=not-a-status`);
    expect(res.status).toBe(400);
  });

  it('404 when the agent does not exist', async () => {
    t = buildTestApp();
    const res = await http(t).get(apiPaths.agentSchedules('no-such-agent'));
    expect(res.status).toBe(404);
  });

  it('keeps schedules owner-only for workspace-visible non-owners', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'teammate-scheduled', runtime: 'claude' },
        { headers: teammateHeaders },
      )
    ).json() as any;
    const ws = await (
      await http(t).post(
        '/api/workspaces',
        { name: 'schedules-visible', member_agent_ids: [created.agent.id] },
        { headers: teammateHeaders },
      )
    ).json() as any;
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
         VALUES (?, 'local', ?)`,
      )
      .run(ws.workspace.id, Date.now());
    seedSchedule(t, created.agent.id);

    const res = await http(t).get(apiPaths.agentSchedules(created.agent.id));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/agents/:id/schedules/:scheduleId/cancel', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('cancels a pending schedule and returns the updated row', async () => {
    t = buildTestApp();
    const { aliceId } = await setupTwoAgents(t);
    const seeded = seedSchedule(t, aliceId);
    const res = await http(t).post(
      apiPaths.agentScheduleCancel(aliceId, seeded.id),
      undefined,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { schedule: ScheduleDto };
    expect(body.schedule.id).toBe(seeded.id);
    expect(body.schedule.status).toBe('cancelled');
    expect(body.schedule.cancelled_at).not.toBeNull();
  });

  it('403 not_owner when the schedule belongs to a different agent', async () => {
    t = buildTestApp();
    const { aliceId, bobId } = await setupTwoAgents(t);
    const aliceSchedule = seedSchedule(t, aliceId);
    // Try to cancel alice's schedule via bob's agent path — service
    // returns `not_owner` so a UI mistake (clicked the row from the
    // wrong agent panel) cannot quietly cancel a stranger's schedule.
    const res = await http(t).post(
      apiPaths.agentScheduleCancel(bobId, aliceSchedule.id),
      undefined,
    );
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe('not_owner');
  });

  it('404 schedule_not_found when the id is unknown', async () => {
    t = buildTestApp();
    const { aliceId } = await setupTwoAgents(t);
    const res = await http(t).post(
      apiPaths.agentScheduleCancel(aliceId, 'no-such-schedule'),
      undefined,
    );
    expect(res.status).toBe(404);
    expect((await res.json() as any).code).toBe('schedule_not_found');
  });

  it('404 when the agent does not exist', async () => {
    t = buildTestApp();
    const res = await http(t).post(
      apiPaths.agentScheduleCancel('no-such-agent', 'nope'),
      undefined,
    );
    expect(res.status).toBe(404);
  });

  it('409 not_cancellable when the schedule is already terminal', async () => {
    t = buildTestApp();
    const { aliceId } = await setupTwoAgents(t);
    const done = seedSchedule(t, aliceId, { status: 'done' });
    const res = await http(t).post(
      apiPaths.agentScheduleCancel(aliceId, done.id),
      undefined,
    );
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe('not_cancellable');
  });

  it('keeps cancel owner-only for workspace-visible non-owners', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'teammate-cancel', runtime: 'claude' },
        { headers: teammateHeaders },
      )
    ).json() as any;
    const ws = await (
      await http(t).post(
        '/api/workspaces',
        { name: 'cancel-visible', member_agent_ids: [created.agent.id] },
        { headers: teammateHeaders },
      )
    ).json() as any;
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
         VALUES (?, 'local', ?)`,
      )
      .run(ws.workspace.id, Date.now());
    const seeded = seedSchedule(t, created.agent.id);

    const res = await http(t).post(
      apiPaths.agentScheduleCancel(created.agent.id, seeded.id),
      undefined,
    );
    expect(res.status).toBe(403);
  });

  it('audit log captures viewer id from the X-Silverhand-Principal header', async () => {
    // Regression for Cindy's PR-3a round-1 review: the audit hook had
    // been logging `ctx.serverConfig.user_id` (always null in the
    // single-host desktop setup), which silently dropped the desktop
    // viewer's id. Switching to `resolveViewerUserId` makes the
    // request principal authoritative — pin it so a regression cannot
    // re-introduce the null-id audit.
    t = buildTestApp();
    const infoSpy = vi.spyOn(t.ctx.logger, 'info');
    // Seed the desktop user the test impersonates. The test helper
    // mints the matching session bearer from the request headers.
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO users (id, name, display_name, created_at, updated_at)
         VALUES ('desktop-user-42', 'desktop-user-42-name', 'Desktop User 42', ?, ?)`,
      )
      .run(now, now);
    new HostRepo(t.ctx.db).claimOrCreateLocal({
      userId: 'desktop-user-42',
      installationId: 'desktop-user-42-install',
    });
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'desktop-audited', runtime: 'claude' },
        {
          headers: {
            [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(
              'desktop-user-42',
            ),
          },
        },
      )
    ).json() as any;
    const seeded = seedSchedule(t, created.agent.id);
    const res = await http(t).post(
      apiPaths.agentScheduleCancel(created.agent.id, seeded.id),
      undefined,
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(
            'desktop-user-42',
          ),
        },
      },
    );
    expect(res.status).toBe(200);
    const auditCall = infoSpy.mock.calls.find(
      ([, message]) => message === 'agent schedule cancelled by user',
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[0]).toMatchObject({
      user_id: 'desktop-user-42',
      agent_id: created.agent.id,
      schedule_id: seeded.id,
    });
  });
});
