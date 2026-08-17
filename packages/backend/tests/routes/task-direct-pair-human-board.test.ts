// #task:2037 / #task:2041 Phase A — the HUMAN read faces of a human↔agent
// DirectPair task.
//
// The dogfood defect: an agent files a task on its DM with a person, and the
// person's human surfaces cannot see it. The pair is ROSTERLESS by construction
// (no `conversation_users` row), so every human task read face that still asked
// the roster was blind to it. This test pins that all THREE faces now resolve
// through the ONE placement-participation authority, so a task the point read
// serves is exactly a task the board shows and the change event reaches:
//
//   1. per-task ACL      — GET /api/tasks/:id
//   2. board population  — GET /api/tasks/board/{column,counts,facets}
//   3. task_changed      — the `viewer:<userId>` fan-out
//
// and that the DM endpoint's authority is endpoint-ness ALONE: a third-party
// human with no relationship to the pair is indistinguishably blind on every
// face, and the workspace arm is unchanged (its member still sees its task, the
// DM endpoint does not).
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  TaskBoardColumnDtoSchema,
  TaskBoardCountsDtoSchema,
  TaskBoardFacetsDtoSchema,
  X_SILVERHAND_PRINCIPAL_HEADER,
  type TaskStatus,
} from '@silverhand/shared';
import {
  buildTestApp,
  http,
  type TestApp,
} from '../utils/app.js';
import { agentSlotAuth } from '../utils/agent-scope.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';

// Two humans who are NOT the agent's owner: the endpoint of the DM, and a
// stranger to it. Both are registered fixture users, so session issuance finds a
// `users` row for each.
const ENDPOINT_ID = 'teammate'; // the human endpoint of the human↔agent pair
const STRANGER_ID = 'someone'; //  a third-party human — no tie to the pair

const asUser = (id: string) => ({
  [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(id),
});

const agentBase = (aid: string): string => `/internal/agents/${aid}/tasks`;

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  return sp.toString();
}

async function makeAgent(
  t: TestApp,
  name: string,
  // Direct Message ↔ agent-scoped is the frozen model: a human↔agent DM
  // endpoint MUST be a `session_scope='agent'` agent, never a conversation-scoped
  // one (that shape belongs to an Agent Space, not a DM). Agent Space positive
  // controls pass the default 'conversation'.
  sessionScope: 'conversation' | 'agent' = 'conversation',
): Promise<string> {
  const r = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude', session_scope: sessionScope })
  ).json()) as any;
  expect(r.agent?.id, JSON.stringify(r)).toBeTruthy();
  return r.agent.id;
}

/** The board column ids a given viewer sees for one status. */
async function columnIds(
  t: TestApp,
  userId: string,
  params: Record<string, string | number | undefined>,
): Promise<string[]> {
  const res = await http(t, asUser(userId)).get(
    `/api/tasks/board/column?${qs(params)}`,
  );
  expect(res.status, `column ${userId} ${qs(params)}`).toBe(200);
  const dto = TaskBoardColumnDtoSchema.parse(await res.json());
  return dto.items.map(i => i.id);
}

async function counts(
  t: TestApp,
  userId: string,
  params: Record<string, string | number | undefined> = {},
): Promise<Record<TaskStatus, number>> {
  const res = await http(t, asUser(userId)).get(
    `/api/tasks/board/counts?${qs(params)}`,
  );
  expect(res.status).toBe(200);
  return TaskBoardCountsDtoSchema.parse(await res.json()).counts;
}

