// P0-g (#task:2018) — global task identity resolver, phase 1 (conversation
// frame): the `task_id` selector on detail (narrow ambient-board read), the
// uniform indistinguishable rejection, the per-task participation ACL on the
// agent read faces (B1 leak fix), and the by-id mutation fold.
//
// Contract under test (agent-scoped-session-v1 §4.4/§4.5 + task body):
//  - TaskAccessPolicy = participation in the task's OWN conversation
//    (placement-aware; public discovery grants NO task read) ∧ the verb's
//    capability. Board/workspace equality is a coordinate, never an ACL.
//  - By-id detail for a conversation-frame caller dereferences ONLY on its
//    ambient WorkspaceBoard; unknown / non-participant / public-nonmember /
//    capability-missing / foreign-board ids are BYTE-IDENTICAL rejections.
//  - By-id mutations are the AgentSlot lane (P1): a conversation-frame caller
//    gets the same uniform task_not_found for every one of them.
//  - By-number addressing and its typed board errors are untouched.
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { AGENT_CAPABILITIES } from '@silverhand/shared';

interface Setup {
  workspaceId: string;
  onboardingId: string;
  agentIds: Record<string, string>;
}

async function setup(t: TestApp, workspaceName = 'eng'): Promise<Setup> {
  const h = http(t);
  const agentIds: Record<string, string> = {};
  for (const name of ['alice', 'bob']) {
    const r = (await (await h.post('/api/agents', { name: `${name}-${workspaceName}`, runtime: 'claude' })).json()) as any;
    agentIds[name] = r.agent.id;
  }
  const ws = (await (
    await h.post('/api/workspaces', {
      name: workspaceName,
      member_agent_ids: Object.values(agentIds),
    })
  ).json()) as any;
  return { workspaceId: ws.workspace.id, onboardingId: ws.onboarding_channel_id, agentIds };
}

/** A channel in `workspaceId` whose agent roster is exactly `memberAgentIds`. */
async function channel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const h = http(t);
  const r = (await (
    await h.post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json()) as any;
  return r.channel.id as string;
}

async function createTask(
  t: TestApp,
  conversationId: string,
  agentId: string,
  title: string,
): Promise<{ id: string; task_number: number }> {
  const h = http(t);
  const r = (await (
    await h.post(`/internal/conversations/${conversationId}/agents/${agentId}/tasks/create`, {
      tasks: [{ title }],
    })
  ).json()) as any;
  expect(r.tasks, `create ${title}`).toHaveLength(1);
  return r.tasks[0];
}

/** Full observable rejection surface of a detail read: HTTP status + body. */
async function detailById(
  t: TestApp,
  conversationId: string,
  agentId: string,
  taskId: string,
): Promise<{ status: number; body: unknown }> {
  const h = http(t);
  const res = await h.get(
    `/internal/conversations/${conversationId}/agents/${agentId}/tasks/detail?task_id=${encodeURIComponent(taskId)}`,
  );
  return { status: res.status, body: await res.json() };
}

