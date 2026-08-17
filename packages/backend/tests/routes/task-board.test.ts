// Human task-board read faces (#task:1884): the keyset column window, the
// authoritative per-status counts, and the filter facets.
//
// Population is seeded by DIRECT INSERT rather than through the task write
// paths. These are read-face tests: the shapes that matter (two workspaces
// holding the SAME task_number, a row the viewer must not see, a `system`
// creator whose author row is gone, a user assignee) are all reachable states
// of the `tasks` table, but only some of them are reachable through today's
// mutation routes. Workspaces, channels, agents and MEMBERSHIP are still made
// through the real routes, because membership is exactly what the viewer gate
// reads.
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  TASK_BOARD_MAX_LIMIT,
  TaskBoardColumnDtoSchema,
  TaskBoardCountsDtoSchema,
  TaskBoardFacetsDtoSchema,
  TaskStatusSchema,
  X_SILVERHAND_PRINCIPAL_HEADER,
  type TaskStatus,
  type TaskSummaryDto,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import {
  decodeTaskBoardCursor,
  encodeTaskBoardCursor,
} from '../../src/services/task/board.js';
import { taskBoardColumnQuery } from '../../src/repos/task-board-read-model.js';

interface Place {
  workspaceId: string;
  conversationId: string;
}

/** Create a workspace + its onboarding channel AS `userId`, so the resulting
 *  `conversation_users` rows are the production ones. */
async function makePlace(t: TestApp, userId: string, name: string): Promise<Place> {
  const h =
    userId === t.viewerUserId
      ? http(t)
      : http(t, { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(userId) });
  const r = (await (await h.post('/api/workspaces', { name })).json()) as any;
  expect(r.workspace?.id, JSON.stringify(r)).toBeTruthy();
  return { workspaceId: r.workspace.id, conversationId: r.onboarding_channel_id };
}

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const r = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  expect(r.agent?.id, JSON.stringify(r)).toBeTruthy();
  return r.agent.id;
}

interface SeedTask {
  place: Place;
  /** Per-workspace number — deliberately collidable across workspaces. */
  number: number;
  status?: TaskStatus;
  title?: string;
  assignee?: { agentId: string } | { userId: string };
  /** Defaults to a `user` creator (the seeding viewer). */
  creator?:
    | { kind: 'agent'; id: string }
    | { kind: 'user'; id: string }
    | { kind: 'system' };
}

/** Monotonic, zero-padded ids so `id DESC` is a KNOWN order in assertions:
 *  seeding order is also id order. */
let seedSeq = 0;

