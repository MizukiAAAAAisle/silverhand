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
import { buildTestApp, conversationSlotAuth, http, type TestApp } from '../utils/app.js';
import {
  agentSlotAuth,
  canonicalTasksPath,
  insertAgentScopedAgent,
} from '../utils/agent-scope.js';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
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
    expect(detailBody.task.place).toMatchObject({
      kind: 'workspace',
      workspace_id: w2.workspaceId,
      conversation_id: w2.channelId,
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
      expect(row.place.kind).toBe('workspace');
      expect(typeof row.place.workspace_id).toBe('string');
      expect(typeof row.task_number).toBe('number');
      expect(row.place.conversation_id).toBeTruthy();
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

  it('agent-slot create narrates plain `created`, never "from another conversation": the cross_conversation bit is UNDEFINED for an AgentSlot (#task:2037 B6)', async () => {
    t = buildTestApp();
    const { twin, w1, auth } = await fixture();
    // An AgentSlot has NO origin conversation (`conversationId` is null), so the
    // cross_conversation comparison — "did this actor file against a stream
    // OTHER than the one it is anchored to?" — is UNDEFINED for it. Its correct
    // rendering is ABSENT: a plain `created` narration, never "here from another
    // conversation". This is the exact dogfood defect — an agent-scoped agent
    // files a task on a conversation it is a party to, and the old
    // `kind==='agent' && conversationId !== dest` test (always true when the
    // origin is null) made the system message CLAIM the task came from somewhere
    // else, which is a falsehood to the reader.
    const task = await createTask(t, w1.channelId, twin, 'filed as myself', auth);

    const sys = t.persistence.repos.messages
      .listForConversation(w1.channelId)
      .filter(m => m.from_kind === 'system')
      .at(-1)!;

    expect(sys.content).toMatch(
      new RegExp(` created task #${task.task_number} "filed as myself"$`),
    );
    expect(sys.content.includes('from another conversation')).toBe(false);
    expect(sys.metadata?.cross_conversation).toBeUndefined();
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

// #task:2150 — atomic `create --target <stream> --claim` from an AGENT-SLOT.
//
// The defect: the `cross_conversation_claim` guard keyed off the AUTH
// principal's nullable `conversationId`, which is `null` for EVERY agent slot
// (an agent-scoped runtime has no origin stream). So `--claim` from an
// agent-scoped runtime was ALWAYS misjudged as a cross-conversation dispatch
// and refused, even against a stream the agent is a party to. The fix keys the
// guard on the RUNTIME actor's scope (the same `crossConversation` predicate the
// service uses): the "cross" bit is DEFINED ONLY for `runtimeScope ===
// 'conversation'` (anchor vs destination); an agent slot has no anchor, so it
// falls through to the normal capability/participation gate.
//
// The authority the atomic path spends is exactly the UNION of the two-step
// "create (create_tasks) → by-id claim (write_tasks ∧ participation)" — never
// wider (Cindy's falsifier). Workspace boards gate create_tasks + write_tasks;
// a DirectPair board has no capability table, so participation IS the whole
// authority (the by-id claim reuses the same participation gate).
describe('agent-slot atomic create --claim: explicit target, null anchor is NOT cross (#task:2150)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /** System events on a conversation, via the repo face (no native SQL, so no
   *  db-boundary ledger row). The zero-write instrument for a refused create. */
  const systemEvents = (conversationId: string) =>
    t!.persistence.repos.messages
      .listForConversation(conversationId)
      .filter(m => m.from_kind === 'system');

  async function twinOnBoard(): Promise<{
    seedAgent: string;
    twin: string;
    w1: Board;
    auth: { authorization: string };
  }> {
    const h = http(t!);
    const seed = (await (
      await h.post('/api/agents', { name: 'seed', runtime: 'claude' })
    ).json()) as any;
    const seedAgent = seed.agent.id as string;
    const twin = insertAgentScopedAgent(t!, seedAgent, 'twin-agent-scoped');
    const w1 = await board(t!, 'w-one', [seedAgent, twin]);
    return { seedAgent, twin, w1, auth: agentSlotAuth(t!, twin) };
  }

  const readDetailById = async (
    twin: string,
    frameConv: string,
    taskId: string,
    auth: { authorization: string },
  ): Promise<any> => {
    const res = await http(t!).get(
      canonicalTasksPath(twin, frameConv, `/detail?task_id=${taskId}`),
      { headers: auth },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as any).task;
  };

  it('claims atomically on a workspace board it is a member of (in_progress, assignee=self, one create event that says "and claimed it")', async () => {
    t = buildTestApp();
    const { twin, w1, auth } = await twinOnBoard();
    const h = http(t);
    const before = systemEvents(w1.channelId).length;

    const res = await h.post(
      `/internal/agents/${twin}/tasks/create`,
      { target: `#conv:${w1.channelId}`, claim: true, tasks: [{ title: 'file-and-own' }] },
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.tasks).toHaveLength(1);

    const detail = await readDetailById(twin, w1.channelId, body.tasks[0].id, auth);
    expect(detail.status).toBe('in_progress');
    expect(detail.assignee).toMatchObject({ type: 'agent', id: twin });

    // Exactly ONE system event, and it is the claimed-variant narration — never
    // "from another conversation" (the null-anchor false positive this fixes).
    const added = systemEvents(w1.channelId).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.content).toMatch(
      new RegExp(` created task #${body.tasks[0].task_number} "file-and-own" and claimed it$`),
    );
    expect(added[0]!.content.includes('from another conversation')).toBe(false);
  });

  it('claims atomically on a DirectPair it is an endpoint of — participation is the whole authority (no workspace capability)', async () => {
    t = buildTestApp();
    const { twin, auth } = await twinOnBoard();
    const h = http(t);
    // A pair with no workspace, no roster, no capability rows; the twin is an
    // ENDPOINT, which is the entire authority the by-id claim would also spend.
    const pair = new ConversationRepo(t.ctx.db).getOrCreateDirectPair(
      { kind: 'agent', id: twin },
      { kind: 'human', id: 'local' },
      Date.now(),
    ).conversation;
    const before = systemEvents(pair.id).length;

    const res = await h.post(
      `/internal/agents/${twin}/tasks/create`,
      { target: `#conv:${pair.id}`, claim: true, tasks: [{ title: 'dm-own' }] },
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.tasks).toHaveLength(1);

    const detail = await readDetailById(twin, pair.id, body.tasks[0].id, auth);
    expect(detail.status).toBe('in_progress');
    expect(detail.assignee).toMatchObject({ type: 'agent', id: twin });
    const added = systemEvents(pair.id).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]!.content).toMatch(/ and claimed it$/);
  });

  it('ATOMIC ZERO-WRITE: missing write_tasks on the destination is capability_denied write_tasks, and NOTHING is written', async () => {
    t = buildTestApp();
    const { twin, w1, auth } = await twinOnBoard();
    const h = http(t);
    // create_tasks held, write_tasks revoked: the create half is authorized but
    // the self-claim is not, so the WHOLE atomic op must roll back.
    new AgentCapabilityRepo(t.ctx.db).replaceSet(
      w1.workspaceId,
      twin,
      AGENT_CAPABILITIES.filter(cap => cap !== 'write_tasks'),
    );
    const before = systemEvents(w1.channelId).length;

    const res = await h.post(
      `/internal/agents/${twin}/tasks/create`,
      { target: `#conv:${w1.channelId}`, claim: true, tasks: [{ title: 'claim-blocked' }] },
      { headers: auth },
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({
      code: 'capability_denied',
      capability: 'write_tasks',
    });
    // Zero event AND zero task row (the gate runs before createTasks).
    expect(systemEvents(w1.channelId).length - before).toBe(0);
    const union = (await (
      await h.get(canonicalTasksPath(twin, w1.channelId, ''), { headers: auth })
    ).json()) as any;
    expect(union.tasks.some((x: any) => x.title === 'claim-blocked')).toBe(false);
  });

  it('create authority is STILL required (not wider): missing create_tasks is capability_denied create_tasks with zero write', async () => {
    t = buildTestApp();
    const { twin, w1, auth } = await twinOnBoard();
    const h = http(t);
    new AgentCapabilityRepo(t.ctx.db).replaceSet(
      w1.workspaceId,
      twin,
      AGENT_CAPABILITIES.filter(cap => cap !== 'create_tasks'),
    );
    const before = systemEvents(w1.channelId).length;

    const res = await h.post(
      `/internal/agents/${twin}/tasks/create`,
      { target: `#conv:${w1.channelId}`, claim: true, tasks: [{ title: 'no-create' }] },
      { headers: auth },
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({
      code: 'capability_denied',
      capability: 'create_tasks',
    });
    expect(systemEvents(w1.channelId).length - before).toBe(0);
  });

  it('SCOPE DISCRIMINATOR: a conversation slot on a NON-anchor stream is STILL cross_conversation_claim — the fix reads runtime scope, not a nullable anchor', async () => {
    t = buildTestApp();
    const { seedAgent, twin, w1, auth } = await twinOnBoard();
    const h = http(t);
    // Second channel in the SAME workspace; the seed agent is a member of both,
    // so participation resolves — the ONLY thing that refuses the claim is the
    // conversation-slot anchor mismatch.
    const chB = (await (
      await h.post(`/api/workspaces/${w1.workspaceId}/channels`, {
        title: 'channel-b',
        member_agent_ids: [seedAgent, twin],
      })
    ).json()) as any;
    const convB = chB.channel.id;

    // (a) conversation slot anchored to w1.channel, targeting convB with --claim:
    // a genuine cross-anchor dispatch → refused, zero write. This is the branch
    // the fix must PRESERVE.
    const beforeB = systemEvents(convB).length;
    const seedAnchor = conversationSlotAuth(t, w1.channelId, seedAgent);
    const crossRes = await h.post(
      `/internal/agents/${seedAgent}/tasks/create`,
      { target: `#conv:${convB}`, claim: true, tasks: [{ title: 'seed-cross' }] },
      { headers: seedAnchor },
    );
    expect(crossRes.status).toBe(200);
    expect((await crossRes.json()) as any).toEqual({ error: 'cross_conversation_claim' });
    expect(systemEvents(convB).length - beforeB).toBe(0);

    // (b) the AGENT slot, same explicit convB target with --claim: NOT cross
    // (no anchor to differ from) → atomic claim succeeds. Same destination, same
    // capabilities, opposite verdict — driven purely by runtime scope.
    const agentRes = await h.post(
      `/internal/agents/${twin}/tasks/create`,
      { target: `#conv:${convB}`, claim: true, tasks: [{ title: 'twin-here' }] },
      { headers: auth },
    );
    expect(agentRes.status).toBe(200);
    const twinTask = (await agentRes.json()) as any;
    expect(twinTask.tasks).toHaveLength(1);
    const detail = await readDetailById(twin, convB, twinTask.tasks[0].id, auth);
    expect(detail.status).toBe('in_progress');
    expect(detail.assignee).toMatchObject({ type: 'agent', id: twin });
  });

  it('a conversation slot on its OWN anchor still claims atomically (no regression)', async () => {
    t = buildTestApp();
    const { seedAgent, w1 } = await twinOnBoard();
    const h = http(t);
    const anchor = conversationSlotAuth(t, w1.channelId, seedAgent);
    const res = await h.post(
      `/internal/agents/${seedAgent}/tasks/create`,
      { target: `#conv:${w1.channelId}`, claim: true, tasks: [{ title: 'seed-own-anchor' }] },
      { headers: anchor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.tasks).toHaveLength(1);
    const detail = await readDetailById(seedAgent, w1.channelId, body.tasks[0].id, anchor);
    expect(detail.status).toBe('in_progress');
    expect(detail.assignee).toMatchObject({ type: 'agent', id: seedAgent });
  });

  // The falsifier Cindy locked: the atomic path must ADMIT the self-claim on
  // exactly the same (principal, destination) authority as the two-step
  // "create → by-id claim", never a wider one. Equivalence is on the ADMIT
  // RESULT (was the claim allowed?), not on the error taxonomy — the by-id
  // agent-slot lane deliberately folds a capability miss into the
  // indistinguishable `task_not_found` (anti-oracle, §4.5), while the create
  // route, whose caller named the destination, answers a typed capability_denied.
  describe('differential: atomic create --claim ≡ create + by-id claim on the admit result', () => {
    it('ALLOW (full caps): both paths land an in_progress task assigned to self', async () => {
      t = buildTestApp();
      const { twin, w1, auth } = await twinOnBoard();
      const h = http(t);

      // Two-step: create unclaimed, then by-id claim.
      const twoStepCreate = (await (
        await h.post(
          `/internal/agents/${twin}/tasks/create`,
          { target: `#conv:${w1.channelId}`, tasks: [{ title: 'two-step' }] },
          { headers: auth },
        )
      ).json()) as any;
      const twoStepClaim = (await (
        await h.post(
          canonicalTasksPath(twin, w1.channelId, '/claim'),
          { task_ids: [twoStepCreate.tasks[0].id] },
          { headers: auth },
        )
      ).json()) as any;
      expect(twoStepClaim.results[0]).toMatchObject({ success: true });
      const twoStepDetail = await readDetailById(twin, w1.channelId, twoStepCreate.tasks[0].id, auth);

      // Atomic: create --claim.
      const atomicRes = await h.post(
        `/internal/agents/${twin}/tasks/create`,
        { target: `#conv:${w1.channelId}`, claim: true, tasks: [{ title: 'atomic' }] },
        { headers: auth },
      );
      expect(atomicRes.status).toBe(200);
      const atomic = (await atomicRes.json()) as any;
      const atomicDetail = await readDetailById(twin, w1.channelId, atomic.tasks[0].id, auth);

      // Same terminal admission: in_progress, self-assigned, in both paths.
      expect(atomicDetail.status).toBe(twoStepDetail.status);
      expect(atomicDetail.status).toBe('in_progress');
      expect(atomicDetail.assignee).toMatchObject({ type: 'agent', id: twin });
      expect(twoStepDetail.assignee).toMatchObject({ type: 'agent', id: twin });
    });

    it('DENY (no write_tasks): neither path leaves the task self-claimed; the atomic path additionally writes zero', async () => {
      t = buildTestApp();
      const { twin, w1, auth } = await twinOnBoard();
      const h = http(t);
      new AgentCapabilityRepo(t.ctx.db).replaceSet(
        w1.workspaceId,
        twin,
        AGENT_CAPABILITIES.filter(cap => cap !== 'write_tasks'),
      );

      // Two-step: create (create_tasks held) SUCCEEDS unclaimed; by-id claim is
      // REFUSED (folded to the indistinguishable task_not_found), so the task
      // stays todo / unassigned.
      const twoStepCreate = (await (
        await h.post(
          `/internal/agents/${twin}/tasks/create`,
          { target: `#conv:${w1.channelId}`, tasks: [{ title: 'two-step-deny' }] },
          { headers: auth },
        )
      ).json()) as any;
      expect(twoStepCreate.tasks).toHaveLength(1);
      const twoStepClaim = (await (
        await h.post(
          canonicalTasksPath(twin, w1.channelId, '/claim'),
          { task_ids: [twoStepCreate.tasks[0].id] },
          { headers: auth },
        )
      ).json()) as any;
      expect(twoStepClaim.results[0].success).toBe(false);
      const twoStepDetail = await readDetailById(twin, w1.channelId, twoStepCreate.tasks[0].id, auth);
      expect(twoStepDetail.status).toBe('todo');
      expect(twoStepDetail.assignee).toBeNull();

      // Atomic: create --claim is REFUSED and the create rolls back — no task.
      const before = systemEvents(w1.channelId).length;
      const atomicRes = await h.post(
        `/internal/agents/${twin}/tasks/create`,
        { target: `#conv:${w1.channelId}`, claim: true, tasks: [{ title: 'atomic-deny' }] },
        { headers: auth },
      );
      expect(atomicRes.status).toBe(403);
      expect(systemEvents(w1.channelId).length - before).toBe(0);
      const union = (await (
        await h.get(canonicalTasksPath(twin, w1.channelId, ''), { headers: auth })
      ).json()) as any;
      expect(union.tasks.some((x: any) => x.title === 'atomic-deny')).toBe(false);

      // Equivalence: on the same (principal, destination, caps), the self-claim
      // is admitted in NEITHER path.
    });
  });
});