describe('P0-g task identity (#task:2018) — phase 1, conversation frame', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('detail --id succeeds on the ambient board and equals the by-number read field-for-field', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const chA = await channel(t, workspaceId, 'alpha', [agentIds.alice!]);
    const created = await createTask(t, chA, agentIds.alice!, 'by-id read me');

    const h = http(t);
    const byId = await detailById(t, chA, agentIds.alice!, created.id);
    expect(byId.status).toBe(200);
    const byNumber = (await (
      await h.get(
        `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/detail?task_number=${created.task_number}`,
      )
    ).json()) as any;
    // Same task through both coordinate systems — byte-for-byte.
    expect(byId.body).toEqual(byNumber);
    expect((byId.body as any).task.id).toBe(created.id);
    // The row self-carries its full coordinates, including the derived board.
    expect((byId.body as any).task.board).toMatchObject({
      kind: 'workspace',
      workspace_id: workspaceId,
    });
    expect((byId.body as any).task.task_number).toBe(created.task_number);
  });

  it('same id resolves to the same task from two different conversation frames on one board', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const chA = await channel(t, workspaceId, 'alpha', [agentIds.alice!]);
    const chB = await channel(t, workspaceId, 'beta', [agentIds.alice!]);
    const created = await createTask(t, chA, agentIds.alice!, 'stable identity');

    const fromA = await detailById(t, chA, agentIds.alice!, created.id);
    const fromB = await detailById(t, chB, agentIds.alice!, created.id);
    expect(fromA.status).toBe(200);
    expect(fromB.status).toBe(200);
    expect((fromA.body as any).task.id).toBe(created.id);
    // Identical task through both frames (viewer + board identical here).
    expect(fromB.body).toEqual(fromA.body);
  });

  it('equal local numbers on two boards never cross-resolve; the id is exact', async () => {
    t = buildTestApp();
    const s1 = await setup(t, 'eng');
    const s2 = await setup(t, 'ops');
    const ch1 = await channel(t, s1.workspaceId, 'one', [s1.agentIds.alice!]);
    const ch2 = await channel(t, s2.workspaceId, 'two', [s2.agentIds.alice!]);
    const t1 = await createTask(t, ch1, s1.agentIds.alice!, 'eng #1');
    const t2 = await createTask(t, ch2, s2.agentIds.alice!, 'ops #1');
    // Same local number, two boards.
    expect(t1.task_number).toBe(1);
    expect(t2.task_number).toBe(1);
    expect(t1.id).not.toBe(t2.id);

    const d1 = await detailById(t, ch1, s1.agentIds.alice!, t1.id);
    expect((d1.body as any).task.title).toBe('eng #1');
    // By-number resolution stays board-scoped: #1 in ch1's frame is eng's #1.
    const h = http(t);
    const n1 = (await (
      await h.get(
        `/internal/conversations/${ch1}/agents/${s1.agentIds.alice}/tasks/detail?task_number=1`,
      )
    ).json()) as any;
    expect(n1.task.id).toBe(t1.id);
  });

  it('BYTE-IDENTICAL rejection across the five by-id failure modes (detail)', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    // alice's own frame conversation (participant, full caps).
    const chAlice = await channel(t, workspaceId, 'alice-only', [agentIds.alice!]);
    // (b) private conversation on the SAME board, alice NOT a participant.
    const chBobPrivate = await channel(t, workspaceId, 'bob-private', [agentIds.bob!]);
    const privateTask = await createTask(t, chBobPrivate, agentIds.bob!, 'private work');
    // (c) PUBLIC conversation on the same board, alice still not a participant —
    // public discovery grants no task read (participation-only ACL).
    const chBobPublic = await channel(t, workspaceId, 'bob-public', [agentIds.bob!]);
    await h.patch(`/api/channels/${chBobPublic}`, { visibility: 'public' });
    const publicTask = await createTask(t, chBobPublic, agentIds.bob!, 'public work');
    // (e) foreign board: another workspace alice IS a member of, full caps,
    // and even a conversation she participates in — the ambient-board rule
    // alone must fold it.
    const s2 = await setup(t, 'ops');
    const chForeign = await channel(t, s2.workspaceId, 'foreign', [s2.agentIds.alice!]);
    const foreignTask = await createTask(t, chForeign, s2.agentIds.alice!, 'foreign board');
    // (d) capability: alice participates in chCap's conversation on her own
    // board, but read_tasks is revoked in the workspace.
    const wsCap = await setup(t, 'cap');
    const chCap = await channel(t, wsCap.workspaceId, 'cap-chan', [wsCap.agentIds.alice!]);
    const capTask = await createTask(t, chCap, wsCap.agentIds.alice!, 'cap work');
    new AgentCapabilityRepo(t.ctx.db).replaceSet(
      wsCap.workspaceId,
      wsCap.agentIds.alice!,
      AGENT_CAPABILITIES.filter(cap => cap !== 'read_tasks'),
    );

    const rejections = [
      // (a) an id that names nothing.
      await detailById(t, chAlice, agentIds.alice!, 'zzzzzzzzzzzzzzzz'),
      // (b) same board, private conversation, not a participant.
      await detailById(t, chAlice, agentIds.alice!, privateTask.id),
      // (c) same board, PUBLIC conversation, not a participant.
      await detailById(t, chAlice, agentIds.alice!, publicTask.id),
      // (d) participant but read_tasks revoked (from the cap workspace frame).
      await detailById(t, chCap, wsCap.agentIds.alice!, capTask.id),
      // (e) another workspace's board (participant + caps there, wrong frame).
      await detailById(t, chAlice, agentIds.alice!, foreignTask.id),
    ];
    for (const r of rejections) {
      // Every arm serializes exactly like a by-number miss: 404 not_found.
      expect(r.status).toBe(404);
    }
    const canonical = JSON.stringify(rejections[0]!.body);
    for (const r of rejections.slice(1)) {
      expect(JSON.stringify(r.body)).toBe(canonical);
    }
    // …and the shape is the SAME one a by-number miss produces.
    const numberMiss = await h.get(
      `/internal/conversations/${chAlice}/agents/${agentIds.alice}/tasks/detail?task_number=999`,
    );
    expect(numberMiss.status).toBe(404);
    expect(JSON.stringify(await numberMiss.json())).toBe(canonical);
  });

  it('participation also gates the by-number read faces (B1): same-board private and public tasks are invisible to a non-participant', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const chAlice = await channel(t, workspaceId, 'mine', [agentIds.alice!]);
    const chBobPrivate = await channel(t, workspaceId, 'their-private', [agentIds.bob!]);
    const chBobPublic = await channel(t, workspaceId, 'their-public', [agentIds.bob!]);
    await h.patch(`/api/channels/${chBobPublic}`, { visibility: 'public' });
    const mine = await createTask(t, chAlice, agentIds.alice!, 'mine');
    const theirPrivate = await createTask(t, chBobPrivate, agentIds.bob!, 'their private');
    const theirPublic = await createTask(t, chBobPublic, agentIds.bob!, 'their public');

    // list: only the participant rows; every row self-carries coordinates.
    const listed = (await (
      await h.get(`/internal/conversations/${chAlice}/agents/${agentIds.alice}/tasks`)
    ).json()) as any;
    const ids = listed.tasks.map((row: any) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirPrivate.id);
    expect(ids).not.toContain(theirPublic.id);
    for (const row of listed.tasks) {
      expect(row.board).toMatchObject({ kind: 'workspace', workspace_id: workspaceId });
      expect(typeof row.id).toBe('string');
      expect(typeof row.task_number).toBe('number');
      expect(row.channel_id).toBeTruthy();
    }
    // bob still sees his own rows (the narrowing is per-viewer, not global).
    const bobListed = (await (
      await h.get(`/internal/conversations/${chBobPrivate}/agents/${agentIds.bob}/tasks`)
    ).json()) as any;
    expect(bobListed.tasks.map((row: any) => row.id)).toContain(theirPrivate.id);

    // by-number detail folds the same way (coordinate is right, ACL is not).
    const detailPrivate = await h.get(
      `/internal/conversations/${chAlice}/agents/${agentIds.alice}/tasks/detail?task_number=${theirPrivate.task_number}`,
    );
    expect(detailPrivate.status).toBe(404);
    // …while a filtered list narrows and never widens.
    const filtered = (await (
      await h.get(
        `/internal/conversations/${chAlice}/agents/${agentIds.alice}/tasks?conversation_id=${chBobPrivate}`,
      )
    ).json()) as any;
    expect(filtered.tasks).toHaveLength(0);
  });

  it('every by-id mutation folds to ONE uniform task_not_found for a conversation-frame caller — visible id and unknown id alike', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const chA = await channel(t, workspaceId, 'work', [agentIds.alice!]);
    // A task alice can SEE (participant + caps) — by-id mutation must still fold.
    const visible = await createTask(t, chA, agentIds.alice!, 'visible');
    const unknown = 'zzzzzzzzzzzzzzzz';

    // claim (batch): entries echo the caller's own id, nothing else differs.
    const claim = (await (
      await h.post(`/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/claim`, {
        task_ids: [visible.id, unknown],
      })
    ).json()) as any;
    expect(claim.results).toHaveLength(2);
    for (const [i, id] of [visible.id, unknown].entries()) {
      expect(claim.results[i]).toEqual({
        success: false,
        code: 'task_not_found',
        reason: 'task not found',
        id,
      });
    }

    // unclaim / update-status / edit: byte-identical envelopes for both ids.
    for (const body of [
      { path: 'unclaim', payload: (id: string) => ({ task_id: id }) },
      { path: 'update-status', payload: (id: string) => ({ task_id: id, status: 'in_progress' }) },
      { path: 'edit', payload: (id: string) => ({ task_id: id, title: 'renamed' }) },
    ] as const) {
      const forVisible = (await (
        await h.post(
          `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/${body.path}`,
          body.payload(visible.id),
        )
      ).json()) as any;
      const forUnknown = (await (
        await h.post(
          `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/${body.path}`,
          body.payload(unknown),
        )
      ).json()) as any;
      expect(forVisible, `${body.path} visible-id fold`).toEqual({
        success: false,
        code: 'task_not_found',
        reason: 'task not found',
      });
      expect(forUnknown, `${body.path} unknown-id fold`).toEqual(forVisible);
    }
    // The folded task is untouched: still readable, still todo, unassigned,
    // original title.
    const after = await detailById(t, chA, agentIds.alice!, visible.id);
    expect((after.body as any).task.status).toBe('todo');
    expect((after.body as any).task.assignee).toBeNull();
    expect((after.body as any).task.title).toBe('visible');
  });

  it('by-number mutations keep their typed board errors — the id lane changes nothing there', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const chA = await channel(t, workspaceId, 'typed', [agentIds.alice!]);
    await createTask(t, chA, agentIds.alice!, 'anchor');

    // Unknown workspace still names ITS OWN coordinate failure (typed) —
    // the caller addressed a board, not a task.
    const unknownWs = (await (
      await h.post(`/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/claim`, {
        task_numbers: [1],
        workspace_id: 'no-such-workspace',
      })
    ).json()) as any;
    expect(unknownWs.results[0].code).toBe('unknown_workspace');
  });

  it('wire XOR: task_number+task_id together, both absent, and selector-with-id are schema 400s', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const chA = await channel(t, workspaceId, 'xor', [agentIds.alice!]);

    // detail: both selectors → 400.
    const both = await h.get(
      `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/detail?task_number=1&task_id=abc`,
    );
    expect(both.status).toBe(400);
    // detail: id + workspace selector → 400.
    const withWs = await h.get(
      `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/detail?task_id=abc&workspace_id=${workspaceId}`,
    );
    expect(withWs.status).toBe(400);

    for (const [path, base] of [
      ['unclaim', {}],
      ['update-status', { status: 'in_progress' }],
      ['edit', { title: 'x' }],
    ] as const) {
      const bothBody = await h.post(
        `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/${path}`,
        { ...base, task_number: 1, task_id: 'abc' },
      );
      expect(bothBody.status, `${path} both`).toBe(400);
      const neither = await h.post(
        `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/${path}`,
        { ...base },
      );
      expect(neither.status, `${path} neither`).toBe(400);
      const idPlusSelector = await h.post(
        `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/${path}`,
        { ...base, task_id: 'abc', workspace_id: workspaceId },
      );
      expect(idPlusSelector.status, `${path} id+selector`).toBe(400);
    }
    // claim: mixed batch and id+selector are 400s.
    const mixed = await h.post(
      `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/claim`,
      { task_numbers: [1], task_ids: ['abc'] },
    );
    expect(mixed.status).toBe(400);
    const claimIdSelector = await h.post(
      `/internal/conversations/${chA}/agents/${agentIds.alice}/tasks/claim`,
      { task_ids: ['abc'], workspace_id: workspaceId },
    );
    expect(claimIdSelector.status).toBe(400);
  });

  it('agent_home owner arm: the implicit capability grants by-id detail on the home board', async () => {
    t = buildTestApp();
    const h = http(t);
    const agent = (await (
      await h.post('/api/agents', { name: 'homer', runtime: 'claude' })
    ).json()) as any;
    const agentId = agent.agent.id as string;
    // The agent's home workspace has NO capability rows (implicit owner
    // authority); the create response carries its home DM conversation.
    const homeConversationId = agent.dm_channel_id as string;
    expect(homeConversationId, 'home conversation discoverable').toBeTruthy();
    const created = await createTask(t, homeConversationId!, agentId, 'home task');
    const read = await detailById(t, homeConversationId!, agentId, created.id);
    expect(read.status).toBe(200);
    expect((read.body as any).task.id).toBe(created.id);
  });
});