function insertTask(t: TestApp, s: SeedTask): string {
  const id = `tk-${String(++seedSeq).padStart(4, '0')}`;
  const status: TaskStatus = s.status ?? 'todo';
  const creator = s.creator ?? { kind: 'user' as const, id: t.viewerUserId };
  t.ctx.db
    .prepare(
      `INSERT INTO tasks (
         id, workspace_id, board_key, task_number, conversation_id, title, content, status,
         assignee_agent_id, assignee_user_id,
         creator_kind, creator_agent_id, creator_user_id,
         created_at, closed_at
       ) VALUES (?, ?, 'ws:' || ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      s.place.workspaceId,
      s.place.workspaceId,
      s.number,
      s.place.conversationId,
      s.title ?? `task ${s.number}`,
      status,
      s.assignee && 'agentId' in s.assignee ? s.assignee.agentId : null,
      s.assignee && 'userId' in s.assignee ? s.assignee.userId : null,
      creator.kind,
      creator.kind === 'agent' ? creator.id : null,
      creator.kind === 'user' ? creator.id : null,
      1_700_000_000_000 + seedSeq,
      status === 'closed' ? 1_700_000_000_000 + seedSeq : null,
    );
  return id;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  return sp.toString();
}

interface ColumnPage {
  status: TaskStatus;
  ids: string[];
  next_cursor: string | null;
  /** The page's items, UN-projected. `ids` is derived from this same array, so
   *  ordering assertions and per-item VALUE assertions read one response: a
   *  field-level claim (e.g. `channel_id` is fed by `tasks.conversation_id`)
   *  belongs here, because the DTO schema only pins types and two same-typed
   *  fields can be cross-wired without it noticing. */
  items: TaskSummaryDto[];
}

/** One column request, schema-validated: every assertion below is therefore
 *  also an assertion that the wire shape matches the published DTO. */
async function getColumn(
  t: TestApp,
  params: Record<string, string | number | undefined>,
): Promise<ColumnPage> {
  const res = await http(t).get(`/api/tasks/board/column?${qs(params)}`);
  expect(res.status, `column ${qs(params)}`).toBe(200);
  const dto = TaskBoardColumnDtoSchema.parse(await res.json());
  return {
    status: dto.status,
    ids: dto.items.map(i => i.id),
    next_cursor: dto.next_cursor,
    items: dto.items,
  };
}

/** Page a column to exhaustion, returning every id in delivered order plus the
 *  per-page sizes (the shape that would expose a short page mid-column). */
async function pageColumn(
  t: TestApp,
  params: Record<string, string | number | undefined>,
): Promise<{ ids: string[]; pageSizes: number[] }> {
  const ids: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await getColumn(t, { ...params, cursor });
    ids.push(...page.ids);
    pageSizes.push(page.ids.length);
    if (page.next_cursor === null) return { ids, pageSizes };
    cursor = page.next_cursor;
  }
  throw new Error('column did not terminate');
}

async function getCounts(
  t: TestApp,
  params: Record<string, string | number | undefined> = {},
): Promise<Record<TaskStatus, number>> {
  const res = await http(t).get(`/api/tasks/board/counts?${qs(params)}`);
  expect(res.status).toBe(200);
  return TaskBoardCountsDtoSchema.parse(await res.json()).counts;
}

async function getFacets(t: TestApp, raw = ''): Promise<{
  assignees: Array<{ type: string; id: string; name: string }>;
  creators: Array<{ type: string; id: string; name: string }>;
  has_unassigned: boolean;
}> {
  const res = await http(t).get(`/api/tasks/board/facets${raw}`);
  expect(res.status).toBe(200);
  return TaskBoardFacetsDtoSchema.parse(await res.json());
}

describe('task board cursor codec', () => {
  it('round-trips a keyset position', () => {
    const cursor = { taskNumber: 42, taskId: 'tk-0007' };
    expect(decodeTaskBoardCursor(encodeTaskBoardCursor(cursor))).toEqual(cursor);
  });

  it('rejects anything that is not a well-formed position', () => {
    const b64 = (v: unknown) =>
      Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
    // Not base64 / not JSON at all.
    expect(decodeTaskBoardCursor('!!!not-base64!!!')).toBeNull();
    // Well-formed base64url JSON of the WRONG shapes.
    expect(decodeTaskBoardCursor(b64({ taskNumber: 1, taskId: 'x' }))).toBeNull();
    expect(decodeTaskBoardCursor(b64([1]))).toBeNull();
    expect(decodeTaskBoardCursor(b64([1, 'x', 'extra']))).toBeNull();
    expect(decodeTaskBoardCursor(b64([1.5, 'x']))).toBeNull();
    expect(decodeTaskBoardCursor(b64(['1', 'x']))).toBeNull();
    expect(decodeTaskBoardCursor(b64([1, '']))).toBeNull();
    expect(decodeTaskBoardCursor(b64([1, 2]))).toBeNull();
  });
});

describe('GET /api/tasks/board/column', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('pages one status column by keyset, newest-first, ending exactly', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const ids = [1, 2, 3, 4, 5].map(n => insertTask(t!, { place, number: n }));

    const first = await getColumn(t, { status: 'todo', limit: 2 });
    expect(first.status).toBe('todo');
    // task_number DESC.
    expect(first.ids).toEqual([ids[4], ids[3]]);
    expect(first.next_cursor).not.toBeNull();

    const { ids: all, pageSizes } = await pageColumn(t, { status: 'todo', limit: 2 });
    expect(all).toEqual([...ids].reverse());
    // 2 + 2 + 1: the only short page is the last one.
    expect(pageSizes).toEqual([2, 2, 1]);
    // The exact-end probe: the final page already reported the end, so no
    // trailing empty request was needed to discover it.
    expect(all).toHaveLength(5);
  });

  it('wires each item\'s workspace / channel / conversation refs from its own row', async () => {
    // The per-item VALUE contract of `taskJoinedToSummary` — the ONE projection
    // shared by this column, the single-task detail read and the agent list. Its
    // risky fields are same-typed re-namings of one column
    // (`channel_id` and `conversation.id` both come from `tasks.conversation_id`),
    // so `TaskBoardColumnDtoSchema.parse` cannot catch a cross-wiring: only a
    // value assertion can. Kept at route level so the JOIN feeding the projection
    // is exercised too, which a hand-built-row unit test would not reach.
    // `assignee === null` for an unassigned row is also the upstream fact behind
    // the facets' `has_unassigned`.
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const id = insertTask(t, { place, number: 1 });

    const page = await getColumn(t, { status: 'todo' });
    // By id, never by position: `seedSeq` is module-global, so both `items[0]`
    // and a `tk-000N` literal shift when any earlier case seeds one more row.
    const item = page.items.find(i => i.id === id);
    expect(item, `column items: ${JSON.stringify(page.ids)}`).toBeDefined();
    // B4 (P0-f): placement coordinates live in the place union arm; the routing
    // coordinate is folded into place (no separate top-level channel_id).
    expect(item!.place).toMatchObject({
      kind: 'workspace',
      workspace_id: place.workspaceId,
      conversation_id: place.conversationId,
    });
    expect(item!).not.toHaveProperty('channel_id');
    expect(item!.status).toBe('todo');
    expect(item!.assignee).toBeNull();
  });

  it('keeps a total order when two workspaces share a task_number', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const a = await makePlace(t, t.viewerUserId, 'eng');
    const b = await makePlace(t, t.viewerUserId, 'design');
    // Deliberate collision: BOTH workspaces hold #1 and #2. A single-column
    // `task_number` keyset would either skip or re-deliver a row here.
    const a1 = insertTask(t, { place: a, number: 1 });
    const a2 = insertTask(t, { place: a, number: 2 });
    const b1 = insertTask(t, { place: b, number: 1 });
    const b2 = insertTask(t, { place: b, number: 2 });

    const { ids, pageSizes } = await pageColumn(t, { status: 'todo', limit: 1 });
    // (task_number DESC, id DESC) — b2 before a2 because seeding order is id
    // order; every row delivered exactly once.
    expect(ids).toEqual([b2, a2, b1, a1]);
    expect(new Set(ids).size).toBe(4);
    // Four single-row pages and no trailing empty one: the last page's own
    // probe already reported the end.
    expect(pageSizes).toEqual([1, 1, 1, 1]);

    // The narrowed board pages the same population minus the other workspace.
    const narrowed = await pageColumn(t, {
      status: 'todo',
      limit: 1,
      workspace_id: a.workspaceId,
    });
    expect(narrowed.ids).toEqual([a2, a1]);
  });

  it('pages each status independently', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const todo = [1, 3, 5].map(n => insertTask(t!, { place, number: n }));
    const doing = [2, 4].map(n =>
      insertTask(t!, { place, number: n, status: 'in_progress' }),
    );

    const todoPaged = await pageColumn(t, { status: 'todo', limit: 1 });
    expect(todoPaged.ids).toEqual([...todo].reverse());
    const doingPaged = await pageColumn(t, { status: 'in_progress', limit: 1 });
    expect(doingPaged.ids).toEqual([...doing].reverse());
    // No column ever leaks another column's rows, even though their numbers
    // interleave.
    expect(todoPaged.ids.some(id => doingPaged.ids.includes(id))).toBe(false);
  });

  it('rejects a malformed cursor instead of silently serving page 1', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    insertTask(t, { place, number: 1 });

    const res = await http(t).get('/api/tasks/board/column?status=todo&cursor=nope');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('invalid_cursor');
  });

  it('validates status, limit and the person-axis pairing', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    await makePlace(t, t.viewerUserId, 'eng');
    const h = http(t);
    expect((await h.get('/api/tasks/board/column')).status).toBe(400);
    expect((await h.get('/api/tasks/board/column?status=nope')).status).toBe(400);
    expect(
      (await h.get(`/api/tasks/board/column?status=todo&limit=${TASK_BOARD_MAX_LIMIT + 1}`))
        .status,
    ).toBe(400);
    // An id without its type (or a type that needs an id without one) is a
    // half-specified filter — refused, never silently ignored.
    expect(
      (await h.get('/api/tasks/board/column?status=todo&assignee_id=alice')).status,
    ).toBe(400);
    expect(
      (await h.get('/api/tasks/board/column?status=todo&assignee_type=agent')).status,
    ).toBe(400);
    expect(
      (await h.get('/api/tasks/board/column?status=todo&creator_type=user')).status,
    ).toBe(400);
    // `unassigned` is the one assignee type that takes no id.
    expect(
      (await h.get('/api/tasks/board/column?status=todo&assignee_type=unassigned'))
        .status,
    ).toBe(200);
  });
});

describe('task board — filters and visibility run before the window', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('never spends window slots on rows the viewer cannot see', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const mine = await makePlace(t, t.viewerUserId, 'eng');
    const theirs = await makePlace(t, 'teammate', 'their-eng');
    // Interleaved by task_number so a post-page visibility filter would eat
    // slots out of the FIRST window.
    const v3 = insertTask(t, { place: mine, number: 3 });
    insertTask(t, { place: theirs, number: 4 });
    const v2 = insertTask(t, { place: mine, number: 2 });
    insertTask(t, { place: theirs, number: 5 });
    const v1 = insertTask(t, { place: mine, number: 1 });

    const page = await getColumn(t, { status: 'todo', limit: 3 });
    // Full window of visible rows AND an exact end — both would break if the
    // gate ran after the LIMIT.
    expect(page.ids).toEqual([v3, v2, v1]);
    expect(page.next_cursor).toBeNull();

    // Counts and facets describe the SAME population.
    expect((await getCounts(t)).todo).toBe(3);
    const facets = await getFacets(t);
    expect(facets.creators.map(c => c.id)).toEqual([t.viewerUserId]);
  });

  it('narrows by channel, assignee (agent / user / unassigned) and creator', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const other = await makePlace(t, t.viewerUserId, 'ops');
    const agentId = await makeAgent(t, 'norman');
    const otherAgentId = await makeAgent(t, 'cindy');

    const byAgent = insertTask(t, {
      place,
      number: 1,
      assignee: { agentId },
      creator: { kind: 'agent', id: agentId },
    });
    const byOtherAgent = insertTask(t, {
      place,
      number: 2,
      assignee: { agentId: otherAgentId },
    });
    const byUser = insertTask(t, {
      place,
      number: 3,
      assignee: { userId: t.viewerUserId },
    });
    const unassigned = insertTask(t, { place, number: 4 });
    const elsewhere = insertTask(t, { place: other, number: 1 });

    expect(
      (await getColumn(t, { status: 'todo', channel_id: other.conversationId })).ids,
    ).toEqual([elsewhere]);
    expect(
      (await getColumn(t, { status: 'todo', assignee_type: 'agent', assignee_id: agentId }))
        .ids,
    ).toEqual([byAgent]);
    expect(
      (
        await getColumn(t, {
          status: 'todo',
          assignee_type: 'user',
          assignee_id: t.viewerUserId,
        })
      ).ids,
    ).toEqual([byUser]);
    expect((await getColumn(t, { status: 'todo', assignee_type: 'unassigned' })).ids).toEqual(
      [unassigned, elsewhere],
    );
    expect(
      (
        await getColumn(t, { status: 'todo', creator_type: 'agent', creator_id: agentId })
      ).ids,
    ).toEqual([byAgent]);
    // A creator filter for the OTHER agent matches nothing, even though that
    // agent is an assignee — the two axes are independent.
    expect(
      (
        await getColumn(t, {
          status: 'todo',
          creator_type: 'agent',
          creator_id: otherAgentId,
        })
      ).ids,
    ).toEqual([]);
    expect(byOtherAgent).toBeTruthy();
  });

  it('applies a filter inside the window, so pages stay full', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const agentId = await makeAgent(t, 'norman');
    const wanted: string[] = [];
    // Alternating population: unassigned rows sit between every matching pair.
    for (let n = 1; n <= 6; n += 1) {
      const id = insertTask(t, {
        place,
        number: n,
        ...(n % 2 === 0 ? { assignee: { agentId } } : {}),
      });
      if (n % 2 === 0) wanted.push(id);
    }

    const { ids, pageSizes } = await pageColumn(t, {
      status: 'todo',
      limit: 2,
      assignee_type: 'agent',
      assignee_id: agentId,
    });
    expect(ids).toEqual([...wanted].reverse());
    // Two FULL pages, then the exact end — never 2/1/... from post-page drops.
    expect(pageSizes).toEqual([2, 1]);
  });
});

describe('GET /api/tasks/board/counts', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('is total over every status and agrees with the paged columns', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const plan: Array<[TaskStatus, number]> = [
      ['todo', 3],
      ['in_progress', 2],
      ['in_review', 1],
      ['done', 0],
      ['closed', 4],
    ];
    let n = 0;
    for (const [status, count] of plan) {
      for (let i = 0; i < count; i += 1) insertTask(t, { place, number: ++n, status });
    }

    const counts = await getCounts(t);
    // Every status key is present — a client never reads "absent" as zero.
    expect(Object.keys(counts).sort()).toEqual([...TaskStatusSchema.options].sort());
    expect(counts.done).toBe(0);

    // The cross-falsifier: totals and the windows describe ONE population.
    for (const [status, expected] of plan) {
      expect(counts[status]).toBe(expected);
      const paged = await pageColumn(t, { status, limit: 2 });
      expect(paged.ids).toHaveLength(expected);
    }
  });

  it('honors the same filters as the window', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const a = await makePlace(t, t.viewerUserId, 'eng');
    const b = await makePlace(t, t.viewerUserId, 'ops');
    insertTask(t, { place: a, number: 1 });
    insertTask(t, { place: a, number: 2, status: 'done' });
    insertTask(t, { place: b, number: 1 });

    expect(await getCounts(t)).toMatchObject({ todo: 2, done: 1 });
    expect(await getCounts(t, { workspace_id: a.workspaceId })).toMatchObject({
      todo: 1,
      done: 1,
    });
    const narrowed = await getCounts(t, { workspace_id: a.workspaceId });
    const paged = await pageColumn(t, {
      status: 'todo',
      limit: 1,
      workspace_id: a.workspaceId,
    });
    expect(paged.ids).toHaveLength(narrowed.todo);
  });
});

describe('GET /api/tasks/board/facets', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('reports the whole visible population and ignores board filters', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const theirs = await makePlace(t, 'teammate', 'their-eng');
    const agentId = await makeAgent(t, 'norman');
    const hiddenAgentId = await makeAgent(t, 'ghost');

    insertTask(t, { place, number: 1, assignee: { agentId } });
    insertTask(t, {
      place,
      number: 2,
      assignee: { userId: t.viewerUserId },
      creator: { kind: 'agent', id: agentId },
    });
    insertTask(t, { place, number: 3 });
    // Same people, but in a conversation the viewer is not a member of.
    insertTask(t, {
      place: theirs,
      number: 1,
      assignee: { agentId: hiddenAgentId },
      creator: { kind: 'agent', id: hiddenAgentId },
    });

    const facets = await getFacets(t);
    // Menu order is by display name, not by type or insertion.
    expect(facets.assignees).toEqual([
      { type: 'user', id: t.viewerUserId, name: 'Local Test User' },
      { type: 'agent', id: agentId, name: 'norman' },
    ]);
    expect(facets.creators).toEqual([
      { type: 'user', id: t.viewerUserId, name: 'Local Test User' },
      { type: 'agent', id: agentId, name: 'norman' },
    ]);
    expect(facets.has_unassigned).toBe(true);
    // Nobody from the invisible conversation leaks into a menu.
    expect(JSON.stringify(facets)).not.toContain(hiddenAgentId);

    // A selected filter must NOT shrink the menu it was selected from,
    // otherwise the user cannot switch away from it.
    const withFilters = await getFacets(
      t,
      `?assignee_type=agent&assignee_id=${agentId}&workspace_id=${place.workspaceId}`,
    );
    expect(withFilters).toEqual(facets);
  });

  it('excludes system creators and degrades a deleted person to its id', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    // `system` = the creating agent/user row is gone; a property of the data,
    // not a selectable person.
    insertTask(t, { place, number: 1, creator: { kind: 'system' } });
    // The creator id columns carry no FK by design (immutable provenance), so
    // a creator whose agent row was deleted stays on the task.
    insertTask(t, { place, number: 2, creator: { kind: 'agent', id: 'agent-gone' } });

    const facets = await getFacets(t);
    expect(facets.creators).toEqual([{ type: 'agent', id: 'agent-gone', name: 'agent-gone' }]);
    expect(facets.assignees).toEqual([]);
    expect(facets.has_unassigned).toBe(true);
  });

  it('has_unassigned is false when every visible task has an assignee', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const theirs = await makePlace(t, 'teammate', 'their-eng');
    const agentId = await makeAgent(t, 'norman');
    insertTask(t, { place, number: 1, assignee: { agentId } });
    // Unassigned, but invisible — it must not turn the option on.
    insertTask(t, { place: theirs, number: 1 });

    expect((await getFacets(t)).has_unassigned).toBe(false);
  });
});

describe('task board — writes concurrent with paging', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('keyset paging neither skips nor re-delivers when the column changes', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    const ids = [1, 2, 3, 4].map(n => insertTask(t!, { place, number: n }));

    const first = await getColumn(t, { status: 'todo', limit: 2 });
    expect(first.ids).toEqual([ids[3], ids[2]]);
    const cursor = first.next_cursor;
    expect(cursor).not.toBeNull();

    // A newer task appears (sorts BEFORE the cursor) — it cannot shift the
    // remaining pages, which is exactly what an OFFSET pager would get wrong.
    const newer = insertTask(t, { place, number: 9 });
    // A row already delivered leaves the column; another is deleted outright.
    t.ctx.db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(ids[3]);
    t.ctx.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(ids[2]);

    const second = await getColumn(t, { status: 'todo', limit: 2, cursor: cursor! });
    expect(second.ids).toEqual([ids[1], ids[0]]);
    expect(second.next_cursor).toBeNull();
    expect(second.ids).not.toContain(newer);

    // A fresh pass sees the new state, still exactly once per row.
    const repaged = await pageColumn(t, { status: 'todo', limit: 2 });
    expect(repaged.ids).toEqual([newer, ids[1], ids[0]]);
  });
});

describe('task board — index access paths', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  // The gate: BOTH shipped board shapes must reach their rows through an
  // ordered index. A whole-column sort would make the "bounded read" claim
  // false at exactly the population size that motivated #task:1883.
  const planOf = (app: TestApp, sql: string, args: (string | number)[]): string =>
    (app.ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{
      detail: string;
    }>)
      .map(r => r.detail)
      .join('\n');

  it('serves the default cross-workspace column without a temp sort', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    insertTask(t, { place, number: 1 });

    const first = taskBoardColumnQuery({
      viewerUserId: t.viewerUserId,
      status: 'todo',
      limit: 20,
    });
    const firstPlan = planOf(t, first.sql, first.args);
    expect(firstPlan).toContain('idx_tasks_status_number');
    expect(firstPlan.toUpperCase()).not.toContain('TEMP B-TREE');

    // A later page must SEEK to the cursor, not re-walk the column head: the
    // `task_number` bound has to appear as an index constraint.
    const next = taskBoardColumnQuery({
      viewerUserId: t.viewerUserId,
      status: 'todo',
      limit: 20,
      cursor: { taskNumber: 5, taskId: 'tk-9999' },
    });
    const nextPlan = planOf(t, next.sql, next.args);
    expect(nextPlan).toContain('idx_tasks_status_number (status=? AND task_number<?)');
    expect(nextPlan.toUpperCase()).not.toContain('TEMP B-TREE');
  });

  it('serves the workspace-narrowed column without a temp sort', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const place = await makePlace(t, t.viewerUserId, 'eng');
    insertTask(t, { place, number: 1 });

    const query = taskBoardColumnQuery({
      viewerUserId: t.viewerUserId,
      workspaceId: place.workspaceId,
      status: 'todo',
      limit: 20,
      cursor: { taskNumber: 5, taskId: 'tk-9999' },
    });
    const plan = planOf(t, query.sql, query.args);
    expect(plan).toContain(
      'idx_tasks_workspace_status_number (workspace_id=? AND status=? AND task_number<?)',
    );
    expect(plan.toUpperCase()).not.toContain('TEMP B-TREE');
  });
});
