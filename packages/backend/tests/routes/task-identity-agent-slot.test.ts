// P0-g (#task:2018) phase 2 — the AGENT-SLOT lane on the merged P1
// (#task:2015) principal union, plus the two-scope coexistence falsifiers.
//
// Contract (task body 裁定 4, Cindy 2026-08-14 终裁):
//  - agent slot: by-id detail/claim/status/edit/unclaim reach ANY board the
//    TaskAccessPolicy admits (participation ∧ verb capability), and the
//    no-filter list is the UNION of every readable board;
//  - conversation slot: detail --id stays ambient-board-only, every by-id
//    mutation folds to the uniform task_not_found, default list stays the
//    ambient workspace — unchanged by an agent slot operating in the SAME
//    conversation;
//  - P1 custody applies to the task routes: a stale agent-slot bearer is 401.
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import {
  agentSlotAuth,
  canonicalTasksPath,
  insertAgentScopedAgent,
} from '../utils/agent-scope.js';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { AGENT_CAPABILITIES } from '@silverhand/shared';

interface Board {
  workspaceId: string;
  channelId: string;
}

/** One workspace with the given members and one channel containing exactly
 *  those members. */
async function board(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<Board> {
  const h = http(t);
  const ws = (await (
    await h.post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  const ch = (await (
    await h.post(`/api/workspaces/${ws.workspace.id}/channels`, {
      title: `${name}-chan`,
      member_agent_ids: memberAgentIds,
    })
  ).json()) as any;
  return { workspaceId: ws.workspace.id, channelId: ch.channel.id };
}

async function createTask(
  t: TestApp,
  conversationId: string,
  agentId: string,
  title: string,
  headers?: Record<string, string>,
): Promise<{ id: string; task_number: number }> {
  const h = http(t);
  const r = (await (
    await h.post(
      `/internal/agents/${agentId}/tasks/create`,
      { target: `#conv:${conversationId}`, tasks: [{ title }] },
      headers ? { headers } : undefined,
    )
  ).json()) as any;
  expect(r.tasks, `create ${title}`).toHaveLength(1);
  return r.tasks[0];
}

describe('P0-g agent-slot lane + two-scope coexistence (#task:2018 phase 2)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function fixture(): Promise<{
    twin: string;
    seedAgent: string;
    w1: Board;
    w2: Board;
    auth: { authorization: string };
  }> {
    const h = http(t!);
    const seed = (await (
      await h.post('/api/agents', { name: 'seed', runtime: 'claude' })
    ).json()) as any;
    const seedAgent = seed.agent.id as string;
    const twin = insertAgentScopedAgent(t!, seedAgent, 'twin-agent-scoped');
    const w1 = await board(t!, 'w-one', [seedAgent, twin]);
    const w2 = await board(t!, 'w-two', [twin]);
    return { twin, seedAgent, w1, w2, auth: agentSlotAuth(t!, twin) };
  }

  it('agent slot: every by-id verb reaches a task on ANOTHER workspace board (frame ≠ task board)', async () => {
    t = buildTestApp();
    const { twin, w1, w2, auth } = await fixture();
    const h = http(t);
    // The task lives on w2's board; every call below is framed on w1's channel.
    const task = await createTask(t, w2.channelId, twin, 'cross-board work', auth);
    const frame = (suffix: string) => canonicalTasksPath(twin, w1.channelId, suffix);

    const detail = await h.get(frame(`/detail?task_id=${task.id}`), { headers: auth });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as any;
    expect(detailBody.task.id).toBe(task.id);
    expect(detailBody.task.channel_id).toBe(w2.channelId);
    expect(detailBody.task.board).toMatchObject({
      kind: 'workspace',
      workspace_id: w2.workspaceId,
    });

    const claim = (await (
      await h.post(frame('/claim'), { task_ids: [task.id] }, { headers: auth })
    ).json()) as any;
    expect(claim.results[0]).toMatchObject({ success: true, id: task.id });

    const status = (await (
      await h.post(frame('/update-status'), { task_id: task.id, status: 'in_review' }, { headers: auth })
    ).json()) as any;
    expect(status).toMatchObject({ success: true });

    const edit = (await (
      await h.post(frame('/edit'), { task_id: task.id, title: 'renamed cross-board' }, { headers: auth })
    ).json()) as any;
    expect(edit).toMatchObject({ success: true });
    expect(edit.task.title).toBe('renamed cross-board');
    expect(edit.task.id).toBe(task.id);

    const unclaim = (await (
      await h.post(frame('/unclaim'), { task_id: task.id }, { headers: auth })
    ).json()) as any;
    expect(unclaim).toMatchObject({ success: true });
  });

  it('agent slot: post-gate workflow failures stay TYPED once the policy admits the caller', async () => {
    t = buildTestApp();
    const { twin, seedAgent, w1, auth } = await fixture();
    const h = http(t);
    const task = await createTask(t, w1.channelId, twin, 'taken', auth);
    // seed claims it first (by number, conversation frame).
    const seedClaim = (await (
      await h.post(canonicalTasksPath(seedAgent, w1.channelId, '/claim'), {
        task_numbers: [task.task_number],
      })
    ).json()) as any;
    expect(seedClaim.results[0].success).toBe(true);
    // The agent slot CAN see the task (participant + caps) — the by-id claim
    // failure is the typed already_claimed, NOT the indistinguishable fold.
    const claim = (await (
      await h.post(canonicalTasksPath(twin, w1.channelId, '/claim'), { task_ids: [task.id] }, { headers: auth })
    ).json()) as any;
    expect(claim.results[0].code).toBe('already_claimed');
  });

  it('agent slot: by-id rejections stay BYTE-IDENTICAL across unknown / non-participant / foreign-membership ids', async () => {
    t = buildTestApp();
    const { twin, seedAgent, w1, auth } = await fixture();
    const h = http(t);
    // A private conversation on w1's board WITHOUT the twin.
    const chPrivate = (await (
      await h.post(`/api/workspaces/${w1.workspaceId}/channels`, {
        title: 'no-twin',
        member_agent_ids: [seedAgent],
      })
    ).json()) as any;
    const hidden = await createTask(t, chPrivate.channel.id, seedAgent, 'hidden');
    // A workspace the twin is NOT a member of at all.
    const foreign = await board(t, 'w-foreign', [seedAgent]);
    const foreignTask = await createTask(t, foreign.channelId, seedAgent, 'foreign');

    const frame = (suffix: string) => canonicalTasksPath(twin, w1.channelId, suffix);
    const rejections = [] as Array<{ status: number; body: unknown }>;
    for (const id of ['zzzzzzzzzzzzzzzz', hidden.id, foreignTask.id]) {
      const res = await h.get(frame(`/detail?task_id=${encodeURIComponent(id)}`), { headers: auth });
      rejections.push({ status: res.status, body: await res.json() });
    }
    for (const r of rejections) expect(r.status).toBe(404);
    const canonical = JSON.stringify(rejections[0]!.body);
    for (const r of rejections.slice(1)) expect(JSON.stringify(r.body)).toBe(canonical);

    // Mutations: same three ids, one envelope per verb (id echo aside).
    for (const id of ['zzzzzzzzzzzzzzzz', hidden.id, foreignTask.id]) {
      const claim = (await (
        await h.post(frame('/claim'), { task_ids: [id] }, { headers: auth })
      ).json()) as any;
      expect(claim.results[0]).toEqual({
        success: false,
        code: 'task_not_found',
        reason: 'task not found',
        id,
      });
      const unclaim = (await (
        await h.post(frame('/unclaim'), { task_id: id }, { headers: auth })
      ).json()) as any;
      expect(unclaim).toEqual({ success: false, code: 'task_not_found', reason: 'task not found' });
    }
  });

  it('agent slot: no-filter list is the union of every readable board; filters only narrow; a no-read_tasks board drops out', async () => {
    t = buildTestApp();
    const { twin, seedAgent, w1, w2, auth } = await fixture();
    const h = http(t);
    const t1 = await createTask(t, w1.channelId, twin, 'on w1', auth);
    const t2 = await createTask(t, w2.channelId, twin, 'on w2', auth);
    // A third board where the twin is a member but read_tasks is revoked.
    const w3 = await board(t, 'w-three', [seedAgent, twin]);
    const t3 = await createTask(t, w3.channelId, seedAgent, 'unreadable');
    new AgentCapabilityRepo(t.ctx.db).replaceSet(
      w3.workspaceId,
      twin,
      AGENT_CAPABILITIES.filter(cap => cap !== 'read_tasks'),
    );

    const frame = (suffix: string) => canonicalTasksPath(twin, w1.channelId, suffix);
    const union = (await (await h.get(frame(''), { headers: auth })).json()) as any;
    const ids = union.tasks.map((row: any) => row.id);
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
    expect(ids).not.toContain(t3.id);
    for (const row of union.tasks) {
      expect(row.board.kind).toBe('workspace');
      expect(typeof row.board.workspace_id).toBe('string');
      expect(typeof row.task_number).toBe('number');
      expect(row.channel_id).toBeTruthy();
    }
    // Explicit workspace filter narrows to a subset of the union.
    const narrowed = (await (
      await h.get(frame(`?workspace_id=${w2.workspaceId}`), { headers: auth })
    ).json()) as any;
    const narrowedIds = narrowed.tasks.map((row: any) => row.id);
    expect(narrowedIds).toContain(t2.id);
    expect(narrowedIds).not.toContain(t1.id);
    for (const id of narrowedIds) expect(ids).toContain(id);
  });

  it('coexistence: a conversation slot in the SAME conversation keeps the frozen contract while the agent slot works', async () => {
    t = buildTestApp();
    const { twin, seedAgent, w1, w2, auth } = await fixture();
    const h = http(t);
    const crossBoard = await createTask(t, w2.channelId, twin, 'agent-slot only', auth);
    const local = await createTask(t, w1.channelId, seedAgent, 'local work');

    // Conversation slot (seed agent, legacy auto-token): default list stays the
    // ambient workspace — w2's task never appears.
    const seedList = (await (
      await h.get(canonicalTasksPath(seedAgent, w1.channelId))
    ).json()) as any;
    const seedIds = seedList.tasks.map((row: any) => row.id);
    expect(seedIds).toContain(local.id);
    expect(seedIds).not.toContain(crossBoard.id);

    // Conversation slot: cross-workspace detail --id folds; ALL by-id
    // mutations fold — even against a task it could reach by number.
    const seedDetail = await h.get(
      canonicalTasksPath(seedAgent, w1.channelId, `/detail?task_id=${crossBoard.id}`),
    );
    expect(seedDetail.status).toBe(404);
    const seedClaim = (await (
      await h.post(canonicalTasksPath(seedAgent, w1.channelId, '/claim'), {
        task_ids: [local.id],
      })
    ).json()) as any;
    expect(seedClaim.results[0]).toEqual({
      success: false,
      code: 'task_not_found',
      reason: 'task not found',
      id: local.id,
    });
    // …while by-number keeps working for it.
    const seedByNumber = (await (
      await h.post(canonicalTasksPath(seedAgent, w1.channelId, '/claim'), {
        task_numbers: [local.task_number],
      })
    ).json()) as any;
    expect(seedByNumber.results[0].success).toBe(true);

    // Agent slot in the SAME conversation frame: cross-board by-id works.
    const twinDetail = await h.get(
      canonicalTasksPath(twin, w1.channelId, `/detail?task_id=${crossBoard.id}`),
      { headers: auth },
    );
    expect(twinDetail.status).toBe(200);

    // And the conversation slot's semantics did not drift while the agent
    // slot operated: same fold, same list population.
    const seedListAfter = (await (
      await h.get(canonicalTasksPath(seedAgent, w1.channelId))
    ).json()) as any;
    expect(seedListAfter.tasks.map((row: any) => row.id).sort()).toEqual(seedIds.sort());
  });

  it('P1 custody applies to the task lane: a stale agent-slot bearer is 401', async () => {
    t = buildTestApp();
    const { twin, w1, auth } = await fixture();
    const h = http(t);
    // Bump the generation — the previously issued bearer's custody is stale.
    t.persistence.repos.runtimeSlots.claimGeneration({
      scope: { kind: 'agent', agentId: twin },
      daemonInstanceId: 'successor-daemon',
    });
    const res = await h.get(canonicalTasksPath(twin, w1.channelId, ''), { headers: auth });
    expect(res.status).toBe(401);
  });

  it('a conversation-slot bearer on the CANONICAL route family still gets the conversation contract (route ≠ scope)', async () => {
    t = buildTestApp();
    const { twin, seedAgent, w1, w2, auth } = await fixture();
    const h = http(t);
    const local = await createTask(t, w1.channelId, seedAgent, 'route-neutral');
    const crossBoard = await createTask(t, w2.channelId, twin, 'unreachable', auth);

    // Same-board detail --id through the canonical mount: allowed.
    const ok = await h.get(
      canonicalTasksPath(seedAgent, w1.channelId, `/detail?task_id=${local.id}`),
    );
    expect(ok.status).toBe(200);
    // Cross-board detail --id: folds — the principal KIND decides, not the
    // route family. (seed is a member of w2? No — w2 is twin-only, so this is
    // both outside the ambient board AND outside membership; the fold is the
    // same either way.)
    const folded = await h.get(
      canonicalTasksPath(seedAgent, w1.channelId, `/detail?task_id=${crossBoard.id}`),
    );
    expect(folded.status).toBe(404);
  });
});

describe('P0-g B4 — the union orders by creation instant, not by local numbers (#task:2018 review round 1)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('a fresh #1 on board B outranks a stale #3 on board A; --limit 1 returns the newest task', async () => {
    t = buildTestApp();
    const h = http(t);
    const seed = (await (
      await h.post('/api/agents', { name: 'seed-order', runtime: 'claude' })
    ).json()) as any;
    const twin = insertAgentScopedAgent(t, seed.agent.id, 'twin-order');
    const w1 = await board(t, 'w-old', [twin]);
    const w2 = await board(t, 'w-new', [twin]);
    const auth = agentSlotAuth(t, twin);

    // Board A accumulates history first (higher local numbers, older rows).
    await createTask(t, w1.channelId, twin, 'old one', auth);
    await createTask(t, w1.channelId, twin, 'old two', auth);
    const oldest = await createTask(t, w1.channelId, twin, 'old three', auth);
    expect(oldest.task_number).toBeGreaterThan(1);
    // Ensure a strictly later creation instant on board B (ms clock).
    await new Promise(resolve => setTimeout(resolve, 5));
    const fresh = await createTask(t, w2.channelId, twin, 'fresh one', auth);
    expect(fresh.task_number).toBe(1);

    const frame = (suffix: string) => canonicalTasksPath(twin, w1.channelId, suffix);
    const limited = (await (
      await h.get(frame('?limit=1'), { headers: auth })
    ).json()) as any;
    expect(limited.tasks).toHaveLength(1);
    expect(limited.tasks[0].id).toBe(fresh.id);

    // Full union: newest-first by creation across boards, not by local number.
    const union = (await (await h.get(frame(''), { headers: auth })).json()) as any;
    expect(union.tasks[0].id).toBe(fresh.id);
    const ids = union.tasks.map((row: any) => row.id);
    expect(ids.indexOf(fresh.id)).toBeLessThan(ids.indexOf(oldest.id));
  });
});
