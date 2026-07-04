import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  conversationSideScope,
  encodeUserPrincipalHeader,
  readRenameMetadata,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  const body = await r.json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return body.agent.id;
}

describe('POST /api/workspaces', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creates workspace + directory + onboarding channel + auto-spawns members', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const bobId = await makeAgent(t, 'bob');

    const res = await http(t).post('/api/workspaces', {
      name: 'eng',
      description: 'engineering',
      member_agent_ids: [aliceId, bobId],
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.workspace.name).toBe('eng');
    expect(body.workspace.workspace_kind).toBe('regular');
    expect(typeof body.onboarding_channel_id).toBe('string');
    expect(body.channel.kind).toBe('channel');

    await expect(
      fs.stat(join(body.workspace.workspace_path, '.silverhand', 'CONSENSUS.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(
      (
        await fs.stat(join(body.workspace.workspace_path, '.silverhand', 'agents'))
      ).isDirectory(),
    ).toBe(true);

    expect(t.fake.starts.map(s => s.agentId).sort()).toEqual([aliceId, bobId].sort());
    expect(t.fake.delivered).toHaveLength(2);
    expect(t.fake.delivered.every(d => d.conversationId === body.onboarding_channel_id))
      .toBe(true);
    const msgs = await (
      await http(t).get(`/api/channels/${body.onboarding_channel_id}/messages`)
    ).json() as any;
    const onboardingMessages = msgs.messages.filter(
      (m: any) => m.metadata?.subtype === 'onboarding',
    );
    expect(onboardingMessages).toHaveLength(2);
    // Workspace onboarding: tell the agent role is auto-loaded from L1 and
    // workspace-scoped collaboration goes into THIS workspace's MEMORY/notes.
    expect(onboardingMessages[0].content).toContain(
      'just joined workspace',
    );
    expect(onboardingMessages[0].content).toContain('auto-loaded above');
    expect(onboardingMessages[0].content).toContain('Active Workspace Memory');
    // Scope rule: global → L1 system_prompt.md, workspace-scoped → L2.
    // Drift guard for R1: must NOT contain "DM-only / redirect-to-DM"
    // wording — that restriction was retracted.
    expect(onboardingMessages[0].content).toContain('write by scope');
    expect(onboardingMessages[0].content).toContain('L1 system_prompt.md');
    expect(onboardingMessages[0].content).toContain('L2 MEMORY.md');
    expect(onboardingMessages[0].content).not.toMatch(/redirect them to your DM/i);
    expect(onboardingMessages[0].content).not.toMatch(/do NOT modify your global system_prompt\.md/i);

    const members = await (
      await http(t).get(`/api/workspaces/${body.workspace.id}/members`)
    ).json() as any;
    expect(members.members.map((m: any) => m.id).sort()).toEqual(
      [aliceId, bobId].sort(),
    );
  });

  it('rejects invalid and duplicate workspace names', async () => {
    t = buildTestApp();
    expect((await http(t).post('/api/workspaces', { name: 'has spaces' })).status)
      .toBe(400);
    expect((await http(t).post('/api/workspaces', { name: 'eng' })).status)
      .toBe(201);
    expect((await http(t).post('/api/workspaces', { name: 'eng' })).status)
      .toBe(409);
  });
});

