import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('GET /api/search', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns matching messages for a non-empty keyword', async () => {
    t = buildTestApp();
    const agent = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agent.agent.id],
      })
    ).json() as any;

    const message = await http(t).post(
      `/api/channels/${workspace.onboarding_channel_id}/messages`,
      { content: 'needle phrase for search' },
    );
    expect(message.status).toBe(201);

    const res = await http(t).get('/api/search?q=needle');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({
            content: 'needle phrase for search',
          }),
        }),
      ]),
    );
  });

  it('message hits expose reply-cluster roots separately from legacy thread ids', async () => {
    t = buildTestApp();
    const agent = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'eng-thread-search',
        member_agent_ids: [agent.agent.id],
      })
    ).json() as any;
    const root = await (
      await http(t).post(`/api/channels/${workspace.onboarding_channel_id}/messages`, {
        content: 'root for search cluster',
      })
    ).json() as any;
    const reply = await (
      await http(t).post(`/api/channels/${workspace.onboarding_channel_id}/messages`, {
        content: 'needle-thread-search reply',
        reply_to_message_id: root.message.id,
      })
    ).json() as any;

    const res = await http(t).get('/api/search?q=needle-thread-search');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          conversation: expect.objectContaining({
            channel_id: workspace.onboarding_channel_id,
          }),
          message: expect.objectContaining({
            id: reply.message.id,
            thread_root_id: root.message.id,
          }),
        }),
      ]),
    );
  });

  it('searches workspace names without using legacy channel aliases', async () => {
    t = buildTestApp();
    await http(t).post('/api/workspaces', {
      name: 'needle-workspace',
      description: 'engineering',
    });

    const res = await http(t).get('/api/search?q=needle-workspace');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'workspace',
          workspace: expect.objectContaining({
            name: 'needle-workspace',
          }),
        }),
      ]),
    );
  });

  it('filters messages and named entities by viewer membership', async () => {
    t = buildTestApp();
    const agent = await (
      await http(t).post('/api/agents', { name: 'search-agent', runtime: 'claude' })
    ).json() as any;
    const visible = await (
      await http(t).post('/api/workspaces', {
        name: 'visible-needle-ws',
        member_agent_ids: [agent.agent.id],
      })
    ).json() as any;
    const hidden = await (
      await http(t).post('/api/workspaces', {
        name: 'hidden-needle-ws',
        member_agent_ids: [agent.agent.id],
      })
    ).json() as any;
    await http(t).post(`/api/channels/${visible.onboarding_channel_id}/messages`, {
      content: 'needle visible message',
    });
    await http(t).post(`/api/channels/${hidden.onboarding_channel_id}/messages`, {
      content: 'needle hidden message',
    });
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`)
      .run(hidden.onboarding_channel_id);
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = 'local'`)
      .run(hidden.workspace.id);

    const res = await http(t).get('/api/search?q=needle');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const serialized = JSON.stringify(body.results);
    expect(serialized).toContain('visible-needle-ws');
    expect(serialized).toContain('needle visible message');
    expect(serialized).not.toContain('hidden-needle-ws');
    expect(serialized).not.toContain('needle hidden message');
  });
});