describe('P0-g B2 — participation gates the WRITE face too (#task:2018 review round 1)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('all four by-number mutations fold to the miss envelope for a non-participant, with zero writes and zero events', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const chAlice = await channel(t, workspaceId, 'alice-only', [agentIds.alice!]);
    const chBobPrivate = await channel(t, workspaceId, 'bob-private', [agentIds.bob!]);
    const chBobPublic = await channel(t, workspaceId, 'bob-public', [agentIds.bob!]);
    await h.patch(`/api/channels/${chBobPublic}`, { visibility: 'public' });
    const privateTask = await createTask(t, chBobPrivate, agentIds.bob!, 'private write target');
    const publicTask = await createTask(t, chBobPublic, agentIds.bob!, 'public write target');

    const messageCount = async (conversationId: string): Promise<number> => {
      const r = (await (await h.get(`/api/channels/${conversationId}/messages`)).json()) as any;
      return r.messages.length;
    };
    const beforePrivate = await messageCount(chBobPrivate);
    const beforePublic = await messageCount(chBobPublic);

    const agentBase = `/internal/conversations/${chAlice}/agents/${agentIds.alice}/tasks`;
    const missEnvelope = async (path: string, payload: (n: number) => unknown): Promise<string> => {
      const res = (await (await h.post(`${agentBase}/${path}`, payload(999))).json()) as any;
      return JSON.stringify(path === 'claim' ? res.results[0] : res);
    };
    const normalize = (s: string, from: number): string =>
      s.replace(`"task_number":${from}`, '"task_number":999');

    // Per verb: the non-participant rejection for a KNOWN number must equal
    // the miss envelope byte-for-byte (modulo the echoed caller-supplied
    // number), for BOTH the private and the PUBLIC conversation's task.
    for (const target of [privateTask, publicTask]) {
      const claimMiss = await missEnvelope('claim', n => ({ task_numbers: [n] }));
      const claim = (await (
        await h.post(`${agentBase}/claim`, { task_numbers: [target.task_number] })
      ).json()) as any;
      expect(normalize(JSON.stringify(claim.results[0]), target.task_number)).toBe(claimMiss);

      const unclaimMiss = await missEnvelope('unclaim', n => ({ task_number: n }));
      const unclaim = (await (
        await h.post(`${agentBase}/unclaim`, { task_number: target.task_number })
      ).json()) as any;
      expect(JSON.stringify(unclaim)).toBe(unclaimMiss);

      const statusMiss = await missEnvelope('update-status', n => ({
        task_number: n,
        status: 'in_progress',
      }));
      const status = (await (
        await h.post(`${agentBase}/update-status`, {
          task_number: target.task_number,
          status: 'in_progress',
        })
      ).json()) as any;
      expect(JSON.stringify(status)).toBe(statusMiss);

      const editMiss = await missEnvelope('edit', n => ({ task_number: n, title: 'hijack' }));
      const edit = (await (
        await h.post(`${agentBase}/edit`, { task_number: target.task_number, title: 'hijack' })
      ).json()) as any;
      expect(JSON.stringify(edit)).toBe(editMiss);
    }

    // Zero writes: both tasks unchanged from the PARTICIPANT's view.
    for (const [conv, task, title] of [
      [chBobPrivate, privateTask, 'private write target'],
      [chBobPublic, publicTask, 'public write target'],
    ] as const) {
      const seen = (await (
        await h.get(
          `/internal/conversations/${conv}/agents/${agentIds.bob}/tasks/detail?task_number=${task.task_number}`,
        )
      ).json()) as any;
      expect(seen.task.status).toBe('todo');
      expect(seen.task.assignee).toBeNull();
      expect(seen.task.title).toBe(title);
    }
    // Zero system events / broadcast anchors: message counts unchanged.
    expect(await messageCount(chBobPrivate)).toBe(beforePrivate);
    expect(await messageCount(chBobPublic)).toBe(beforePublic);

    // Participant control: bob claims his own task by the same number.
    const bobClaim = (await (
      await h.post(`/internal/conversations/${chBobPrivate}/agents/${agentIds.bob}/tasks/claim`, {
        task_numbers: [privateTask.task_number],
      })
    ).json()) as any;
    expect(bobClaim.results[0].success).toBe(true);
  });
});