describe('workspace metadata and membership routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('renames a workspace and broadcasts into open channels', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const created = await (
      await http(t).post('/api/workspaces', {
        name: 'old',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    t.fake.delivered = [];

    const res = await http(t).patch(`/api/workspaces/${created.workspace.id}`, {
      name: 'newname',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workspace.name).toBe('newname');

    const msgs = await (
      await http(t).get(`/api/channels/${created.onboarding_channel_id}/messages`)
    ).json() as any;
    const renameMsg = msgs.messages.find((m: any) => m.metadata?.subtype === 'rename');
    expect(renameMsg).toBeTruthy();
    expect(renameMsg.metadata.old_name).toBe('old');
    expect(renameMsg.metadata.new_name).toBe('newname');
    // PR-6 producer round-trip: rename metadata must satisfy
    // RenameMetadataSchema so the renderer can draw a structured
    // audit row without re-parsing message.content.
    const renameParsed = readRenameMetadata(renameMsg.metadata);
    expect(renameParsed).not.toBeNull();
    expect(renameParsed!.old_name).toBe('old');
    expect(renameParsed!.new_name).toBe('newname');
    expect(renameParsed!.scope).toBe('workspace');
    expect(t.fake.delivered.some(d => d.messageId === renameMsg.id)).toBe(true);
  });

  it('does not allow workspace_path mutation after creation', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/workspaces', { name: 'immutable-path' })
    ).json() as any;
    const res = await http(t).patch(`/api/workspaces/${created.workspace.id}`, {
      workspace_path: '/tmp/other',
    });
    expect(res.status).toBe(400);
  });

  it('stars and unstars regular workspaces (per-viewer sort state)', async () => {
    t = buildTestApp();
    const first = await (
      await http(t).post('/api/workspaces', { name: 'star-first' })
    ).json() as any;
    const second = await (
      await http(t).post('/api/workspaces', { name: 'star-second' })
    ).json() as any;

    // Star returns the FULL viewer_sort for the list (not a single entry, not
    // the workspace DTO) — star is per-viewer view state, not an entity field.
    const star = await http(t).post(`/api/workspaces/${first.workspace.id}/star`);
    expect(star.status).toBe(200);
    const starred = await star.json() as any;
    expect(starred.viewer_sort.list_key).toBe('workspaces');
    expect(
      starred.viewer_sort.entries.find((e: any) => e.entity_id === first.workspace.id)?.starred_at,
    ).toBeTruthy();

    expect(
      (await http(t).post(`/api/workspaces/${second.workspace.id}/star`)).status,
    ).toBe(200);

    const unstar = await http(t).del(`/api/workspaces/${first.workspace.id}/star`);
    expect(unstar.status).toBe(200);
    const unstarred = await unstar.json() as any;
    expect(
      unstarred.viewer_sort.entries.find(
        (e: any) => e.entity_id === first.workspace.id,
      )?.starred_at ?? null,
    ).toBeNull();
  });

  it('rejects starring archived workspaces', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/workspaces', { name: 'archived-star' })
    ).json() as any;
    const archive = await http(t).patch(
      `/api/workspaces/${created.workspace.id}/archive`,
      { archived: true },
    );
    expect(archive.status).toBe(200);

    // Archived workspaces are out of the sorting scope → not in the live set.
    expect(
      (await http(t).post(`/api/workspaces/${created.workspace.id}/star`)).status,
    ).toBe(404);
    expect(
      (await http(t).del(`/api/workspaces/${created.workspace.id}/star`)).status,
    ).toBe(404);
  });

  it('adds and removes workspace members', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'ops' })
    ).json() as any;
    const agentId = await makeAgent(t, 'carol');

    const add = await http(t).post(
      `/api/workspaces/${workspace.workspace.id}/members`,
      { agent_id: agentId },
    );
    expect(add.status).toBe(201);
    const taggedAdd = await http(t).post(
      `/api/workspaces/${workspace.workspace.id}/members`,
      { kind: 'agent', agent_id: agentId },
    );
    expect(taggedAdd.status).toBe(201);
    const list1 = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/members`)
    ).json() as any;
    expect(list1.members.map((m: any) => m.id)).toContain(agentId);
    expect(list1.human_members.map((m: any) => m.id)).toContain('local');
    expect(list1.viewer_role).toBe('owner');
    expect(list1.human_members.find((m: any) => m.id === 'local')).toMatchObject({
      workspace_id: workspace.workspace.id,
      user_id: 'local',
      role: 'owner',
    });

    const firstChannel = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'ops-room',
        member_agent_ids: [agentId],
      })
    ).json() as any;
    const secondChannel = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'ops-room-2',
        member_agent_ids: [agentId],
      })
    ).json() as any;
    const channelIds = [firstChannel.channel.id, secondChannel.channel.id];
    t.fake.stops = [];
    const conversationEvents = new Map<string, Array<{ kind: string; payload: unknown }>>(
      channelIds.map(channelId => [channelId, []]),
    );
    const unsubConversations = channelIds.flatMap(channelId => [
      // Stage-2 P2: `message` rides the compat conversation emitter;
      // `conversation_members_changed` moved to the side-channel scope. Capture
      // both into the same per-channel array.
      t!.ctx.events.subscribe(channelId, e => {
        conversationEvents.get(channelId)!.push({ kind: e.kind, payload: e.payload });
      }),
      t!.ctx.events.subscribeScope(conversationSideScope(channelId), e => {
        conversationEvents.get(channelId)!.push({ kind: e.kind, payload: e.payload });
      }),
    ]);
    const workspaceEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubWorkspace = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );
    let removeStatus = 0;
    try {
      const rm = await http(t).del(
        `/api/workspaces/${workspace.workspace.id}/members/${agentId}`,
      );
      removeStatus = rm.status;
    } finally {
      unsubConversations.forEach(unsub => unsub());
      unsubWorkspace();
    }
    expect(removeStatus).toBe(204);
    expect(t.fake.stops).toEqual(expect.arrayContaining(
      channelIds.map(channelId => ({
        conversationId: channelId,
        agentId,
        mode: 'hard',
      })),
    ));
    for (const channelId of channelIds) {
      const events = conversationEvents.get(channelId) ?? [];
      const memberRemovedMessage = events.find(e => e.kind === 'message');
      expect((memberRemovedMessage?.payload as any)?.message).toMatchObject({
        from_kind: 'system',
        content: '@local-test removed @carol from this conversation.',
        metadata: {
          subtype: 'conversation_member_removed',
          actor_kind: 'user',
          actor_id: 'local',
          actor_name: 'local-test',
          member_kind: 'agent',
          member_id: agentId,
          member_name: 'carol',
        },
      });
      expect(events).toContainEqual({
        kind: 'conversation_members_changed',
        payload: {
          conversation_id: channelId,
          workspace_id: workspace.workspace.id,
        },
      });
      expect(workspaceEvents).toContainEqual({
        kind: 'workspace_channels_changed',
        payload: {
          workspace_id: workspace.workspace.id,
          channel_id: channelId,
        },
      });
    }
    const list2 = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/members`)
    ).json() as any;
    expect(list2.members.map((m: any) => m.id)).not.toContain(agentId);
  });

  it('adds human workspace members and returns them from the member list', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'humans' })
    ).json() as any;
    // The test fixture mirrors every fixture user into new workspaces.
    // Delete one row first so this route proves it can insert humans too.
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(workspace.workspace.id, 'teammate');

    const before = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/members`)
    ).json() as any;
    expect(before.human_members.map((m: any) => m.id)).not.toContain('teammate');
    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeViewer = t.ctx.events.subscribeScope('viewer:teammate', event => {
      viewerEvents.push({ kind: event.kind, payload: event.payload });
    });

    try {
      const add = await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/members`,
        { kind: 'human', user_id: 'teammate' },
      );
      expect(add.status).toBe(201);
      const addBody = await add.json() as any;
      expect(addBody.member).toMatchObject({
        workspace_id: workspace.workspace.id,
        user_id: 'teammate',
        role: 'member',
      });
      expect(addBody.human_member).toMatchObject({
        id: 'teammate',
        name: 'teammate-test',
        display_name: 'Teammate',
        workspace_id: workspace.workspace.id,
        user_id: 'teammate',
        role: 'member',
      });
      expect(viewerEvents).toEqual([
        {
          kind: 'viewer_workspaces_changed',
          payload: {
            change: 'added',
            workspace_id: workspace.workspace.id,
            role: 'member',
          },
        },
      ]);

      const duplicate = await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/members`,
        { kind: 'human', user_id: 'teammate' },
      );
      expect(duplicate.status).toBe(201);
      // `viewer_workspaces_changed` is a real-change event, not an
      // idempotent write echo: duplicate add must not republish.
      expect(viewerEvents).toHaveLength(1);
    } finally {
      unsubscribeViewer();
    }

    const after = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/members`)
    ).json() as any;
    expect(after.human_members.map((m: any) => m.id)).toContain('teammate');
    expect(after.viewer_role).toBe('owner');
    expect(after.human_members.find((m: any) => m.id === 'teammate')).toMatchObject({
      id: 'teammate',
      user_id: 'teammate',
      workspace_id: workspace.workspace.id,
      role: 'member',
      display_name: 'Teammate',
    });
  });

  it('lets workspace admins add human workspace members', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'humans-admin-add' })
    ).json() as any;
    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'admin' WHERE workspace_id = ? AND user_id = ?`)
      .run(workspace.workspace.id, 'local');
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(workspace.workspace.id, 'teammate');

    const add = await http(t).post(
      `/api/workspaces/${workspace.workspace.id}/members`,
      { kind: 'human', user_id: 'teammate' },
    );

    expect(add.status).toBe(201);
    const body = await add.json() as any;
    expect(body.member).toMatchObject({
      workspace_id: workspace.workspace.id,
      user_id: 'teammate',
      role: 'member',
    });
  });

  it('returns the current viewer role from the workspace membership edge', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'viewer-role' })
    ).json() as any;

    t.ctx.db
      .prepare(
        `UPDATE workspace_users
           SET role = 'member'
         WHERE workspace_id = ? AND user_id = 'local'`,
      )
      .run(workspace.workspace.id);

    const body = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/members`)
    ).json() as any;
    expect(body.viewer_role).toBe('member');
    expect(body.human_members.find((m: any) => m.id === 'local')).toMatchObject({
      user_id: 'local',
      role: 'member',
    });
  });

  it('lets the workspace owner update a human member role', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'member-role' })
    ).json() as any;
    const path = `/api/workspaces/${workspace.workspace.id}/members/users/teammate/role`;
    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeViewer = t.ctx.events.subscribeScope('viewer:teammate', event => {
      viewerEvents.push({ kind: event.kind, payload: event.payload });
    });

    try {
      const promote = await http(t).patch(path, { role: 'admin' });
      expect(promote.status).toBe(200);
      const promoteBody = await promote.json() as any;
      expect(promoteBody.member).toMatchObject({
        workspace_id: workspace.workspace.id,
        user_id: 'teammate',
        role: 'admin',
      });
      expect(promoteBody.human_member).toMatchObject({
        id: 'teammate',
        user_id: 'teammate',
        display_name: 'Teammate',
        role: 'admin',
      });
      expect(viewerEvents).toEqual([
        {
          kind: 'viewer_workspaces_changed',
          payload: {
            change: 'role_changed',
            workspace_id: workspace.workspace.id,
            role: 'admin',
          },
        },
      ]);

      const duplicateRole = await http(t).patch(path, { role: 'admin' });
      expect(duplicateRole.status).toBe(200);
      // Same-role writes return the current DTO but do not republish a
      // "changed" event.
      expect(viewerEvents).toHaveLength(1);

      const demote = await http(t).patch(path, { role: 'member' });
      expect(demote.status).toBe(200);
      const demoteBody = await demote.json() as any;
      expect(demoteBody.member).toMatchObject({ user_id: 'teammate', role: 'member' });
      expect(viewerEvents).toEqual([
        {
          kind: 'viewer_workspaces_changed',
          payload: {
            change: 'role_changed',
            workspace_id: workspace.workspace.id,
            role: 'admin',
          },
        },
        {
          kind: 'viewer_workspaces_changed',
          payload: {
            change: 'role_changed',
            workspace_id: workspace.workspace.id,
            role: 'member',
          },
        },
      ]);
    } finally {
      unsubscribeViewer();
    }

    const list = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/members`)
    ).json() as any;
    expect(list.human_members.find((m: any) => m.id === 'teammate')).toMatchObject({
      user_id: 'teammate',
      role: 'member',
    });
  });

  it('requires owner role to update a human member role', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'member-role-deny' })
    ).json() as any;
    const res = await http(t).patch(
      `/api/workspaces/${workspace.workspace.id}/members/users/teammate/role`,
      { role: 'admin' },
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it('rejects owner role changes through the human member role endpoint', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'member-role-owner' })
    ).json() as any;

    const setOwner = await http(t).patch(
      `/api/workspaces/${workspace.workspace.id}/members/users/teammate/role`,
      { role: 'owner' },
    );
    expect(setOwner.status).toBe(400);
    await expect(setOwner.json()).resolves.toMatchObject({
      code: 'owner_role_change_unsupported',
    });

    const demoteOwner = await http(t).patch(
      `/api/workspaces/${workspace.workspace.id}/members/users/local/role`,
      { role: 'member' },
    );
    expect(demoteOwner.status).toBe(400);
    await expect(demoteOwner.json()).resolves.toMatchObject({
      code: 'owner_role_change_unsupported',
    });

    const rows = t.ctx.db
      .prepare<[string], { user_id: string; role: string }>(
        `SELECT user_id, role FROM workspace_users
          WHERE workspace_id = ?
          ORDER BY user_id ASC`,
      )
      .all(workspace.workspace.id);
    expect(rows).toContainEqual({ user_id: 'local', role: 'owner' });
    expect(rows).toContainEqual({ user_id: 'teammate', role: 'member' });
  });

  it('returns 404 when updating a non-member human role', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'member-role-missing' })
    ).json() as any;
    const res = await http(t).patch(
      `/api/workspaces/${workspace.workspace.id}/members/users/missing-user/role`,
      { role: 'admin' },
    );
    expect(res.status).toBe(404);
  });

  it('lets the owner remove a human member, cascading conversation membership and publishing removed', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/workspaces', { name: 'remove-human' })
    ).json() as any;
    const workspaceId = created.workspace.id;
    const onboardingChannelId = created.onboarding_channel_id;

    // teammate is auto-mirrored as a member; seat a conversation_users row so
    // the cascade has something to clear (proves removal isn't workspace-only).
    t.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_users (conversation_id, user_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(onboardingChannelId, 'teammate', 0);

    const before = await (
      await http(t).get(`/api/workspaces/${workspaceId}/members`)
    ).json() as any;
    expect(before.human_members.map((m: any) => m.id)).toContain('teammate');

    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeViewer = t.ctx.events.subscribeScope('viewer:teammate', event => {
      viewerEvents.push({ kind: event.kind, payload: event.payload });
    });
    const conversationEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeConversation = t.ctx.events.subscribe(onboardingChannelId, event => {
      conversationEvents.push({ kind: event.kind, payload: event.payload });
    });
    // Stage-2 P2: conversation_members_changed is a side-channel kind.
    const unsubscribeConversationSide = t.ctx.events.subscribeScope(
      conversationSideScope(onboardingChannelId),
      event => {
        conversationEvents.push({ kind: event.kind, payload: event.payload });
      },
    );
    const workspaceEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeWorkspace = t.ctx.events.subscribeScope(
      `workspace:${workspaceId}`,
      event => workspaceEvents.push({ kind: event.kind, payload: event.payload }),
    );

    let status: number;
    try {
      const res = await http(t).del(
        `/api/workspaces/${workspaceId}/members/users/teammate`,
      );
      status = res.status;
    } finally {
      unsubscribeViewer();
      unsubscribeConversation();
      unsubscribeConversationSide();
      unsubscribeWorkspace();
    }
    expect(status).toBe(204);
    // removed carries no role (the viewer no longer has one here); renderer
    // refetches `['workspaces']` as the authority.
    expect(viewerEvents).toEqual([
      {
        kind: 'viewer_workspaces_changed',
        payload: { change: 'removed', workspace_id: workspaceId },
      },
    ]);
    const memberRemovedMessage = conversationEvents.find(e => e.kind === 'message');
    expect((memberRemovedMessage?.payload as any)?.message).toMatchObject({
      from_kind: 'system',
      content: '@local-test removed @teammate-test from this conversation.',
      metadata: {
        subtype: 'conversation_member_removed',
        actor_kind: 'user',
        actor_id: 'local',
        actor_name: 'local-test',
        member_kind: 'human',
        member_id: 'teammate',
        member_name: 'teammate-test',
      },
    });
    expect(conversationEvents).toContainEqual({
      kind: 'conversation_members_changed',
      payload: {
        conversation_id: onboardingChannelId,
        workspace_id: workspaceId,
      },
    });
    expect(workspaceEvents).toContainEqual({
      kind: 'workspace_channels_changed',
      payload: {
        workspace_id: workspaceId,
        channel_id: onboardingChannelId,
      },
    });

    const after = await (
      await http(t).get(`/api/workspaces/${workspaceId}/members`)
    ).json() as any;
    expect(after.human_members.map((m: any) => m.id)).not.toContain('teammate');

    const convRow = t.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM conversation_users
          WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(onboardingChannelId, 'teammate');
    expect(convRow?.c).toBe(0);
    const wsRow = t.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspace_users
          WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspaceId, 'teammate');
    expect(wsRow?.c).toBe(0);
  });

  it('rejects removing the workspace owner', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/workspaces', { name: 'remove-owner' })
    ).json() as any;
    const workspaceId = created.workspace.id;
    const res = await http(t).del(
      `/api/workspaces/${workspaceId}/members/users/local`,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'owner_removal_unsupported',
    });
    const rows = t.ctx.db
      .prepare<[string], { user_id: string; role: string }>(
        `SELECT user_id, role FROM workspace_users WHERE workspace_id = ?`,
      )
      .all(workspaceId);
    expect(rows).toContainEqual({ user_id: 'local', role: 'owner' });
  });

  it('requires owner role to remove a human member', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/workspaces', { name: 'remove-deny' })
    ).json() as any;
    // teammate (a non-owner member) cannot remove anyone.
    const res = await http(t).del(
      `/api/workspaces/${created.workspace.id}/members/users/local`,
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when removing a non-member human', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/workspaces', { name: 'remove-missing' })
    ).json() as any;
    const res = await http(t).del(
      `/api/workspaces/${created.workspace.id}/members/users/missing-user`,
    );
    expect(res.status).toBe(404);
  });

  it('rejects adding an unknown human workspace member', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'unknown-human' })
    ).json() as any;
    const res = await http(t).post(
      `/api/workspaces/${workspace.workspace.id}/members`,
      { kind: 'human', user_id: 'missing-user' },
    );
    expect(res.status).toBe(404);
  });
});

describe('workspace channel routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creates and lists channel conversations under a workspace', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'product',
        member_agent_ids: [agentId],
      })
    ).json() as any;
    const workspaceEvents: Array<{ kind: string; payload: any }> = [];
    const unsubscribe = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const created = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'planning',
        member_agent_ids: [agentId],
      })
    ).json() as any;
    unsubscribe();
    expect(created.channel).toMatchObject({
      kind: 'channel',
      workspace_id: workspace.workspace.id,
      title: 'planning',
    });
    expect(workspaceEvents).toContainEqual({
      kind: 'workspace_channels_changed',
      payload: {
        workspace_id: workspace.workspace.id,
        channel_id: created.channel.id,
      },
    });

    const list = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/channels`)
    ).json() as any;
    expect(list.channels.map((c: any) => c.id)).toContain(created.channel.id);
  });

  it('publishes workspace_channels_changed for human and internal channel creation', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const bobId = await makeAgent(t, 'bob');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'events',
        member_agent_ids: [aliceId, bobId],
      })
    ).json() as any;

    const workspaceEvents: Array<{ kind: string; payload: any }> = [];
    const unsubscribe = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const human = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'human-created',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const internal = await (
      await http(t).post(
        `/internal/conversations/${workspace.onboarding_channel_id}/agents/${aliceId}/create-channel`,
        {
          title: 'agent-created',
          context_summary: 'split out',
          initial_prompt: 'continue here',
        },
      )
    ).json() as any;
    unsubscribe();

    expect(workspaceEvents).toEqual([
      {
        kind: 'workspace_channels_changed',
        payload: {
          workspace_id: workspace.workspace.id,
          channel_id: human.channel.id,
        },
      },
      {
        kind: 'workspace_channels_changed',
        payload: {
          workspace_id: workspace.workspace.id,
          channel_id: internal.channel_id,
        },
      },
    ]);
  });

  it('rejects adding a non-workspace member to a channel', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'scope' })
    ).json() as any;
    const outsider = await makeAgent(t, 'outsider');
    const res = await http(t).post(
      `/api/workspaces/${workspace.workspace.id}/channels`,
      {
        title: 'bad',
        member_agent_ids: [outsider],
      },
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/channels/:id/archive', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('archives and unarchives a regular channel without touching status, closed_at, or agent lifecycle', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'archtest',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const channelId: string = created.channel.id;
    t.fake.starts = [];
    t.fake.delivered = [];
    const events: Array<{ kind: string }> = [];
    const unsub = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => events.push({ kind: e.kind }),
    );

    const archived = await http(t).patch(
      `/api/channels/${channelId}/archive`,
      { archived: true },
    );
    expect(archived.status).toBe(200);
    const archivedBody = await archived.json() as any;
    expect(archivedBody.channel.archived_at).not.toBeNull();
    expect(archivedBody.channel.status).toBe(created.channel.status);
    expect(archivedBody.channel.closed_at).toBeNull();
    expect(archivedBody.channel.close_summary).toBeNull();

    const unarchived = await http(t).patch(
      `/api/channels/${channelId}/archive`,
      { archived: false },
    );
    expect(unarchived.status).toBe(200);
    const unarchivedBody = await unarchived.json() as any;
    expect(unarchivedBody.channel.archived_at).toBeNull();

    unsub();
    expect(events.map(e => e.kind)).toEqual([
      'workspace_channels_changed',
      'workspace_channels_changed',
    ]);
    // Archive must not nudge agent runtime — no fresh start/deliver calls.
    expect(t.fake.starts).toEqual([]);
    expect(t.fake.delivered).toEqual([]);
  });

  it('archives and restores dm_channels', async () => {
    t = buildTestApp();
    await makeAgent(t, 'alice');
    const conversations = new ConversationRepo(t.ctx.db);
    // dm_channel is channel-like: archive/restore is supported and the
    // caller (agent_home owner) passes the workspace governance gate.
    const dmChannel = conversations.listDmChannels()[0];
    expect(dmChannel).toBeTruthy();
    const dmRes = await http(t).patch(
      `/api/channels/${dmChannel!.id}/archive`,
      { archived: true },
    );
    expect(dmRes.status).toBe(200);
    expect(((await dmRes.json()) as any).channel.archived_at).not.toBeNull();
    const dmRestore = await http(t).patch(
      `/api/channels/${dmChannel!.id}/archive`,
      { archived: false },
    );
    expect(dmRestore.status).toBe(200);
    expect(((await dmRestore.json()) as any).channel.archived_at).toBeNull();
  });

  it('returns 404 for unknown ids and 400 for invalid bodies', async () => {
    t = buildTestApp();
    const missing = await http(t).patch('/api/channels/missing/archive', {
      archived: true,
    });
    expect(missing.status).toBe(404);

    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'badbody',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const bad = await http(t).patch(
      `/api/channels/${created.channel.id}/archive`,
      { archived: 'yes' },
    );
    expect(bad.status).toBe(400);
  });
});