describe('#task:2037 — human↔agent DirectPair task on the human read faces', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('the DM endpoint reads the agent-filed task on every face; a stranger is blind on every face; the workspace arm is unchanged', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const conversations = new ConversationRepo(t.ctx.db);

    // A human↔agent DirectPair. The agent is AGENT-SCOPED — the frozen model
    // binds Direct Message to `session_scope='agent'`; a conversation-scoped
    // agent belongs to an Agent Space, never to a DM. The DM's human endpoint is
    // TEAMMATE — a person with NO other tie to the agent — so the read authority
    // under test is endpoint-ness alone, not agent ownership.
    const agentId = await makeAgent(t, 'dm-agent', 'agent');
    const pair = conversations.getOrCreateDirectPair(
      { kind: 'agent', id: agentId },
      { kind: 'human', id: ENDPOINT_ID },
      Date.now(),
    ).conversation;

    // A workspace channel owned by the STRANGER, with its own task — the arm the
    // placement change must NOT have widened. Creating the workspace seats the
    // stranger as its owner (the v25 pair: channel seat + workspace membership),
    // and the task is filed through the real human create route, so no fixture
    // reaches past a production surface into raw SQL.
    const ws = (await (
      await http(t, asUser(STRANGER_ID)).post('/api/workspaces', { name: 'stranger-ws' })
    ).json()) as any;
    const wsChannel: string = ws.onboarding_channel_id;
    const wsTaskRes = (await (
      await http(t, asUser(STRANGER_ID)).post('/api/tasks', {
        conversation_id: wsChannel,
        title: 'workspace task',
      })
    ).json()) as any;
    expect(wsTaskRes.task?.id, JSON.stringify(wsTaskRes)).toBeTruthy();
    const wsTaskId: string = wsTaskRes.task.id;

    // The endpoint's viewer scope must receive the change; the stranger's must
    // not — the fan-out is the third face and it is placement-gated too.
    const endpointEvents: string[] = [];
    const strangerEvents: string[] = [];
    const unsubEndpoint = t.ctx.events.subscribeScope(
      `viewer:${ENDPOINT_ID}`,
      e => endpointEvents.push(e.kind),
    );
    const unsubStranger = t.ctx.events.subscribeScope(
      `viewer:${STRANGER_ID}`,
      e => strangerEvents.push(e.kind),
    );

    let taskId: string;
    let taskNumber: number;
    try {
      // The agent files a task ON the DM — the exact dogfood action. It files as
      // an AGENTSLOT: an agent-scoped agent has no per-conversation
      // ConversationSlot, its runtime IS the aggregate slot, so the bearer is the
      // agent-slot token and the destination is the required `#conv:` address.
      // (This is also the B6 path — the AgentSlot has no origin stream, so the
      // narration reads plain `created`, never "from another conversation".)
      const created = (await (
        await http(t).post(
          agentBase(agentId) + '/create',
          { target: `#conv:${pair.id}`, tasks: [{ title: 'agent-filed on the DM' }] },
          { headers: agentSlotAuth(t, agentId) },
        )
      ).json()) as any;
      expect(created.error, JSON.stringify(created)).toBeUndefined();
      taskId = created.tasks[0].id;
      taskNumber = created.tasks[0].task_number;
    } finally {
      unsubEndpoint();
      unsubStranger();
    }

    // FACE 3 — task_changed reached the endpoint's board scope, not the stranger's.
    expect(endpointEvents.filter(k => k === 'task_changed')).toHaveLength(1);
    expect(strangerEvents.filter(k => k === 'task_changed')).toHaveLength(0);

    // B6 on the dogfood conversation itself: the AgentSlot filed ON its own DM,
    // so the system message must narrate a plain `created` — never "from another
    // conversation", which would tell the DM's human a falsehood about an origin
    // the agent has none of. (The general AgentSlot rule has its own falsifier in
    // task-identity-agent-slot.test.ts; this pins it on the exact defect frame.)
    const dmSystem = t.persistence.repos.messages
      .listForConversation(pair.id)
      .filter(m => m.from_kind === 'system')
      .at(-1)!;
    expect(dmSystem.content).toMatch(
      new RegExp(` created task #${taskNumber} "agent-filed on the DM"$`),
    );
    expect(dmSystem.content.includes('from another conversation')).toBe(false);
    expect(dmSystem.metadata?.cross_conversation).toBeUndefined();

    // FACE 1 — per-task ACL. The endpoint reads it; the stranger's rejection is
    // byte-identical to an unknown id (no existence oracle).
    const endpointDetail = await http(t, asUser(ENDPOINT_ID)).get(`/api/tasks/${taskId}`);
    expect(endpointDetail.status).toBe(200);
    expect(((await endpointDetail.json()) as any).task.id).toBe(taskId);

    const strangerDetail = await http(t, asUser(STRANGER_ID)).get(`/api/tasks/${taskId}`);
    const strangerUnknown = await http(t, asUser(STRANGER_ID)).get('/api/tasks/zzzzzzzzzzzzzzzz');
    expect(strangerDetail.status).toBe(404);
    expect(await strangerDetail.text()).toBe(await strangerUnknown.text());

    // FACE 1b — the by-number sigil face (#task:2037 B5). The `#task:<n>` sigil
    // in a DM message resolves through `GET /api/tasks/by-number`, which names
    // the board by ANY conversation on it. The pair's `workspace_id` is NULL, so
    // the retired `workspace_id` namespace could NEVER have named this board —
    // deriving it from the pair conversation's placement is exactly what makes a
    // DM-filed task reachable by number. The endpoint resolves it; the stranger's
    // rejection is byte-identical to an unallocated number (no existence oracle).
    const byNumber = (params: Record<string, string | number>) =>
      `/api/tasks/by-number?${qs(params)}`;
    const endpointByNum = await http(t, asUser(ENDPOINT_ID)).get(
      byNumber({ conversation_id: pair.id, task_number: taskNumber }),
    );
    expect(endpointByNum.status).toBe(200);
    expect(((await endpointByNum.json()) as any).task.id).toBe(taskId);

    const strangerByNum = await http(t, asUser(STRANGER_ID)).get(
      byNumber({ conversation_id: pair.id, task_number: taskNumber }),
    );
    const strangerByNumUnalloc = await http(t, asUser(STRANGER_ID)).get(
      byNumber({ conversation_id: pair.id, task_number: taskNumber + 999 }),
    );
    expect(strangerByNum.status).toBe(404);
    expect(await strangerByNum.text()).toBe(await strangerByNumUnalloc.text());

    // FACE 2 — board population. The endpoint's All board carries the DM task;
    // the stranger's does not (it carries only their workspace task).
    expect(await columnIds(t, ENDPOINT_ID, { status: 'todo' })).toEqual([taskId]);
    expect(await columnIds(t, STRANGER_ID, { status: 'todo' })).toEqual([wsTaskId]);

    // The four-state container axis (#task:2041): `direct_messages` narrows the
    // endpoint's board to exactly the DM task…
    expect(
      await columnIds(t, ENDPOINT_ID, { status: 'todo', container: 'direct_messages' }),
    ).toEqual([taskId]);
    // …while the two workspace-family containers exclude it: the DM lives on no
    // workspace at all, so neither `workspace` (regular) nor `agent_space`
    // (agent_home) can contain it. The endpoint sees NO workspace tasks either.
    expect(
      await columnIds(t, ENDPOINT_ID, { status: 'todo', container: 'workspace' }),
    ).toEqual([]);
    expect(
      await columnIds(t, ENDPOINT_ID, { status: 'todo', container: 'agent_space' }),
    ).toEqual([]);
    // A specific workspace narrowing likewise excludes the DM task (its
    // workspace_id is NULL), so container and workspace_id never contradict.
    expect(
      await columnIds(t, ENDPOINT_ID, { status: 'todo', workspace_id: ws.workspace.id }),
    ).toEqual([]);

    // THE DM LEAF (#task:2041 B2, pinned on @Cindy's ruling). Inside the
    // `direct_messages` container the renderer may narrow to ONE peer, and it
    // does so through the existing `channel_id` axis — the axis is named for
    // channels but its coordinate has always been a CONVERSATION id
    // (`t.conversation_id = ?`), and for a pair the conversation IS the line. So
    // the leaf needs no new parameter and no pseudo workspace/channel
    // coordinate. That is load-bearing rather than incidental: the DM leaf is
    // the only way to select one peer, and it had no coverage — adding a
    // workspace join to the `channelId` branch would empty every DM leaf while
    // this suite stayed green.
    expect(
      await columnIds(t, ENDPOINT_ID, { status: 'todo', channel_id: pair.id }),
    ).toEqual([taskId]);
    // Container ∩ leaf INTERSECT (they are not alternatives): the leaf inside its
    // own container is the same row…
    expect(
      await columnIds(t, ENDPOINT_ID, {
        status: 'todo',
        container: 'direct_messages',
        channel_id: pair.id,
      }),
    ).toEqual([taskId]);
    // …and a leaf that its container cannot hold is empty, not silently widened
    // to the container (or to the leaf).
    expect(
      await columnIds(t, ENDPOINT_ID, {
        status: 'todo',
        container: 'workspace',
        channel_id: pair.id,
      }),
    ).toEqual([]);
    // Counts are computed on the same population as the leaf column.
    expect((await counts(t, ENDPOINT_ID, { channel_id: pair.id })).todo).toBe(1);
    expect(
      (await counts(t, ENDPOINT_ID, { container: 'direct_messages', channel_id: pair.id }))
        .todo,
    ).toBe(1);
    // NAMING A LINE IS NOT READING IT: the leaf coordinate is not a capability.
    // A third party who knows the pair's conversation id gets an empty board, not
    // its tasks — the per-task placement ACL still decides, exactly as on the
    // unfiltered board.
    expect(
      await columnIds(t, STRANGER_ID, { status: 'todo', channel_id: pair.id }),
    ).toEqual([]);
    expect((await counts(t, STRANGER_ID, { channel_id: pair.id })).todo).toBe(0);

    // The stranger's own task lives on a REGULAR workspace: it is in the
    // `workspace` container, NOT `agent_space` (that split is `workspace_kind`,
    // not placement, so a proxy that only saw `placement_kind='workspace'` would
    // wrongly bucket it into both), and NOT `direct_messages` (they are an
    // endpoint of no pair) even though their All board is non-empty.
    expect(
      await columnIds(t, STRANGER_ID, { status: 'todo', container: 'workspace' }),
    ).toEqual([wsTaskId]);
    expect(
      await columnIds(t, STRANGER_ID, { status: 'todo', container: 'agent_space' }),
    ).toEqual([]);
    expect(
      await columnIds(t, STRANGER_ID, { status: 'todo', container: 'direct_messages' }),
    ).toEqual([]);

    // Counts agree with the columns, on the same population.
    expect((await counts(t, ENDPOINT_ID)).todo).toBe(1);
    expect((await counts(t, ENDPOINT_ID, { container: 'direct_messages' })).todo).toBe(1);
    expect((await counts(t, ENDPOINT_ID, { container: 'workspace' })).todo).toBe(0);
    expect((await counts(t, ENDPOINT_ID, { workspace_id: ws.workspace.id })).todo).toBe(0);
    expect((await counts(t, STRANGER_ID, { container: 'workspace' })).todo).toBe(1);
    expect((await counts(t, STRANGER_ID, { container: 'direct_messages' })).todo).toBe(0);

    // Facets are computed over the endpoint's whole visible population, so the
    // agent creator of the DM task appears for the endpoint and not the stranger.
    const endpointFacets = TaskBoardFacetsDtoSchema.parse(
      await (await http(t, asUser(ENDPOINT_ID)).get('/api/tasks/board/facets')).json(),
    );
    expect(endpointFacets.creators.map(c => c.id)).toContain(agentId);
    const strangerFacets = TaskBoardFacetsDtoSchema.parse(
      await (await http(t, asUser(STRANGER_ID)).get('/api/tasks/board/facets')).json(),
    );
    expect(strangerFacets.creators.map(c => c.id)).not.toContain(agentId);

    // The container also scopes the facet MENUS (it selects the board): the
    // agent DM-creator is in the `direct_messages` board's menu but NOT the
    // `workspace` board's — a dead option on a board where they authored
    // nothing is exactly what container-scoping removes. (The within-board axes
    // still do not narrow the menus; only the container does.)
    const dmFacets = TaskBoardFacetsDtoSchema.parse(
      await (
        await http(t, asUser(ENDPOINT_ID)).get('/api/tasks/board/facets?container=direct_messages')
      ).json(),
    );
    expect(dmFacets.creators.map(c => c.id)).toContain(agentId);
    const wsFacets = TaskBoardFacetsDtoSchema.parse(
      await (
        await http(t, asUser(ENDPOINT_ID)).get('/api/tasks/board/facets?container=workspace')
      ).json(),
    );
    expect(wsFacets.creators.map(c => c.id)).not.toContain(agentId);
  });

  it('the agent_space container positively selects agent_home tasks and splits them from regular-workspace tasks', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });

    // Creating a CONVERSATION-scoped agent provisions its agent_home workspace +
    // Onboarding channel and seats the CREATING human into it (owner membership
    // AND channel seat — the v25 pair), so the default viewer is a legitimate
    // participant of an agent_space conversation with no hand-seeding.
    const agentId = await makeAgent(t, 'home-agent');
    const rs = (await (
      await http(t).get(`/api/agents/${agentId}/runtime-state`)
    ).json()) as any;
    const home = rs.participations.find(
      (s: any) => s.conversation_roster_policy === 'fixed',
    );
    expect(home?.workspace_kind).toBe('agent_home');
    const agentHomeConv: string = home.conversation_id;

    // One task on the agent_home channel, one on a REGULAR workspace — both filed
    // by the same viewer through the real human create route. The two rows differ
    // only by their conversation's `workspace_kind`, which is precisely the split
    // `agent_space` vs `workspace` must make.
    const homeTaskRes = (await (
      await http(t).post('/api/tasks', {
        conversation_id: agentHomeConv,
        title: 'agent-space task',
      })
    ).json()) as any;
    expect(homeTaskRes.task?.id, JSON.stringify(homeTaskRes)).toBeTruthy();
    const homeTaskId: string = homeTaskRes.task.id;

    const reg = (await (
      await http(t).post('/api/workspaces', { name: 'reg-ws' })
    ).json()) as any;
    const regTaskRes = (await (
      await http(t).post('/api/tasks', {
        conversation_id: reg.onboarding_channel_id,
        title: 'regular task',
      })
    ).json()) as any;
    expect(regTaskRes.task?.id, JSON.stringify(regTaskRes)).toBeTruthy();
    const regTaskId: string = regTaskRes.task.id;

    // agent_space selects ONLY the agent_home task; workspace ONLY the regular
    // one; All carries both; direct_messages carries neither.
    expect(await columnIds(t, t.viewerUserId, { status: 'todo', container: 'agent_space' })).toEqual([
      homeTaskId,
    ]);
    expect(await columnIds(t, t.viewerUserId, { status: 'todo', container: 'workspace' })).toEqual([
      regTaskId,
    ]);
    expect(new Set(await columnIds(t, t.viewerUserId, { status: 'todo' }))).toEqual(
      new Set([homeTaskId, regTaskId]),
    );
    expect(
      await columnIds(t, t.viewerUserId, { status: 'todo', container: 'direct_messages' }),
    ).toEqual([]);

    expect((await counts(t, t.viewerUserId, { container: 'agent_space' })).todo).toBe(1);
    expect((await counts(t, t.viewerUserId, { container: 'workspace' })).todo).toBe(1);
    expect((await counts(t, t.viewerUserId)).todo).toBe(2);
  });
});
