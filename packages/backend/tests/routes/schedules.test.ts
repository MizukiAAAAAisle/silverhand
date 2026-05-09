import { afterEach, describe, expect, it } from 'vitest';
import {
  internalPaths,
  SCHEDULE_MAX_ACTIVE_PER_AGENT,
  SCHEDULE_MAX_DELAY_SECONDS,
  SCHEDULE_MIN_DELAY_SECONDS,
  type ScheduleDto,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Route-level coverage for the agent-owned `schedule` MCP tools.
 *
 * The internal routes are thin wrappers over `ScheduleService` (full
 * service unit-tests live in tests/services/schedule-service.test.ts).
 * What we MUST verify here is the route boundary itself:
 *   - happy paths return canonical `ScheduleDto` JSON
 *   - principal middleware enforces conversation membership
 *   - every `ScheduleErrorCode` maps to the documented HTTP status
 *   - cross-agent ownership boundary holds (alice can't cancel bob's schedule)
 *
 * Tests use `disableAutoTick: true` (see buildTestApp) so the sweep
 * timer never runs — every state transition is explicit.
 */

interface Setup {
  conversationId: string;
  aliceId: string;
  bobId: string;
}

async function setupTwoAgentChannel(t: TestApp): Promise<Setup> {
  const aliceRes = await (
    await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
  ).json() as any;
  const bobRes = await (
    await http(t).post('/api/agents', { name: 'bob', runtime: 'claude' })
  ).json() as any;
  const aliceId = aliceRes.agent.id as string;
  const bobId = bobRes.agent.id as string;
  const ws = await (
    await http(t).post('/api/workspaces', {
      name: 'sched',
      member_agent_ids: [aliceId, bobId],
    })
  ).json() as any;
  // Drain manager bookkeeping from provisioning so each test starts clean.
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    conversationId: ws.onboarding_channel_id as string,
    aliceId,
    bobId,
  };
}

function createPath(cid: string, aid: string): string {
  return internalPaths.agentScheduleCreate(cid, aid);
}
function listPath(cid: string, aid: string): string {
  return internalPaths.agentScheduleList(cid, aid);
}
function cancelPath(cid: string, aid: string): string {
  return internalPaths.agentScheduleCancel(cid, aid);
}