// In-stream scoped find (#task:1334): stream filter + seq_asc order +
// total/truncated + the fail-loud combination guards. The whole point is
// that a mainline-scoped search never returns thread replies (which render
// in a separate panel) and vice-versa — "搜到必可见".
describe('GET /api/search — stream scope (#task:1334)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  // Builds a channel with: two mainline messages + one thread reply under the
  // first, all carrying the same unique keyword. Returns the ids.
  async function seedStreamFixture(app: TestApp): Promise<{
    channelId: string;
    rootId: string;
    otherMainId: string;
    replyId: string;
  }> {
    const agent = await (
      await http(app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const ws = await (
      await http(app).post('/api/workspaces', {
        name: 'stream-scope-ws',
        member_agent_ids: [agent.agent.id],
      })
    ).json() as any;
    const channelId = ws.onboarding_channel_id as string;
    const root = await (
      await http(app).post(`/api/channels/${channelId}/messages`, {
        content: 'zqkw root mainline',
      })
    ).json() as any;
    const reply = await (
      await http(app).post(`/api/channels/${channelId}/messages`, {
        content: 'zqkw reply in thread',
        reply_to_message_id: root.message.id,
      })
    ).json() as any;
    const otherMain = await (
      await http(app).post(`/api/channels/${channelId}/messages`, {
        content: 'zqkw other mainline',
      })
    ).json() as any;
    return {
      channelId,
      rootId: root.message.id,
      otherMainId: otherMain.message.id,
      replyId: reply.message.id,
    };
  }

  it('mainline scope returns mainline messages and excludes thread replies', async () => {
    t = buildTestApp();
    const f = await seedStreamFixture(t);
    const res = await http(t).get(
      `/api/search?q=zqkw&conversation_id=${f.channelId}&stream=mainline&order=seq_asc`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ids = body.results.map((r: any) => r.message.id);
    // root + otherMain (both thread_root_id IS NULL), never the reply.
    expect(ids).toEqual([f.rootId, f.otherMainId]);
    expect(ids).not.toContain(f.replyId);
    expect(body.total).toBe(2);
    expect(body.truncated).toBe(false);
    // messages-only: conversation-scoped search suppresses entity results.
    expect(body.results.every((r: any) => r.type === 'message')).toBe(true);
  });

  it('thread scope returns the root + its replies and excludes other mainline', async () => {
    t = buildTestApp();
    const f = await seedStreamFixture(t);
    const res = await http(t).get(
      `/api/search?q=zqkw&conversation_id=${f.channelId}&stream=thread&thread_root_id=${f.rootId}&order=seq_asc`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ids = body.results.map((r: any) => r.message.id);
    // cluster predicate = (id = root OR thread_root_id = root): the root
    // message itself plus its reply, in seq order; not the unrelated mainline.
    expect(ids).toEqual([f.rootId, f.replyId]);
    expect(ids).not.toContain(f.otherMainId);
    expect(body.total).toBe(2);
  });

  it('normalizes a reply id passed as thread_root_id to its root cluster', async () => {
    t = buildTestApp();
    const f = await seedStreamFixture(t);
    // Passing the REPLY id as the anchor must resolve to the same thread.
    const res = await http(t).get(
      `/api/search?q=zqkw&conversation_id=${f.channelId}&stream=thread&thread_root_id=${f.replyId}&order=seq_asc`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ids = body.results.map((r: any) => r.message.id);
    expect(ids).toEqual([f.rootId, f.replyId]);
  });

  it('404s a thread_root_id that is not in the scoped conversation', async () => {
    t = buildTestApp();
    const f = await seedStreamFixture(t);
    const other = await (
      await http(t).post('/api/workspaces', { name: 'other-ws' })
    ).json() as any;
    const foreign = await (
      await http(t).post(`/api/channels/${other.onboarding_channel_id}/messages`, {
        content: 'foreign root',
      })
    ).json() as any;
    const res = await http(t).get(
      `/api/search?q=zqkw&conversation_id=${f.channelId}&stream=thread&thread_root_id=${foreign.message.id}`,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.code).toBe('thread_root_not_found');
  });

  it('scopes matches to the given conversation only (root-alias fix)', async () => {
    t = buildTestApp();
    const f = await seedStreamFixture(t);
    const other = await (
      await http(t).post('/api/workspaces', { name: 'other-scope-ws' })
    ).json() as any;
    await http(t).post(`/api/channels/${other.onboarding_channel_id}/messages`, {
      content: 'zqkw in another conversation',
    });
    const res = await http(t).get(
      `/api/search?q=zqkw&conversation_id=${f.channelId}&order=seq_asc`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const convIds = new Set(
      body.results.map((r: any) => r.conversation.channel_id),
    );
    expect([...convIds]).toEqual([f.channelId]);
  });

  it('rejects seq_asc without conversation_id (seq is per-conversation)', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/search?q=zqkw&order=seq_asc');
    expect(res.status).toBe(400);
  });

  it('rejects a stream filter without conversation_id', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/search?q=zqkw&stream=mainline');
    expect(res.status).toBe(400);
  });

  it('rejects stream=thread without thread_root_id', async () => {
    t = buildTestApp();
    const f = await seedStreamFixture(t);
    const res = await http(t).get(
      `/api/search?q=zqkw&conversation_id=${f.channelId}&stream=thread`,
    );
    expect(res.status).toBe(400);
  });

  it('reports truncated + caps results when matches exceed the limit', async () => {
    t = buildTestApp();
    const f = await seedStreamFixture(t);
    // 3 mainline matches exist (root + otherMain + ... actually 2 mainline);
    // add one more mainline match then cap at 2 to force truncation.
    await http(t).post(`/api/channels/${f.channelId}/messages`, {
      content: 'zqkw third mainline',
    });
    const res = await http(t).get(
      `/api/search?q=zqkw&conversation_id=${f.channelId}&stream=mainline&order=seq_asc&limit=2`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results.length).toBe(2);
    expect(body.truncated).toBe(true);
    // total is the true match count over the same WHERE (3 mainline matches),
    // not the returned count — that's the whole point of the field name.
    expect(body.total).toBe(3);
  });

  it('returns empty (not a 404 existence oracle) for thread search in an invisible conversation', async () => {
    t = buildTestApp();
    const f = await seedStreamFixture(t);
    // Drop the viewer's membership so the conversation is no longer visible.
    t.ctx.db
      .prepare(
        `DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`,
      )
      .run(f.channelId);
    // A real, correctly-belonging root — but the viewer can't see the
    // conversation. Must look identical to "no matches" (200 empty), never a
    // 404 that would confirm the root exists in that conversation.
    const res = await http(t).get(
      `/api/search?q=zqkw&conversation_id=${f.channelId}&stream=thread&thread_root_id=${f.rootId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.truncated).toBe(false);
  });
});

// The container POPULATION on the workspace-DISCOVERY arm (#task:2068 →
// #task:2075).
//
// This arm used to be the compiler-invisible one: a scope token was bound as a
// SQL PARAMETER against the `search_ws` subquery's already-projected container
// word, and nothing about that comparison was typed — if the projected word and
// the scope alphabet drifted apart the query would simply match no row and
// return empty instead of failing. #task:2075's stop-publish step deleted BOTH
// sides of it (the projection and the token's kind members), so the drift these
// cells guarded cannot exist any more.
//
// What still needs pinning is the POPULATION plus the fact that replaced the
// word: both container kinds are discoverable through this arm, and each carries
// the ownership arc. NON-EMPTY per kind is the load-bearing half — a cell that
// only asserts exclusions stays green when a query matches nothing at all.
describe('GET /api/search — container population on the discovery arm', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const NEEDLE = 'kindproj';
  const REGULAR_NAME = `${NEEDLE}-regular-ws`;
  // An agent home's workspace name mirrors the agent's name (`insertAgentHome`
  // binds `agent.name`), and the creating user is stamped as its
  // `workspace_users` OWNER — which is what makes it reachable through the
  // membership gate this arm applies.
  const AGENT_NAME = `${NEEDLE}-agent`;

  async function seed(app: TestApp): Promise<{ agentId: string }> {
    await http(app).post('/api/workspaces', { name: REGULAR_NAME });
    const res = await http(app).post('/api/agents', {
      name: AGENT_NAME,
      runtime: 'claude',
    });
    const body = await res.json() as { agent: { id: string } };
    return { agentId: body.agent.id };
  }

  async function workspaceHits(
    app: TestApp,
  ): Promise<{ name: string; owner_agent_id: string | null }[]> {
    const res = await http(app).get(`/api/search?q=${NEEDLE}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    return body.results
      .filter((r: any) => r.type === 'workspace')
      .map((r: any) => ({
        name: r.workspace.name,
        owner_agent_id: r.workspace.owner_agent_id,
      }));
  }

  it('discovers both container kinds, each carrying its ownership arc', async () => {
    t = buildTestApp();
    const { agentId } = await seed(t);
    const hits = await workspaceHits(t);
    // A producer that copied the wrong column would still be non-empty here, so
    // the arc VALUE is asserted per row rather than only its presence.
    expect(hits).toEqual(
      expect.arrayContaining([
        { name: REGULAR_NAME, owner_agent_id: null },
        { name: AGENT_NAME, owner_agent_id: agentId },
      ]),
    );
  });

  it('strips a retired scope token — the container axis is gone, not narrowable', async () => {
    t = buildTestApp();
    const { agentId } = await seed(t);
    const res = await http(t).get(`/api/search?q=${NEEDLE}&scope=dm`);
    // `scope` was a whole container-scope axis (`SearchScopeSchema =
    // z.enum(['all','regular','dm'])` on `origin/main`); #task:2086 deleted the
    // axis entirely — the fact it narrowed on is already carried by the concrete
    // `workspace_id`/`conversation_id` coordinate. `dm` is one of its two
    // published, now-retired members (`b17cd14a:message.ts:439`); we probe it
    // rather than a never-published spelling like `agent_space` so this cell
    // exercises the real contract change (a PUBLISHED dead token is dropped), not
    // merely "an unknown param is stripped", which holds for any client.
    //
    // Stripping it is safe by PRODUCER REACHABILITY, not by the epoch gate: no
    // published renderer sends a container token at all
    // — `SearchPanel.tsx` only ever builds `scope:'all'` (`:887`/`:889`) and
    // `hooks.ts:35` emits the param only `if (filters.scope !== 'all')`. Zero
    // senders ⇒ the shift from a narrowing to a full-population answer is
    // unobservable to every released client, independent of the epoch gate.
    // (This generation raises `MINIMUM_CLIENT_API_EPOCH` and would refuse the
    // last published desktop outright, but the strip is safe even setting that
    // aside — that published renderer never sends a container token in the first
    // place.) The input schema is non-strict, so the stray token is
    // STRIPPED, not parsed as a narrowing: the request is served by concrete
    // coordinate (here none) and returns the full discovery population. A future
    // container-population filter arrives as a NEW token, never a revival.
    expect(res.status).toBe(200);
    const hits = ((await res.json()) as any).results
      .filter((r: any) => r.type === 'workspace')
      .map((r: any) => ({
        name: r.workspace.name,
        owner_agent_id: r.workspace.owner_agent_id,
      }));
    expect(hits).toEqual(
      expect.arrayContaining([
        { name: REGULAR_NAME, owner_agent_id: null },
        { name: AGENT_NAME, owner_agent_id: agentId },
      ]),
    );
  });
});
