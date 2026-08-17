// P0-f (#task:2022) — DirectPairBoard end-to-end on the agent task routes.
//
// The fixture reaches a REAL pair conversation through the production
// aggregate (`getOrCreateDirectPair`), then exercises the full task surface
// with the pair conversation as the frame/destination — deliberately WITHOUT
// any `dm:@…` parsing (that is #task:2021's target authority; this ticket
// only consumes a resolved conversation/placement).
//
// Contract under test (task body 裁定 3–9 + Cindy's boundary rulings):
//  - a pair conversation IS a board: tasks number from 1 per pair, workspace
//    boards are untouched, and the inbox still has no board;
//  - ACL stays per task from the conversation: endpoint-ness is the whole
//    authority (no workspace, no roster, no capability rows), and a same-
//    workspace non-endpoint gets the indistinguishable rejection on every
//    face;
//  - the DTO branches: pair rows carry {kind:'direct_pair', pair_key} with
//    null workspace coordinates and NO display-string stand-ins;
//  - the AgentSlot union includes pair boards; the global id dereferences a
//    pair task from any frame the policy admits;
//  - tombstoned endpoints keep the projection total (identity-only DTO).
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  conversationSlotTestPath,
  http,
  type TestApp,
} from '../utils/app.js';
import {
  agentSlotAuth,
  canonicalTasksPath,
  insertAgentScopedAgent,
} from '../utils/agent-scope.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { createSqliteAgentTeardownPersistence } from '../../src/repos/agent-teardown-persistence.js';
import { TaskService } from '../../src/services/task-service.js';
import type { TaskUnitOfWork } from '../../src/services/task/ports.js';
import {
  canAgentUseCapability,
  canPostToConversation,
} from '../../src/permissions.js';

interface Setup {
  workspaceId: string;
  agentIds: Record<string, string>;
}

async function setup(t: TestApp): Promise<Setup> {
  const h = http(t);
  const agentIds: Record<string, string> = {};
  for (const name of ['alice', 'bob', 'carol']) {
    const r = (await (
      await h.post('/api/agents', { name, runtime: 'claude' })
    ).json()) as any;
    agentIds[name] = r.agent.id;
  }
  const ws = (await (
    await h.post('/api/workspaces', {
      name: 'eng',
      member_agent_ids: Object.values(agentIds),
    })
  ).json()) as any;
  return { workspaceId: ws.workspace.id, agentIds };
}

function directPair(t: TestApp, aId: string, bId: string): { id: string; pairKey: string } {
  const repo = new ConversationRepo(t.ctx.db);
  const { conversation } = repo.getOrCreateDirectPair(
    { kind: 'agent', id: aId },
    { kind: 'agent', id: bId },
    Date.now(),
  );
  return { id: conversation.id, pairKey: conversation.pair_key! };
}

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

const agentBase = (cid: string, aid: string): string =>
  conversationSlotTestPath(`/internal/agents/${aid}/tasks`, cid);

function hardDeleteAgent(t: TestApp, agentId: string): void {
  createSqliteAgentTeardownPersistence(t.ctx.db).uow.atomicallyForAgent(
    { agentId },
    tx => {
      tx.agent.deleteAgentRow();
      return 0;
    },
  );
}

/** Replace only the task UoW with a one-shot boundary interposer. The route
 * precheck has already run when `beforeTx` fires; the canonical postability
 * decision then runs inside the real SQLite transaction on the updated DB. */
function interposeTaskTransaction(t: TestApp, beforeTx: () => void): void {
  const persistence = t.persistence.tasks;
  let armed = true;
  const uow: TaskUnitOfWork = {
    atomically(authority, fn) {
      if (armed) {
        armed = false;
        beforeTx();
      }
      return persistence.uow.atomically(authority, fn);
    },
  };
  t.ctx.taskService = new TaskService({
    read: persistence.read,
    board: persistence.board,
    conversations: persistence.conversations,
    uow,
    agents: t.persistence.repos.agents,
    workspaces: t.persistence.repos.workspaces,
    runtimeHost: t.ctx.runtimeHost,
    events: t.ctx.events,
    logger: t.ctx.logger,
    canUseCapability: (actor, workspaceId, capability) =>
      canAgentUseCapability(t.ctx, actor, capability, { workspaceId }),
    canPostToConversation: (actor, conversationId) =>
      canPostToConversation(t.ctx, actor, conversationId),
  });
}