describe('Internal routes — agent schedules', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  // ── Happy-path coverage ──────────────────────────────────────────

  it('schedule (once with delay_seconds) returns canonical fire_at', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const before = Date.now();
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'check tomorrow',
      spec: { kind: 'once', delay_seconds: 60 },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { schedule: ScheduleDto };
    expect(body.schedule.owner_agent_id).toBe(aliceId);
    expect(body.schedule.spec.kind).toBe('once');
    // Server canonicalises delay_seconds → fire_at; the result must
    // expose the absolute time so the agent doesn't have to recompute.
    expect(body.schedule.spec).toMatchObject({ kind: 'once' });
    expect((body.schedule.spec as any).fire_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(body.schedule.next_fire_at).toBe((body.schedule.spec as any).fire_at);
    expect(body.schedule.status).toBe('pending');
    expect(body.schedule.fired_count).toBe(0);
  });

  it('schedule (interval) accepts allow_unbounded and persists start_at default', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'heartbeat',
      spec: { kind: 'interval', every_seconds: 60 },
      allow_unbounded: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { schedule: ScheduleDto };
    expect(body.schedule.spec).toEqual({ kind: 'interval', every_seconds: 60 });
    expect(body.schedule.max_occurrences).toBeNull();
    expect(body.schedule.until_at).toBeNull();
  });

  it('schedule (cron) round-trips expression + timezone', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'morning standup',
      spec: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
      max_occurrences: 5,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { schedule: ScheduleDto };
    expect(body.schedule.spec).toEqual({
      kind: 'cron',
      expression: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    });
    expect(body.schedule.max_occurrences).toBe(5);
    expect(body.schedule.next_fire_at).toBeGreaterThan(Date.now());
  });

  it('list_schedules returns only the caller\'s schedules', async () => {
    t = buildTestApp();
    const { conversationId, aliceId, bobId } = await setupTwoAgentChannel(t);
    // alice creates two; bob creates one. list under alice must see only hers.
    await http(t).post(createPath(conversationId, aliceId), {
      message: 'a1',
      spec: { kind: 'once', delay_seconds: 60 },
    });
    await http(t).post(createPath(conversationId, aliceId), {
      message: 'a2',
      spec: { kind: 'once', delay_seconds: 90 },
    });
    await http(t).post(createPath(conversationId, bobId), {
      message: 'b1',
      spec: { kind: 'once', delay_seconds: 120 },
    });
    const res = await http(t).post(listPath(conversationId, aliceId), {});
    expect(res.status).toBe(200);
    const body = await res.json() as { schedules: ScheduleDto[] };
    expect(body.schedules.map(s => s.owner_agent_id)).toEqual([aliceId, aliceId]);
    expect(body.schedules.map(s => s.message).sort()).toEqual(['a1', 'a2']);
  });

  it('list_schedules respects status filter (active alias)', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const created = await (await http(t).post(createPath(conversationId, aliceId), {
      message: 'one',
      spec: { kind: 'once', delay_seconds: 60 },
    })).json() as { schedule: ScheduleDto };
    // Cancel one so we have a non-pending row.
    await http(t).post(cancelPath(conversationId, aliceId), {
      schedule_id: created.schedule.id,
    });
    await http(t).post(createPath(conversationId, aliceId), {
      message: 'two',
      spec: { kind: 'once', delay_seconds: 90 },
    });
    const active = await (
      await http(t).post(listPath(conversationId, aliceId), { status: 'active' })
    ).json() as { schedules: ScheduleDto[] };
    expect(active.schedules.map(s => s.message)).toEqual(['two']);

    const cancelled = await (
      await http(t).post(listPath(conversationId, aliceId), { status: 'cancelled' })
    ).json() as { schedules: ScheduleDto[] };
    expect(cancelled.schedules.map(s => s.message)).toEqual(['one']);
  });

  it('cancel_schedule transitions pending → cancelled and surfaces the row', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const created = await (
      await http(t).post(createPath(conversationId, aliceId), {
        message: 'cancel-me',
        spec: { kind: 'once', delay_seconds: 60 },
      })
    ).json() as { schedule: ScheduleDto };
    const res = await http(t).post(cancelPath(conversationId, aliceId), {
      schedule_id: created.schedule.id,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { schedule: ScheduleDto };
    expect(body.schedule.status).toBe('cancelled');
    expect(body.schedule.cancelled_at).not.toBeNull();
  });

  // ── Error-code coverage ──────────────────────────────────────────
  // One assertion per ScheduleErrorCode so the route → status map is
  // pinned. If the map drifts, exactly one of these should fail.

  it('400 invalid_input — message empty', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: '',
      spec: { kind: 'once', delay_seconds: 60 },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('invalid_input');
  });

  it('400 invalid_input — once spec without fire_at/delay_seconds', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'once' },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('invalid_input');
  });

  // Once-spec strict-reject: per PR-2 review (Cindy's blocker), one-shots
  // are not allowed to carry repeat-only knobs. Silent-ignore would let
  // the agent see e.g. `max_occurrences=3` on a row that fires exactly
  // once; reject so the agent learns immediately the field is misplaced.
  it.each(['max_occurrences', 'until_at', 'allow_unbounded'] as const)(
    '400 invalid_input — once spec with %s rejected',
    async field => {
      t = buildTestApp();
      const { conversationId, aliceId } = await setupTwoAgentChannel(t);
      const body: Record<string, unknown> = {
        message: 'x',
        spec: { kind: 'once', delay_seconds: 600 },
      };
      if (field === 'max_occurrences') body.max_occurrences = 3;
      else if (field === 'until_at') body.until_at = Date.now() + 24 * 3600 * 1000;
      else body.allow_unbounded = true;
      const res = await http(t).post(createPath(conversationId, aliceId), body);
      expect(res.status).toBe(400);
      expect((await res.json() as any).code).toBe('invalid_input');
    },
  );

  it('400 invalid_cron_expression — alias rejected', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'cron', expression: '@daily', timezone: 'Asia/Shanghai' },
      max_occurrences: 1,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('invalid_cron_expression');
  });

  it('400 invalid_cron_expression — 6-field rejected', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'cron', expression: '0 0 9 * * *', timezone: 'Asia/Shanghai' },
      max_occurrences: 1,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('invalid_cron_expression');
  });

  it('400 invalid_timezone — bogus IANA name', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
      max_occurrences: 1,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('invalid_timezone');
  });

  it('400 fire_at_too_soon — sub-min delay', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'once', delay_seconds: SCHEDULE_MIN_DELAY_SECONDS - 1 },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('fire_at_too_soon');
  });

  it('400 fire_at_too_far — > 90d delay', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'once', delay_seconds: SCHEDULE_MAX_DELAY_SECONDS + 60 },
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('fire_at_too_far');
  });

  it('400 unbounded_repeat_requires_explicit_limit', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'interval', every_seconds: 60 },
      // No max_occurrences / until_at / allow_unbounded.
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe('unbounded_repeat_requires_explicit_limit');
  });

  it('429 too_many_active_schedules', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    // Burn the per-agent active cap with cheap one-shots.
    for (let i = 0; i < SCHEDULE_MAX_ACTIVE_PER_AGENT; i++) {
      const r = await http(t).post(createPath(conversationId, aliceId), {
        message: `slot ${i}`,
        spec: { kind: 'once', delay_seconds: 60 + i },
      });
      expect(r.status).toBe(200);
    }
    const overflow = await http(t).post(createPath(conversationId, aliceId), {
      message: 'overflow',
      spec: { kind: 'once', delay_seconds: 60 },
    });
    expect(overflow.status).toBe(429);
    expect((await overflow.json() as any).code).toBe('too_many_active_schedules');
  });

  it('404 schedule_not_found', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(cancelPath(conversationId, aliceId), {
      schedule_id: 'does-not-exist',
    });
    expect(res.status).toBe(404);
    expect((await res.json() as any).code).toBe('schedule_not_found');
  });

  it('403 not_owner — bob cannot cancel alice\'s schedule', async () => {
    t = buildTestApp();
    const { conversationId, aliceId, bobId } = await setupTwoAgentChannel(t);
    const created = await (
      await http(t).post(createPath(conversationId, aliceId), {
        message: 'alice-only',
        spec: { kind: 'once', delay_seconds: 60 },
      })
    ).json() as { schedule: ScheduleDto };
    const res = await http(t).post(cancelPath(conversationId, bobId), {
      schedule_id: created.schedule.id,
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe('not_owner');
  });

  it('409 not_cancellable — already cancelled is terminal', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const created = await (
      await http(t).post(createPath(conversationId, aliceId), {
        message: 'twice',
        spec: { kind: 'once', delay_seconds: 60 },
      })
    ).json() as { schedule: ScheduleDto };
    const first = await http(t).post(cancelPath(conversationId, aliceId), {
      schedule_id: created.schedule.id,
    });
    expect(first.status).toBe(200);
    const again = await http(t).post(cancelPath(conversationId, aliceId), {
      schedule_id: created.schedule.id,
    });
    expect(again.status).toBe(409);
    expect((await again.json() as any).code).toBe('not_cancellable');
  });

  it('404 agent_home_not_found — agent without dm_channel cannot schedule', async () => {
    // We can't easily construct an agent without an agent_home through
    // the public API (POST /api/agents always provisions one). Instead,
    // delete the dm_channel directly from the DB to simulate the
    // missing-home invariant the route guards against.
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    // Drop the agent_home dm_channel rows for alice. CASCADE on
    // workspace deletion would also work, but that detaches alice from
    // the principal's source conversation too — so we drop just the
    // dm_channel and the agent_home workspace itself.
    t.ctx.db
      .prepare(
        `DELETE FROM conversations
          WHERE workspace_id IN (
            SELECT id FROM workspaces
             WHERE workspace_kind = 'agent_home' AND owner_agent_id = ?
          )`,
      )
      .run(aliceId);
    t.ctx.db
      .prepare(
        `DELETE FROM workspaces WHERE workspace_kind = 'agent_home' AND owner_agent_id = ?`,
      )
      .run(aliceId);
    const res = await http(t).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'once', delay_seconds: 60 },
    });
    expect(res.status).toBe(404);
    expect((await res.json() as any).code).toBe('agent_home_not_found');
  });

  // ── Auth / membership boundary ───────────────────────────────────

  it('rejects unknown agent on the principal route (404)', async () => {
    t = buildTestApp();
    const { conversationId } = await setupTwoAgentChannel(t);
    const res = await http(t).post(createPath(conversationId, 'no-such-agent'), {
      message: 'x',
      spec: { kind: 'once', delay_seconds: 60 },
    });
    expect(res.status).toBe(404);
  });

  it('rejects an agent that is not a member of the principal conversation (403)', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    // Provision a third agent that is NOT a member of the chosen
    // principal conversation. The internal middleware rejects before
    // the route ever runs.
    const stranger = await (
      await http(t).post('/api/agents', { name: 'carol', runtime: 'claude' })
    ).json() as any;
    const carolId = stranger.agent.id as string;
    expect(carolId).not.toBe(aliceId);
    const res = await http(t).post(createPath(conversationId, carolId), {
      message: 'x',
      spec: { kind: 'once', delay_seconds: 60 },
    });
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests (401)', async () => {
    t = buildTestApp();
    const { conversationId, aliceId } = await setupTwoAgentChannel(t);
    const res = await http(t.app).post(createPath(conversationId, aliceId), {
      message: 'x',
      spec: { kind: 'once', delay_seconds: 60 },
    });
    expect(res.status).toBe(401);
  });
});