describe('PATCH /api/channels/:id (rename)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('renames a channel, broadcasts a scoped rename system message, and delivers to members', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'renametest',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const channelId: string = created.channel.id;
    t.fake.starts = [];
    t.fake.delivered = [];
    const events: Array<{ kind: string }> = [];
    const unsub = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => events.push({ kind: e.kind }),
    );

    const res = await http(t).patch(`/api/channels/${channelId}`, {
      title: 'roadmap',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.channel.title).toBe('roadmap');
    // Rename must not nudge lifecycle fields.
    expect(body.channel.status).toBe(created.channel.status);
    expect(body.channel.closed_at).toBeNull();

    const msgs = await (
      await http(t).get(`/api/channels/${channelId}/messages`)
    ).json() as any;
    const renameMsg = msgs.messages.find(
      (m: any) => m.metadata?.subtype === 'rename',
    );
    expect(renameMsg).toBeTruthy();
    // Channel-scoped rename: structured metadata carries the old/new
    // title and scope='conversation' so the renderer can distinguish it
    // from a workspace rename.
    const parsed = readRenameMetadata(renameMsg.metadata);
    expect(parsed).not.toBeNull();
    expect(parsed!.old_name).toBe('planning');
    expect(parsed!.new_name).toBe('roadmap');
    expect(parsed!.scope).toBe('conversation');
    // The system message must reach the member agent's context.
    expect(t.fake.delivered.some(d => d.messageId === renameMsg.id)).toBe(true);

    unsub();
    expect(events).toContainEqual({ kind: 'workspace_channels_changed' });
  });

  it('no-op rename (same title) makes no change and emits nothing', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'noop',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const channelId: string = created.channel.id;
    t.fake.delivered = [];
    const events: Array<{ kind: string }> = [];
    const unsub = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => events.push({ kind: e.kind }),
    );

    const res = await http(t).patch(`/api/channels/${channelId}`, {
      title: 'planning',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channel.title).toBe('planning');

    const msgs = await (
      await http(t).get(`/api/channels/${channelId}/messages`)
    ).json() as any;
    expect(
      msgs.messages.some((m: any) => m.metadata?.subtype === 'rename'),
    ).toBe(false);

    unsub();
    expect(t.fake.delivered).toEqual([]);
    expect(events).toEqual([]);
  });

  it('renames dm_channels', async () => {
    t = buildTestApp();
    await makeAgent(t, 'alice');
    const conversations = new ConversationRepo(t.ctx.db);
    // dm_channel is channel-like: rename is supported (creation already
    // accepts a user-supplied title — this just closes the edit gap).
    const dmChannel = conversations.listDmChannels()[0];
    expect(dmChannel).toBeTruthy();
    const dmRes = await http(t).patch(`/api/channels/${dmChannel!.id}`, {
      title: 'renamed-dm',
    });
    expect(dmRes.status).toBe(200);
    expect(((await dmRes.json()) as any).channel.title).toBe('renamed-dm');
  });

  it('returns 404 for unknown ids and 400 for invalid bodies', async () => {
    t = buildTestApp();
    const missing = await http(t).patch('/api/channels/missing', {
      title: 'whatever',
    });
    expect(missing.status).toBe(404);

    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'badrenamebody',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const channelId: string = created.channel.id;

    const empty = await http(t).patch(`/api/channels/${channelId}`, {
      title: '',
    });
    expect(empty.status).toBe(400);

    // Pure-whitespace title is rejected at the API boundary (trimmed
    // then min(1)) — not only by the UI.
    const blank = await http(t).patch(`/api/channels/${channelId}`, {
      title: '   ',
    });
    expect(blank.status).toBe(400);

    const tooLong = await http(t).patch(`/api/channels/${channelId}`, {
      title: 'x'.repeat(129),
    });
    expect(tooLong.status).toBe(400);
  });

  it('trims surrounding whitespace from the new title', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'trimrename',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;

    const res = await http(t).patch(`/api/channels/${created.channel.id}`, {
      title: '  roadmap  ',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channel.title).toBe('roadmap');
  });
});