describe('P0-f DirectPairBoard (#task:2022) — the pair conversation as a task board', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('files, numbers, reads and mutates tasks on the pair board from the DM frame — full verb chain', async () => {
    t = buildTestApp();
    const { agentIds } = await setup(t);
    const h = http(t);
    const pair = directPair(t, agentIds.alice!, agentIds.bob!);

    // create (frame = destination = the DM): numbering starts at 1.
    const created = (await (
      await h.post(agentBase(pair.id, agentIds.alice!) + '/create', {
        target: `#conv:${pair.id}`,
        tasks: [{ title: 'pair work' }, { title: 'second' }],
      })
    ).json()) as any;
    expect(created.tasks).toHaveLength(2);
    expect(created.tasks[0].task_number).toBe(1);
    expect(created.tasks[1].task_number).toBe(2);

    // list from the DM frame: the pair board only, rows carry the pair arm
    // with NULL workspace coordinates and no display-string stand-ins.
    const listed = (await (
      await h.get(agentBase(pair.id, agentIds.alice!))
    ).json()) as any;
    expect(listed.tasks).toHaveLength(2);
    for (const row of listed.tasks) {
      expect(row.place).toEqual({
        kind: 'direct_pair',
        conversation_id: pair.id,
        pair_key: pair.pairKey,
      });
      expect(row).not.toHaveProperty('workspace_id');
      expect(row).not.toHaveProperty('workspace_name');
      expect(row).not.toHaveProperty('channel_name');
      expect(row).not.toHaveProperty('conversation');
      expect(row).not.toHaveProperty('channel_id');
    }

    // by-number detail from the DM frame (ambient board = the pair board).
    const byNumber = (await (
      await h.get(agentBase(pair.id, agentIds.alice!) + '/detail?task_number=1')
    ).json()) as any;
    expect(byNumber.task.id).toBe(created.tasks[0].id);
    expect(byNumber.task.place).toEqual({
      kind: 'direct_pair',
      conversation_id: pair.id,
      pair_key: pair.pairKey,
    });

    // by-id detail from the DM frame.
    const byId = (await (
      await h.get(
        agentBase(pair.id, agentIds.alice!) + `/detail?task_id=${created.tasks[0].id}`,
      )
    ).json()) as any;
    expect(byId.task.id).toBe(created.tasks[0].id);

    // claim / status / edit / unclaim by number — the endpoint's own line, no
    // capability table anywhere (participation is the authority).
    const claim = (await (
      await h.post(agentBase(pair.id, agentIds.bob!) + '/claim', { task_numbers: [1] })
    ).json()) as any;
    expect(claim.results[0].success, JSON.stringify(claim.results[0])).toBe(true);
    const status = (await (
      await h.post(agentBase(pair.id, agentIds.bob!) + '/update-status', {
        task_number: 1,
        status: 'in_review',
      })
    ).json()) as any;
    expect(status.success).toBe(true);
    const edit = (await (
      await h.post(agentBase(pair.id, agentIds.bob!) + '/edit', {
        task_number: 1,
        title: 'renamed on the pair board',
      })
    ).json()) as any;
    expect(edit.success).toBe(true);
    expect(edit.task.place).toEqual({
      kind: 'direct_pair',
      conversation_id: pair.id,
      pair_key: pair.pairKey,
    });
    const unclaim = (await (
      await h.post(agentBase(pair.id, agentIds.bob!) + '/unclaim', { task_number: 1 })
    ).json()) as any;
    expect(unclaim.success).toBe(true);

    // The task_create system event landed in the DM conversation itself.
    // (Read through the repo: the HUMAN messages API correctly refuses a
    // viewer who is not an endpoint of this agent↔agent pair.)
    const messages = new MessageRepo(t.ctx.db).listForConversation(pair.id);
    expect(
      messages.some(
        m => m.from_kind === 'system' && String(m.content).includes('pair work'),
      ),
    ).toBe(true);
  });

  it('numbers independently per pair and never disturbs the workspace board', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const chan = await channel(t, workspaceId, 'general', [agentIds.alice!]);
    // Workspace board history first.
    await h.post(agentBase(chan, agentIds.alice!) + '/create', {
      target: `#conv:${chan}`,
      tasks: [{ title: 'ws one' }, { title: 'ws two' }],
    });
    const p1 = directPair(t, agentIds.alice!, agentIds.bob!);
    const p2 = directPair(t, agentIds.alice!, agentIds.carol!);
    const c1 = (await (
      await h.post(agentBase(p1.id, agentIds.alice!) + '/create', {
        target: `#conv:${p1.id}`,
        tasks: [{ title: 'p1 a' }],
      })
    ).json()) as any;
    const c2 = (await (
      await h.post(agentBase(p2.id, agentIds.alice!) + '/create', {
        target: `#conv:${p2.id}`,
        tasks: [{ title: 'p2 a' }],
      })
    ).json()) as any;
    const c1b = (await (
      await h.post(agentBase(p1.id, agentIds.alice!) + '/create', {
        target: `#conv:${p1.id}`,
        tasks: [{ title: 'p1 b' }],
      })
    ).json()) as any;
    // Each pair owns 1,2,…; the workspace board's next number is untouched.
    expect(c1.tasks[0].task_number).toBe(1);
    expect(c2.tasks[0].task_number).toBe(1);
    expect(c1b.tasks[0].task_number).toBe(2);
    const wsNext = (await (
      await h.post(agentBase(chan, agentIds.alice!) + '/create', {
        target: `#conv:${chan}`,
        tasks: [{ title: 'ws three' }],
      })
    ).json()) as any;
    expect(wsNext.tasks[0].task_number).toBe(3);
  });

  it('files on the pair board addressed as dm:@handle — from a workspace frame, and opening the pair if there is none', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const chan = await channel(t, workspaceId, 'ws-frame', [agentIds.alice!, agentIds.bob!]);
    const existing = directPair(t, agentIds.alice!, agentIds.bob!);

    // The ADDRESS decides the board, not the frame the agent is woken in
    // (#task:2021 P4-4): alice is working in a workspace channel and files onto
    // her DM with bob by naming it the way a person would.
    const toExisting = (await (
      await h.post(agentBase(chan, agentIds.alice!) + '/create', {
        target: 'dm:@bob',
        tasks: [{ title: 'dm-addressed' }],
      })
    ).json()) as any;
    expect(toExisting.error).toBeUndefined();
    const onPair = (await (
      await h.get(agentBase(existing.id, agentIds.alice!))
    ).json()) as any;
    expect(onPair.tasks.map((r: any) => r.title)).toEqual(['dm-addressed']);
    expect(onPair.tasks[0].place).toEqual({
      kind: 'direct_pair',
      conversation_id: existing.id,
      pair_key: existing.pairKey,
    });

    // No pair with carol yet. `dm:@handle` is the one arm that ALLOCATES for a
    // write intent, so the create opens the pair and files there — the board is
    // created by addressing it, not by a separate "open a DM" step.
    const toNew = (await (
      await h.post(agentBase(chan, agentIds.alice!) + '/create', {
        target: 'dm:@carol',
        tasks: [{ title: 'opened by addressing' }],
      })
    ).json()) as any;
    expect(toNew.error).toBeUndefined();
    // Re-resolving the same unordered pair returns the conversation the create
    // allocated (getOrCreateDirectPair is idempotent), so this is the board the
    // address named — not a second one.
    const opened = directPair(t, agentIds.alice!, agentIds.carol!);
    expect(opened.id).not.toBe(existing.id);
    const onOpened = (await (
      await h.get(agentBase(opened.id, agentIds.alice!))
    ).json()) as any;
    expect(onOpened.tasks.map((r: any) => r.title)).toEqual(['opened by addressing']);
    expect(onOpened.tasks[0].place).toEqual({
      kind: 'direct_pair',
      conversation_id: opened.id,
      pair_key: opened.pairKey,
    });
    // Per-pair numbering, so both boards start at 1 — the workspace channel the
    // caller was framed in got neither row.
    expect(onPair.tasks[0].task_number).toBe(1);
    expect(onOpened.tasks[0].task_number).toBe(1);
    const inFrame = (await (
      await h.get(agentBase(chan, agentIds.alice!))
    ).json()) as any;
    expect(
      inFrame.tasks.filter((r: any) => r.place?.kind !== 'direct_pair'),
    ).toEqual([]);
  });

  it('ACL is endpoint-ness: a same-workspace non-endpoint is indistinguishably blind on every face', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const pair = directPair(t, agentIds.alice!, agentIds.bob!);
    const created = (await (
      await h.post(agentBase(pair.id, agentIds.alice!) + '/create', {
        target: `#conv:${pair.id}`,
        tasks: [{ title: 'private line' }],
      })
    ).json()) as any;
    const task = created.tasks[0];
    const chanCarol = await channel(t, workspaceId, 'carols', [agentIds.carol!]);

    // detail --id folds exactly like an unknown id.
    const unknown = await h.get(
      agentBase(chanCarol, agentIds.carol!) + '/detail?task_id=zzzzzzzzzzzzzzzz',
    );
    const hidden = await h.get(
      agentBase(chanCarol, agentIds.carol!) + `/detail?task_id=${task.id}`,
    );
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(await hidden.json())).toBe(JSON.stringify(await unknown.json()));

    // Her workspace list never contains the pair row; her ambient by-number
    // resolves HER board, not the pair's #1.
    const listed = (await (
      await h.get(agentBase(chanCarol, agentIds.carol!))
    ).json()) as any;
    expect(listed.tasks.map((r: any) => r.id)).not.toContain(task.id);

    // by-id mutations fold to the uniform envelope.
    const claim = (await (
      await h.post(agentBase(chanCarol, agentIds.carol!) + '/claim', { task_ids: [task.id] })
    ).json()) as any;
    expect(claim.results[0]).toEqual({
      success: false,
      code: 'task_not_found',
      reason: 'task not found',
      id: task.id,
    });
    // create into the pair from a non-endpoint: since #task:2021 P4-4 the
    // destination is an ADDRESS, so this refusal is the resolver's — carol is not a
    // participant, which is the same answer an id naming nothing gets, and it folds
    // with the `detail` pair above rather than being a create-specific 403.
    const create = await h.post(agentBase(chanCarol, agentIds.carol!) + '/create', {
      target: `#conv:${pair.id}`,
      tasks: [{ title: 'intrude' }],
    });
    const createUnknown = await h.post(agentBase(chanCarol, agentIds.carol!) + '/create', {
      target: '#conv:zzzzzzzzzzzzzzzz',
      tasks: [{ title: 'intrude' }],
    });
    expect(create.status).toBe(404);
    expect(createUnknown.status).toBe(404);
    expect(await create.text()).toBe(await createUnknown.text());
  });

  it('AgentSlot: the no-filter union contains the pair board, and the global id crosses frames', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const twin = insertAgentScopedAgent(t, agentIds.alice!, 'twin-pair');
    // The union's workspace half needs a real workspace_members row; the
    // channel gives the twin a conversation frame on that board.
    t.persistence.repos.workspaces.insertMembership(workspaceId, twin);
    const chan = await channel(t, workspaceId, 'twin-chan', [twin]);
    const auth = agentSlotAuth(t, twin);
    const pair = directPair(t, twin, agentIds.bob!);
    const created = (await (
      await h.post(
        canonicalTasksPath(twin, pair.id, '/create'),
        { target: `#conv:${pair.id}`, tasks: [{ title: 'twin pair task' }] },
        { headers: auth },
      )
    ).json()) as any;
    const task = created.tasks[0];

    // Union list from a WORKSPACE frame includes the pair-board row.
    const union = (await (
      await h.get(canonicalTasksPath(twin, chan, ''), { headers: auth })
    ).json()) as any;
    const row = union.tasks.find((r: any) => r.id === task.id);
    expect(row).toBeDefined();
    expect(row.place).toEqual({
      kind: 'direct_pair',
      conversation_id: pair.id,
      pair_key: pair.pairKey,
    });

    // Global id dereferences the pair task from the workspace frame.
    const detail = await h.get(
      canonicalTasksPath(twin, chan, `/detail?task_id=${task.id}`),
      { headers: auth },
    );
    expect(detail.status).toBe(200);
    // …and a by-id mutation works cross-frame too.
    const claim = (await (
      await h.post(canonicalTasksPath(twin, chan, '/claim'), { task_ids: [task.id] }, { headers: auth })
    ).json()) as any;
    expect(claim.results[0].success, JSON.stringify(claim.results[0])).toBe(true);
  });

  it('uses placement-aware participation for pair source admission and detail navigation', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const pair = directPair(t, agentIds.alice!, agentIds.bob!);
    const source = new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: pair.id,
      fromKind: 'agent',
      fromAgentId: agentIds.alice!,
      content: 'turn this pair message into a task',
    });

    const created = (await (
      await h.post(agentBase(pair.id, agentIds.alice!) + '/create', {
        target: `#conv:${pair.id}`,
        tasks: [{ title: 'from pair source', source_message_id: source.id }],
      })
    ).json()) as any;
    expect(created.error).toBeUndefined();
    const task = created.tasks[0];

    const detail = (await (
      await h.get(agentBase(pair.id, agentIds.alice!) + `/detail?task_id=${task.id}`)
    ).json()) as any;
    expect(detail.task.source_message_id).toBe(source.id);
    expect(detail.task.nav).toEqual({
      kind: 'source',
      ref: {
        channel_id: pair.id,
        thread_root_id: null,
        message_id: source.id,
      },
    });

    const carolFrame = await channel(t, workspaceId, 'carol-source-blind', [agentIds.carol!]);
    const hidden = await h.get(
      agentBase(carolFrame, agentIds.carol!) + `/detail?task_id=${task.id}`,
    );
    const unknown = await h.get(
      agentBase(carolFrame, agentIds.carol!) + '/detail?task_id=unknown-task-id',
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await unknown.json());
  });

  it('keeps a survivor-readable pair write-closed across create and all AgentSlot mutations', async () => {
    t = buildTestApp();
    const { workspaceId, agentIds } = await setup(t);
    const h = http(t);
    const survivor = insertAgentScopedAgent(t, agentIds.alice!, 'readonly-survivor');
    t.persistence.repos.workspaces.insertMembership(workspaceId, survivor);
    const origin = await channel(t, workspaceId, 'readonly-origin', [survivor]);
    const pair = directPair(t, survivor, agentIds.bob!);
    const auth = agentSlotAuth(t, survivor);
    const pairPath = canonicalTasksPath(survivor, pair.id, '');
    const originPath = canonicalTasksPath(survivor, origin, '');

    const created = (await (
      await h.post(pairPath + '/create', {
        target: `#conv:${pair.id}`,
        tasks: [{ title: 'claim later' }, { title: 'already assigned' }],
      }, { headers: auth })
    ).json()) as any;
    const [claimLater, assigned] = created.tasks;
    const initialClaim = (await (
      await h.post(pairPath + '/claim', { task_ids: [assigned.id] }, { headers: auth })
    ).json()) as any;
    expect(initialClaim.results[0].success).toBe(true);

    hardDeleteAgent(t, agentIds.bob!);
    const messagesBefore = new MessageRepo(t.ctx.db).listForConversation(pair.id).length;
    const events: string[] = [];
    const unsubscribe = t.ctx.events.subscribe(pair.id, event => events.push(event.kind));
    try {
      const create = await h.post(pairPath + '/create', {
        target: `#conv:${pair.id}`,
        tasks: [{ title: 'must not be born' }],
      }, { headers: auth });
      expect(create.status).toBe(200);
      expect(await create.json()).toEqual({ error: 'conversation_readonly' });

      const claim = (await (
        await h.post(originPath + '/claim', { task_ids: [claimLater.id] }, { headers: auth })
      ).json()) as any;
      const unclaim = (await (
        await h.post(originPath + '/unclaim', { task_id: assigned.id }, { headers: auth })
      ).json()) as any;
      const status = (await (
        await h.post(originPath + '/update-status', {
          task_id: assigned.id,
          status: 'in_progress',
        }, { headers: auth })
      ).json()) as any;
      const edit = (await (
        await h.post(originPath + '/edit', {
          task_id: claimLater.id,
          title: 'must not change',
        }, { headers: auth })
      ).json()) as any;

      expect(claim.results[0].code).toBe('conversation_readonly');
      expect(unclaim.code).toBe('conversation_readonly');
      expect(status.code).toBe('conversation_readonly');
      expect(edit.code).toBe('conversation_readonly');
      expect(new MessageRepo(t.ctx.db).listForConversation(pair.id)).toHaveLength(messagesBefore);
      expect(events).toEqual([]);

      const survivorList = (await (
        await h.get(pairPath, { headers: auth })
      ).json()) as any;
      expect(survivorList.tasks.map((row: any) => row.id)).toEqual(
        expect.arrayContaining([claimLater.id, assigned.id]),
      );
      const taskRows = survivorList.tasks as Array<Record<string, any>>;
      expect(taskRows.find(row => row.id === claimLater.id)).toMatchObject({
        title: 'claim later',
        status: 'todo',
        assignee: null,
      });
      expect(taskRows.find(row => row.id === assigned.id)).toMatchObject({
        title: 'already assigned',
        status: 'in_progress',
        assignee: { id: survivor },
      });
    } finally {
      unsubscribe();
    }
  });

  it('rechecks canonical postability inside create transaction after peer deletion race', async () => {
    t = buildTestApp();
    const { agentIds } = await setup(t);
    const h = http(t);
    const pair = directPair(t, agentIds.alice!, agentIds.bob!);
    const beforeTasks = (await (
      await h.get(agentBase(pair.id, agentIds.alice!))
    ).json() as any).tasks.length;
    const beforeMessages = new MessageRepo(t.ctx.db).listForConversation(pair.id).length;

    // Route/service prechecks still see both endpoints. The interposer deletes
    // Bob immediately before the real UoW begins; only an in-transaction call
    // to the canonical canPostToConversation decision can close this race.
    interposeTaskTransaction(t, () => hardDeleteAgent(t!, agentIds.bob!));
    const result = (await (
      await h.post(agentBase(pair.id, agentIds.alice!) + '/create', {
        target: `#conv:${pair.id}`,
        tasks: [{ title: 'raced write' }],
      })
    ).json()) as any;

    expect(result.error).toBe('conversation_readonly');
    const afterTasks = (await (
      await h.get(agentBase(pair.id, agentIds.alice!))
    ).json() as any).tasks.length;
    expect(afterTasks).toBe(beforeTasks);
    expect(new MessageRepo(t.ctx.db).listForConversation(pair.id)).toHaveLength(beforeMessages);
  });

  it('tombstoned endpoint: the projection stays total — identity-only DTO, no live-handle dependence', async () => {
    t = buildTestApp();
    const { agentIds } = await setup(t);
    const h = http(t);
    const pair = directPair(t, agentIds.alice!, agentIds.bob!);
    const created = (await (
      await h.post(agentBase(pair.id, agentIds.alice!) + '/create', {
        target: `#conv:${pair.id}`,
        tasks: [{ title: 'survivor work' }],
      })
    ).json()) as any;
    const task = created.tasks[0];

    // Hard-delete bob through the REAL teardown persistence scope (P0-e:
    // the BEFORE DELETE trigger stamps the endpoint tombstone; the
    // conversation and the task survive the cascade).
    hardDeleteAgent(t, agentIds.bob!);

    const listed = (await (
      await h.get(agentBase(pair.id, agentIds.alice!))
    ).json()) as any;
    const row = listed.tasks.find((r: any) => r.id === task.id);
    expect(row).toBeDefined();
    expect(row.place).toEqual({
      kind: 'direct_pair',
      conversation_id: pair.id,
      pair_key: pair.pairKey,
    });
    expect(row).not.toHaveProperty('workspace_id');
    expect(row).not.toHaveProperty('workspace_name');
    expect(row).not.toHaveProperty('channel_name');
    expect(row).not.toHaveProperty('conversation');
    expect(row).not.toHaveProperty('channel_id');
    const detail = (await (
      await h.get(agentBase(pair.id, agentIds.alice!) + `/detail?task_id=${task.id}`)
    ).json()) as any;
    expect(detail.task.id).toBe(task.id);
  });
});
