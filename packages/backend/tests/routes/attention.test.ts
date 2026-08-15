import { afterEach, describe, expect, it } from 'vitest';
import { fixedConversationTitle } from '@silverhand/shared';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
): Promise<{ workspaceId: string; channelId: string }> {
  const agentId = await makeAgent(t, 'alice');
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: 'ws-attention',
      member_agent_ids: [agentId],
    })
  ).json()) as any;
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
  };
}

/**
 * The channel's STORED tier, read the ONLY way it can be read (#task:1876): off
 * the tiers batch. There is no per-channel GET — it would be a second carrier of
 * the same fact — so these cells assert the write through the batch, which is
 * also what the renderer does.
 */
async function storedMode(
  t: TestApp,
  workspaceId: string,
  channelId: string,
): Promise<unknown> {
  const res = await http(t).get(
    `/api/attention/modes?workspace_id=${workspaceId}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return body.channels.find((row: any) => row.conversation_id === channelId)?.mode;
}

describe('channel attention preference routes (#task:1227 ②a)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('the tiers batch resolves the channel default (ambient on = all) when unset', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);

    // The default is applied server-side (§6 channel default = ambient on), so
    // the read is always a resolved tier — the client never branches on "unset".
    expect(await storedMode(t, workspaceId, channelId)).toBe('all');
  });

  it('PUT upserts the mode and the batch reads it back (round-trip)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);

    const put = await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'all' },
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ conversation_id: channelId, mode: 'all' });

    expect(await storedMode(t, workspaceId, channelId)).toBe('all');

    // Idempotent + reversible: set back to mentions.
    const put2 = await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'mentions' },
    );
    expect(await put2.json()).toEqual({ conversation_id: channelId, mode: 'mentions' });
    expect(await storedMode(t, workspaceId, channelId)).toBe('mentions');
  });

  it('emits the two viewer frames and still NOT unread_updated — the raw roll-up is pref-independent (§8)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const viewerEvents: { kind: string; payload: any }[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e => {
      viewerEvents.push({ kind: e.kind, payload: e.payload });
    });

    await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'all' },
    );
    unsub();

    // The negative is the original contract and still holds: a tier write does
    // not change any unread count, which is why the badge got its own frame
    // instead of redefining `unread_updated` (#task:1870).
    expect(viewerEvents.map(e => e.kind)).not.toContain('unread_updated');
    expect(
      viewerEvents.find(e => e.kind === 'attention_pref_changed')?.payload,
    ).toEqual({ workspace_id: workspaceId, conversation_id: channelId });
    expect(
      viewerEvents.find(e => e.kind === 'attention_badge_updated')?.payload,
    ).toEqual({ workspace_id: workspaceId, badge_count: 0 });
  });

  it('PUT rejects an invalid mode with 400', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t);

    const res = await http(t).put(
      `/api/conversations/${channelId}/attention-preference`,
      { mode: 'loud' },
    );
    expect(res.status).toBe(400);
  });

  it('404s for non-regular-channel conversations (dm_channel)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const conversations = new ConversationRepo(t.ctx.db);
    const dm = conversations.insertDmChannel({
      workspaceId,
      title: fixedConversationTitle('dm'),
    });

    // A DM's unread is directed-grade (always enters, §5.1) — it has no
    // channel ambient preference.
    for (const id of [dm.id]) {
      const put = await http(t).put(
        `/api/conversations/${id}/attention-preference`,
        { mode: 'all' },
      );
      expect(put.status).toBe(404);
    }
    // …and it is absent from the read face too, so "no ambient preference" is
    // one answer rather than a 404 here and a row there.
    expect(await storedMode(t, workspaceId, dm.id)).toBeUndefined();
  });

  it('DB trigger rejects a pref on a dm_channel (fail-loud backstop)', async () => {
    t = buildTestApp();
    const { workspaceId, channelId } = await createWorkspaceChannel(t);
    const conversations = new ConversationRepo(t.ctx.db);
    const dm = conversations.insertDmChannel({
      workspaceId,
      title: fixedConversationTitle('dm'),
    });

    const insert = t.ctx.db.prepare(
      `INSERT INTO channel_attention_preferences
         (user_id, conversation_id, mode, updated_at)
       VALUES (?, ?, 'all', 1)`,
    );
    // A regular channel is accepted; the non-channel kinds abort.
    expect(() => insert.run('local', channelId)).not.toThrow();
    expect(() => insert.run('local', dm.id)).toThrow(/regular channel/);
  });

  it('404s for an unknown conversation id', async () => {
    t = buildTestApp();
    await createWorkspaceChannel(t);

    const res = await http(t).put(
      `/api/conversations/does-not-exist/attention-preference`,
      { mode: 'all' },
    );
    expect(res.status).toBe(404);
  });
});

// The WORKSPACE-scoped suppressor above the per-channel tier (#task:1870 A1).
// A boolean, not a fourth tier: it silences every channel in the workspace
// without rewriting any of their stored tiers, which is what makes un-muting
// lossless and the whole feature backfill-free.
describe('workspace attention preference routes (#task:1870 A1)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('GET resolves the default (muted: false) when unset', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWorkspaceChannel(t);

    const res = await http(t).get(
      `/api/workspaces/${workspaceId}/attention-preference`,
    );
    expect(res.status).toBe(200);
    // Resolved server-side, so the client never branches on "unset".
    expect(await res.json()).toEqual({ workspace_id: workspaceId, muted: false });
  });

  it('PUT round-trips, is idempotent, and reverses cleanly', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWorkspaceChannel(t);
    const path = `/api/workspaces/${workspaceId}/attention-preference`;

    const put = await http(t).put(path, { muted: true });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ workspace_id: workspaceId, muted: true });
    expect(await (await http(t).get(path)).json()).toEqual({
      workspace_id: workspaceId,
      muted: true,
    });

    const again = await http(t).put(path, { muted: true });
    expect(await again.json()).toEqual({ workspace_id: workspaceId, muted: true });

    const off = await http(t).put(path, { muted: false });
    expect(await off.json()).toEqual({ workspace_id: workspaceId, muted: false });
    expect(await (await http(t).get(path)).json()).toEqual({
      workspace_id: workspaceId,
      muted: false,
    });
  });

  it('PUT rejects a non-boolean body with 400', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWorkspaceChannel(t);

    expect(
      (await http(t).put(`/api/workspaces/${workspaceId}/attention-preference`, {
        muted: 'yes',
      })).status,
    ).toBe(400);
    expect(
      (await http(t).put(`/api/workspaces/${workspaceId}/attention-preference`, {})).status,
    ).toBe(400);
  });

  it('404s for an agent_home workspace on BOTH verbs', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'homey');
    const home = t.ctx.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM workspaces
          WHERE workspace_kind = 'agent_home' AND owner_agent_id = ?`,
      )
      .get(agentId);
    expect(home).toBeTruthy();

    // An agent_home IS a DM: its unread is directed-grade and structurally
    // un-mutable, so the route refuses it rather than returning a `muted: false`
    // the client could then try to flip.
    const path = `/api/workspaces/${home!.id}/attention-preference`;
    expect((await http(t).get(path)).status).toBe(404);
    expect((await http(t).put(path, { muted: true })).status).toBe(404);
  });

  it('404s for an unknown workspace id', async () => {
    t = buildTestApp();
    await createWorkspaceChannel(t);

    const path = '/api/workspaces/does-not-exist/attention-preference';
    expect([403, 404]).toContain((await http(t).get(path)).status);
  });

  it('DB trigger rejects a suppressor row on a non-regular workspace (fail-loud backstop)', async () => {
    t = buildTestApp();
    const { workspaceId } = await createWorkspaceChannel(t);
    const agentId = await makeAgent(t, 'homey2');
    const home = t.ctx.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM workspaces
          WHERE workspace_kind = 'agent_home' AND owner_agent_id = ?`,
      )
      .get(agentId);

    const insert = t.ctx.db.prepare(
      `INSERT INTO workspace_attention_preferences
         (user_id, workspace_id, muted, updated_at)
       VALUES (?, ?, 1, 1)`,
    );
    // The route is not the only possible writer, so the invariant is also a
    // trigger: a regular workspace is accepted, an agent_home aborts.
    expect(() => insert.run('local', workspaceId)).not.toThrow();
    expect(() => insert.run('local', home!.id)).toThrow(/regular workspace/);
  });
});