describe('GET /api/workspaces/:id/channels (active vs archived split)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('active list excludes archived channels; archived list includes them', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'split',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const wsId: string = workspace.workspace.id;

    const live = await (
      await http(t).post(
        `/api/workspaces/${wsId}/channels`,
        { title: 'live', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const cold = await (
      await http(t).post(
        `/api/workspaces/${wsId}/channels`,
        { title: 'cold', member_agent_ids: [aliceId] },
      )
    ).json() as any;

    const archived = await http(t).patch(
      `/api/channels/${cold.channel.id}/archive`,
      { archived: true },
    );
    expect(archived.status).toBe(200);

    const active = await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json() as any;
    const activeChannelIds = active.channels.map((c: any) => c.id);
    expect(activeChannelIds).toContain(live.channel.id);
    expect(activeChannelIds).not.toContain(cold.channel.id);

    const archivedRes = await (
      await http(t).get(`/api/workspaces/${wsId}/channels/archived`)
    ).json() as any;
    const archivedChannelIds = archivedRes.channels.map((c: any) => c.id);
    expect(archivedChannelIds).toEqual([cold.channel.id]);

    // Round-trip: unarchive moves the channel back into the active list.
    const unarchived = await http(t).patch(
      `/api/channels/${cold.channel.id}/archive`,
      { archived: false },
    );
    expect(unarchived.status).toBe(200);
    const active2 = await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json() as any;
    expect(active2.channels.map((c: any) => c.id)).toContain(cold.channel.id);
    const archived2 = await (
      await http(t).get(`/api/workspaces/${wsId}/channels/archived`)
    ).json() as any;
    expect(archived2.channels).toEqual([]);
  });

  it('agent_home workspaces return empty archived tree without erroring', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    // Onboarding provisioning auto-creates an agent_home workspace per agent.
    const wsList = await (await http(t).get('/api/workspaces')).json() as any;
    const home = wsList.workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === aliceId,
    );
    expect(home).toBeTruthy();
    const res = await http(t).get(`/api/workspaces/${home.id}/channels/archived`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toEqual({ channels: [], threads: [] });
  });
});

describe('GET /api/archived-channels (cross-workspace aggregate)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns channels across workspaces with workspace name + thread_count, sorted by archived_at DESC', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const ws1 = await (
      await http(t).post('/api/workspaces', {
        name: 'one',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const ws2 = await (
      await http(t).post('/api/workspaces', {
        name: 'two',
        member_agent_ids: [aliceId],
      })
    ).json() as any;

    const c1 = await (
      await http(t).post(`/api/workspaces/${ws1.workspace.id}/channels`, {
        title: 'a',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const c2 = await (
      await http(t).post(`/api/workspaces/${ws2.workspace.id}/channels`, {
        title: 'b',
        member_agent_ids: [aliceId],
      })
    ).json() as any;

    // Active channels must not appear.
    const active = await (
      await http(t).post(`/api/workspaces/${ws1.workspace.id}/channels`, {
        title: 'still-active',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    expect(active.channel.archived_at).toBeNull();

    expect((await http(t).patch(`/api/channels/${c1.channel.id}/archive`, { archived: true })).status).toBe(200);
    // Force a measurable gap so DESC ordering is unambiguous.
    await new Promise(r => setTimeout(r, 5));
    expect((await http(t).patch(`/api/channels/${c2.channel.id}/archive`, { archived: true })).status).toBe(200);

    const list = await (await http(t).get('/api/archived-channels')).json() as any;
    expect(list.channels).toHaveLength(2);
    // c2 archived later -> first.
    expect(list.channels[0].channel.id).toBe(c2.channel.id);
    expect(list.channels[0].workspace).toMatchObject({
      id: ws2.workspace.id,
      name: 'two',
      archived_at: null,
    });
    expect(list.channels[0].thread_count).toBe(0);
    expect(list.channels[1].channel.id).toBe(c1.channel.id);
    expect(list.channels[1].workspace.name).toBe('one');
    expect(list.channels[1].thread_count).toBe(0);
  });

  it('filters by workspace_id and since (epoch ms)', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const ws1 = await (
      await http(t).post('/api/workspaces', {
        name: 'alpha',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const ws2 = await (
      await http(t).post('/api/workspaces', {
        name: 'beta',
        member_agent_ids: [aliceId],
      })
    ).json() as any;

    const c1 = await (
      await http(t).post(`/api/workspaces/${ws1.workspace.id}/channels`, {
        title: 'old',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const c2 = await (
      await http(t).post(`/api/workspaces/${ws2.workspace.id}/channels`, {
        title: 'new',
        member_agent_ids: [aliceId],
      })
    ).json() as any;

    expect((await http(t).patch(`/api/channels/${c1.channel.id}/archive`, { archived: true })).status).toBe(200);
    await new Promise(r => setTimeout(r, 10));
    const cutoff = Date.now();
    await new Promise(r => setTimeout(r, 10));
    expect((await http(t).patch(`/api/channels/${c2.channel.id}/archive`, { archived: true })).status).toBe(200);

    // workspace_id filter narrows to one row.
    const ws1Only = await (
      await http(t).get(`/api/archived-channels?workspace_id=${ws1.workspace.id}`)
    ).json() as any;
    expect(ws1Only.channels.map((r: any) => r.channel.id)).toEqual([c1.channel.id]);

    // since filter excludes anything archived before the cutoff.
    const recent = await (
      await http(t).get(`/api/archived-channels?since=${cutoff}`)
    ).json() as any;
    expect(recent.channels.map((r: any) => r.channel.id)).toEqual([c2.channel.id]);

    // Both filters together can narrow to empty.
    const both = await (
      await http(t).get(
        `/api/archived-channels?workspace_id=${ws1.workspace.id}&since=${cutoff}`,
      )
    ).json() as any;
    expect(both.channels).toEqual([]);
  });

  it('rejects unknown workspace_id with 404, invalid since with 400', async () => {
    t = buildTestApp();
    expect(
      (await http(t).get('/api/archived-channels?workspace_id=missing')).status,
    ).toBe(404);
    expect(
      (await http(t).get('/api/archived-channels?since=not-a-number')).status,
    ).toBe(400);
  });

  it('spans channel-like: default includes archived DMs, regular filter excludes them, agent_home filter includes them', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    // A regular workspace with an archived regular channel.
    const ws = await (
      await http(t).post('/api/workspaces', {
        name: 'reg',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const rc = await (
      await http(t).post(`/api/workspaces/${ws.workspace.id}/channels`, {
        title: 'rc',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    expect(
      (await http(t).patch(`/api/channels/${rc.channel.id}/archive`, { archived: true })).status,
    ).toBe(200);

    // A DM lives in alice's agent_home; archive it too.
    const conversations = new ConversationRepo(t.ctx.db);
    const dm = conversations.listDmChannels()[0];
    expect(dm).toBeTruthy();
    const homeId = dm!.workspace_id;
    expect(
      (await http(t).patch(`/api/channels/${dm!.id}/archive`, { archived: true })).status,
    ).toBe(200);

    // Default (no workspace filter): the global recovery index spans both
    // collections — regular channel AND DM — and the DM row carries its
    // dm_channel kind plus its agent_home workspace context.
    const all = await (await http(t).get('/api/archived-channels')).json() as any;
    const allIds = all.channels.map((r: any) => r.channel.id);
    expect(allIds).toContain(rc.channel.id);
    expect(allIds).toContain(dm!.id);
    const dmRow = all.channels.find((r: any) => r.channel.id === dm!.id);
    expect(dmRow.channel.kind).toBe('dm_channel');
    expect(dmRow.workspace.id).toBe(homeId);

    // Filtering to the regular workspace excludes the DM.
    const regOnly = await (
      await http(t).get(`/api/archived-channels?workspace_id=${ws.workspace.id}`)
    ).json() as any;
    const regIds = regOnly.channels.map((r: any) => r.channel.id);
    expect(regIds).toContain(rc.channel.id);
    expect(regIds).not.toContain(dm!.id);

    // Filtering to the agent_home includes the DM, excludes the regular channel.
    const homeOnly = await (
      await http(t).get(`/api/archived-channels?workspace_id=${homeId}`)
    ).json() as any;
    const homeIds = homeOnly.channels.map((r: any) => r.channel.id);
    expect(homeIds).toContain(dm!.id);
    expect(homeIds).not.toContain(rc.channel.id);
  });
});

describe('list routes filter by conversation_users (v25 PR-A blocker fix)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /**
   * Regression for PR-A blocker #1: workspace channel/thread list
   * routes used to return every conversation in the workspace
   * regardless of `conversation_users` membership. After v25 we
   * filter by membership for human principals so a workspace member
   * who is not a member of a private channel/thread does not see it
   * in the sidebar / archived list.
   *
   * Scenario:
   *   - `local` (the fixture viewer) is the workspace member.
   *   - `teammate` (another fixture user) is also a workspace member
   *      via the test autoseed triggers.
   *   - We strip both users out of `conversation_users` for one
   *      private channel and assert each list endpoint excludes it
   *      when called as `teammate` but still includes it for `local`.
   */
  it('hides channels/threads/archived from human principals who are not conversation_users', async () => {
    t = buildTestApp();

    // Create a workspace + 2 channels via the routes (so route-level
    // membership writes apply naturally). One channel will be the
    // "private" one we strip teammate from.
    const aliceId = await makeAgent(t, 'alice');
    const wsRes = await http(t).post('/api/workspaces', {
      name: 'shared',
      member_agent_ids: [aliceId],
    });
    expect(wsRes.status).toBe(201);
    const ws = await wsRes.json() as any;
    const workspaceId: string = ws.workspace.id;

    const publicCh = await http(t).post(
      `/api/workspaces/${workspaceId}/channels`,
      { title: 'Public', member_agent_ids: [aliceId] },
    );
    expect(publicCh.status).toBe(201);
    const pub = await publicCh.json() as any;

    const privateCh = await http(t).post(
      `/api/workspaces/${workspaceId}/channels`,
      { title: 'Private', member_agent_ids: [aliceId] },
    );
    expect(privateCh.status).toBe(201);
    const priv = await privateCh.json() as any;

    // Strip `teammate` from the private channel so the membership filter
    // has something to hide.
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'teammate'`)
      .run(priv.channel.id);

    // Archive the private channel so we can also assert the archived
    // route + aggregate route filter the same way.
    const archive = await http(t).patch(
      `/api/channels/${priv.channel.id}/archive`,
      { archived: true },
    );
    expect(archive.status).toBe(200);

    // Active list — local sees Onboarding+Public, teammate sees the
    // same minus the (now archived) Private.
    const activeLocal = await (
      await http(t).get(`/api/workspaces/${workspaceId}/channels`)
    ).json() as any;
    expect(activeLocal.channels.map((c: any) => c.title).sort()).toEqual(
      ['Onboarding', 'Public'],
    );

    const activeTeammate = await (
      await http(t).get(`/api/workspaces/${workspaceId}/channels`, {
        headers: { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') },
      })
    ).json() as any;
    expect(activeTeammate.channels.map((c: any) => c.title).sort()).toEqual(
      ['Onboarding', 'Public'],
    );

    // Archived list (workspace-scoped) — local sees the archived
    // private channel; teammate sees nothing.
    const archivedLocalResp = await http(t).get(`/api/workspaces/${workspaceId}/channels/archived`);
    const archivedLocal = await archivedLocalResp.json() as any;
    expect(archivedLocal.channels.map((c: any) => c.title)).toEqual(['Private']);

    const archivedTeammateResp = await http(t).get(
      `/api/workspaces/${workspaceId}/channels/archived`,
      {
        headers: { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') },
      },
    );
    const archivedTeammate = await archivedTeammateResp.json() as any;
    expect(archivedTeammate.channels).toEqual([]);

    // Cross-workspace aggregate — same gate.
    const aggLocal = await (
      await http(t).get(`/api/archived-channels?workspace_id=${workspaceId}`)
    ).json() as any;
    expect(aggLocal.channels.map((r: any) => r.channel.title)).toEqual(['Private']);

    const aggTeammate = await (
      await http(t).get(`/api/archived-channels?workspace_id=${workspaceId}`, {
        headers: { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') },
      })
    ).json() as any;
    expect(aggTeammate.channels).toEqual([]);
  });
});
