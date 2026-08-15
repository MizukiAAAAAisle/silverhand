import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import {
  conversationSideScope,
  encodeUserPrincipalHeader,
  readRenameMetadata,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { channelServiceErrorResponse } from '../../src/routes/responses.js';
import { ActorError } from '../../src/services/channel-service.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';

/** Drop every Markdown code span, which is where these bodies put a
 *  user-chosen label. What remains is the open text a `#ref` sigil or a
 *  Markdown construct could be read out of — the real hazard for the assertions
 *  below. The mention assertions need no strip: `extractMessageReferences` is
 *  itself position-aware (#task:2000), so it is asserted against the RAW body. */
function stripCodeSpans(text: string): string {
  return text.replace(/(`+)[\s\S]*?\1/g, ' ');
}

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

  it('creates workspace + onboarding channel + auto-spawns members (pure DB write, no daemon directory)', async () => {
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

    // relocation-v1 §7-4 — create is severed from the daemon registry, so it is
    // a pure DB write: NO workspace directory is provisioned on disk (the daemon
    // materializes it lazily at first spawn).
    await expect(
      fs.stat(join(t.silverhandDir, 'workspaces', body.workspace.id)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

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
    // #1998 rephrased this sentence ("write by scope … → L2 MEMORY.md" became
    // "Write global identity … to L1 / Use this workspace's L2 only for …") and
    // left these literals behind; the rule itself is unchanged, so the guard is
    // re-anchored on the current wording.
    // Drift guard for R1: must NOT contain "DM-only / redirect-to-DM"
    // wording — that restriction was retracted.
    expect(onboardingMessages[0].content).toContain('Write global identity');
    expect(onboardingMessages[0].content).toContain('L1 system_prompt.md');
    expect(onboardingMessages[0].content).toContain(`this workspace's L2 only`);
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
    // Internal spaces and Chinese are legal in a workspace name (#task:1827):
    // it is a display label, not an addressable handle. What create must still
    // refuse is a code point the name field cannot render — here a zero-width
    // space, which would make two different names pixel-identical.
    expect((await http(t).post('/api/workspaces', { name: 'has\u200Bspaces' })).status)
      .toBe(400);
    expect((await http(t).post('/api/workspaces', { name: '设计 评审' })).status)
      .toBe(201);
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

  // #task:1827 — a workspace name is free text, and these two bodies reach an
  // agent verbatim on stdin. So a legal label must not be able to spell a
  // mention, a `#` reference, or Markdown structure. Asserted by STRIPPING code
  // spans (the same containers the renderer's `remarkRefs` skips) and then
  // looking for the hazards in what is left: whatever survives the strip is
  // exactly what a reader — human or agent — can act on.
  it('cannot let a legal workspace label spell a mention, a ref, or Markdown', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const hostile = '@alice #general `x` **bold**';

    const created = await (
      await http(t).post('/api/workspaces', {
        name: hostile,
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    expect(created.workspace.name).toBe(hostile);

    const afterCreate = await (
      await http(t).get(`/api/channels/${created.onboarding_channel_id}/messages`)
    ).json() as any;
    const onboarding = afterCreate.messages.find(
      (m: any) => m.metadata?.subtype === 'onboarding',
    );
    // The label rides in a code span, so the only participant this body
    // addresses is the recipient — named by a canonical reference, which is the
    // only form that delivers. The hostile label's own `@alice` is display text.
    expect(extractMessageReferences(onboarding.content)).toEqual([
      { kind: 'agent', handle: 'alice' },
    ]);
    expect(stripCodeSpans(onboarding.content)).not.toContain('#general');
    expect(stripCodeSpans(onboarding.content)).not.toContain('**bold**');
    // Sigil placement: `#` belongs to channels, so the label is never prefixed.
    expect(onboarding.content).not.toContain(`#${hostile}`);

    const renamed = '#general @alice';
    expect(
      (await http(t).patch(`/api/workspaces/${created.workspace.id}`, { name: renamed }))
        .status,
    ).toBe(200);
    const afterRename = await (
      await http(t).get(`/api/channels/${created.onboarding_channel_id}/messages`)
    ).json() as any;
    const rename = afterRename.messages.find(
      (m: any) => m.metadata?.subtype === 'rename',
    );
    // Both the old and the new label are quoted, so the announcement addresses
    // nobody and carries no reference at all.
    expect(extractMessageReferences(rename.content)).toEqual([]);
    expect(stripCodeSpans(rename.content)).not.toContain('#general');
    // The structured metadata the renderer draws stays the raw label.
    expect(rename.metadata.old_name).toBe(hostile);
    expect(rename.metadata.new_name).toBe(renamed);
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
      })),
    ));
    for (const channelId of channelIds) {
      const events = conversationEvents.get(channelId) ?? [];
      const memberRemovedMessage = events.find(e => e.kind === 'message');
      expect((memberRemovedMessage?.payload as any)?.message).toMatchObject({
        from_kind: 'system',
        content: '<silverhand://human/local-test> removed <silverhand://agent/carol> from this conversation.',
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
      content: '<silverhand://human/local-test> removed <silverhand://human/teammate-test> from this conversation.',
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

  it('archives and unarchives a regular channel without touching status or closed_at', async () => {
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
    // Archive stops agent runtime (#task:1398) but never *starts* or delivers —
    // no fresh start/deliver calls. (The hard-stop path is asserted in the
    // channel-service unit tests.)
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

describe('PATCH /api/channels/:id + POST channels — the title IS the address (#task:2016)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /** A workspace with one member agent and a channel, by the human doors. There
   *  is no second addressing field to pass: the TITLE is the address, so the
   *  create body carries exactly one name for the channel. */
  async function seed(
    workspaceName: string,
    title: string,
  ): Promise<{ app: TestApp; workspaceId: string; agentId: string; created: any }> {
    const app = buildTestApp();
    t = app;
    const agentId = await makeAgent(app, 'alice');
    const workspace = await (
      await http(app).post('/api/workspaces', {
        name: workspaceName,
        member_agent_ids: [agentId],
      })
    ).json() as any;
    const res = await http(app).post(
      `/api/workspaces/${workspace.workspace.id}/channels`,
      { title, member_agent_ids: [agentId] },
    );
    expect(res.status).toBe(201);
    return {
      app,
      workspaceId: workspace.workspace.id,
      agentId,
      created: (await res.json()) as any,
    };
  }

  it('creation refuses a title another channel already shows — 409, never a suffixed 201', async () => {
    const s = await seed('addrtaken', 'Release Planning');

    // A DIFFERENT SPELLING of the same address: uniqueness is case-insensitive
    // (and NFC-insensitive), so the refusal cannot be dodged by shift-key.
    const conflict = await http(s.app).post(`/api/workspaces/${s.workspaceId}/channels`, {
      title: 'release PLANNING',
      member_agent_ids: [],
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as any).code).toBe('conversation_title_taken');

    // The refusal is not a rename-with-a-suffix: nothing new exists.
    const listed = ((await (
      await http(s.app).get(`/api/workspaces/${s.workspaceId}/channels`)
    ).json()) as any).channels.map((c: any) => c.title);
    expect(listed.filter((x: string) => /release/i.test(x))).toEqual(['Release Planning']);
  });

  it('a rename onto a taken title is 409 and leaves the channel where it was', async () => {
    const s = await seed('addrconflict', 'Planning');
    const other = await http(s.app).post(`/api/workspaces/${s.workspaceId}/channels`, {
      title: 'Roadmap',
      member_agent_ids: [],
    });
    expect(other.status).toBe(201);

    const res = await http(s.app).patch(`/api/channels/${s.created.channel.id}`, {
      title: 'roadmap',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('conversation_title_taken');

    const still = await http(s.app).get(`/api/workspaces/${s.workspaceId}/channels`);
    const listed = ((await still.json()) as any).channels
      .find((c: any) => c.id === s.created.channel.id);
    expect(listed.title).toBe('Planning');
  });

  it('a rename RELEASES the old title at once — the next creation may take it', async () => {
    const s = await seed('addrrelease', 'Planning');

    const moved = await http(s.app).patch(`/api/channels/${s.created.channel.id}`, {
      title: 'Roadmap',
    });
    expect(moved.status).toBe(200);

    // No retirement, no successor pointer, no cooling-off period: `planning` is
    // free the instant the rename commits, which is the whole difference from the
    // retired-name model this replaced.
    const reuse = await http(s.app).post(`/api/workspaces/${s.workspaceId}/channels`, {
      title: 'planning',
      member_agent_ids: [],
    });
    expect(reuse.status).toBe(201);
    expect(((await reuse.json()) as any).channel.title).toBe('planning');
  });

  it('re-spelling a channel to its OWN address succeeds (self is excluded)', async () => {
    const s = await seed('addrrespell', 'planning');

    // Same address, different display text. A collision check without a
    // self-exclusion arm would refuse this — it is the one case where the key
    // being taken is not a conflict.
    const res = await http(s.app).patch(`/api/channels/${s.created.channel.id}`, {
      title: 'Planning',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channel.title).toBe('Planning');
  });

  it('an addressless conversation is refused by AUTHORITY before addressability', async () => {
    const app = buildTestApp();
    t = app;
    const agentId = await makeAgent(app, 'alice');
    // Reached through the CHANNEL door on purpose: `kind` is GENERATED from
    // `roster_policy`, so an inbox reads as `dm_channel` and passes every
    // kind-shaped gate. What stops it is not the kind and not — here — the
    // absence of an address: `canGovernConversationWorkspace(..., 'admin')`
    // admits only a `system` principal for a workspace-less conversation, and
    // this door cannot carry one. So the wire answer is 403, and the service's
    // `not_addressable` (400) is unreachable through it; that refusal is pinned
    // at the service face in `tests/services/channel-service.test.ts`. Asserted
    // here so the LAYERING is the recorded fact rather than an assumption.
    const inboxId = new ConversationRepo(app.ctx.db).getAgentInbox(agentId)!.id;

    const res = await http(app).patch(`/api/channels/${inboxId}`, { title: 'Alice Inbox' });
    expect(res.status).toBe(403);
  });

  it('rejects a body that asks for more than one thing, and an inadmissible title', async () => {
    const s = await seed('addrbadbody', 'Planning');
    const channelId: string = s.created.channel.id;

    // The PATCH body is EXACTLY-ONE-OF title | visibility: a request that
    // re-addresses and re-scopes at once has no defined order, and the two are
    // separate decisions.
    const both = await http(s.app).patch(`/api/channels/${channelId}`, {
      title: 'Roadmap',
      visibility: 'private',
    });
    expect(both.status).toBe(400);

    const empty = await http(s.app).patch(`/api/channels/${channelId}`, {});
    expect(empty.status).toBe(400);

    // The grammar is enforced at the BOUNDARY, so an unstorable title never
    // reaches the address space. Two-character escapes on purpose — a real
    // control byte in a source file makes the file binary to every gate.
    const inadmissible = [
      '',
      '   ',
      'x'.repeat(129),
      'road\u200Bmap', // ZERO WIDTH SPACE — invisible, so it would forge a twin
      'road\uFE0Fmap', // VARIATION SELECTOR-16 — a sequence-forming emoji part
    ];
    for (const title of inadmissible) {
      const res = await http(s.app).patch(`/api/channels/${channelId}`, { title });
      expect(res.status, JSON.stringify(title)).toBe(400);
      // …and the same grammar at the creation door, which shares the schema.
      const created = await http(s.app).post(`/api/workspaces/${s.workspaceId}/channels`, {
        title,
        member_agent_ids: [],
      });
      expect(created.status, JSON.stringify(title)).toBe(400);
    }
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
    expect(body).toEqual({ channels: [] });
  });

  /**
   * The archived list carries the SAME viewer-scoped `is_member` the active list
   * does (#task:1691). Before this, membership existed only inside the query's
   * filter, so a consumer of the two tables had to remember that one of them
   * "happens to be membership-filtered" — and a test could satisfy the contract
   * with a row shape the route never produces.
   *
   * `seedAllFixtureMemberships: false` because the permissive fixture triggers
   * would make the viewer a member of everything, which is exactly the fact
   * under test.
   */
  it('archived list carries a per-viewer is_member, and a non-member row is ABSENT rather than false', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const OWNER = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const wsId = ((await (await http(t).post(
      '/api/workspaces',
      { name: 'archived-carrier', member_agent_ids: [] },
      { headers: OWNER },
    )).json()) as any).workspace.id as string;
    expect(
      (await http(t).post(
        `/api/workspaces/${wsId}/members`,
        { kind: 'human', user_id: 'local' },
        { headers: OWNER },
      )).status,
    ).toBe(201);

    const makeChannel = async (title: string, memberUserIds: string[]) =>
      ((await (await http(t!).post(
        `/api/workspaces/${wsId}/channels`,
        {
          title,
          member_agent_ids: [],
          member_user_ids: memberUserIds,
          visibility: 'private',
        },
        { headers: OWNER },
      )).json()) as any).channel.id as string;
    // `mine` has the viewer; `theirs` is a private channel they are not in.
    const mine = await makeChannel('mine', ['local']);
    const theirs = await makeChannel('theirs', []);
    for (const id of [mine, theirs]) {
      expect(
        (await http(t).patch(`/api/channels/${id}/archive`, { archived: true }, { headers: OWNER }))
          .status,
      ).toBe(200);
    }

    // The viewer (`local`, the default identity of `http(t)`).
    const body = await (
      await http(t).get(`/api/workspaces/${wsId}/channels/archived`)
    ).json() as any;
    expect(body.channels.map((c: any) => c.id)).toEqual([mine]);
    // The carrier is present and true — not `undefined`, which a consumer must
    // treat as "unknown", and not `false`, which would claim the viewer can see
    // a channel they are not in.
    expect(body.channels.map((c: any) => c.is_member)).toEqual([true]);

    // The owner sees BOTH of their own archived channels, each carrying the
    // fact computed for THEM: the field is per-viewer, not per-row-global.
    const asOwner = await (
      await http(t).get(`/api/workspaces/${wsId}/channels/archived`, { headers: OWNER })
    ).json() as any;
    expect(asOwner.channels.map((c: any) => c.id).sort()).toEqual([mine, theirs].sort());
    expect(asOwner.channels.every((c: any) => c.is_member === true)).toBe(true);
  });

  it('archived DM list carries is_member too (the endpoint has one shape for both workspace kinds)', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const dmChannelId = new ConversationRepo(t.ctx.db).listDmChannels()[0]?.id as string;
    expect(dmChannelId).toBeTruthy();
    expect(
      (await http(t).patch(`/api/channels/${dmChannelId}/archive`, { archived: true })).status,
    ).toBe(200);

    const home = ((await (await http(t).get('/api/workspaces')).json()) as any).workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === aliceId,
    );
    const body = await (
      await http(t).get(`/api/workspaces/${home.id}/channels/archived`)
    ).json() as any;
    expect(body.channels.map((c: any) => [c.id, c.kind, c.is_member])).toEqual([
      [dmChannelId, 'dm_channel', true],
    ]);
  });
});

describe('GET /api/archived-channels (cross-workspace aggregate)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns channels across workspaces with workspace name, sorted by archived_at DESC', async () => {
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
    expect(list.channels[1].channel.id).toBe(c1.channel.id);
    expect(list.channels[1].workspace.name).toBe('one');
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

// Route-wiring falsifiers. Channel detail + message history (the latter also
// serving thread content via `thread_root_id`) flipped from strict
// `canViewConversation` to the PUBLIC-aware `canReadConversation`. These pin
// the exact widening boundary: a workspace member who is NOT a conversation
// member reads a PUBLIC channel (200) but NOT a private one (403), and a
// non-workspace user is fail-closed even on public (403). If a gate ever
// regressed to plain `canViewConversation` the first case flips to 403; if it
// over-widened to `canViewWorkspace`-only the private/non-workspace cases flip
// to 200.
describe('GET channel detail + messages — public-read route wiring', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function setup(): Promise<{
    workspaceId: string;
    publicId: string;
    privateId: string;
  }> {
    const agentId = await makeAgent(t!, 'alice');
    const ws = (await (
      await http(t!).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agentId],
      })
    ).json()) as any;
    const workspaceId = ws.workspace.id as string;
    // Fresh channels created by `local` use creator-only seeding, so `teammate`
    // (a workspace member) is deliberately NOT a conversation member of either.
    const pub = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'public-room',
        member_agent_ids: [],
        visibility: 'public',
      })
    ).json()) as any;
    const priv = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'private-room',
        member_agent_ids: [],
      })
    ).json()) as any;
    return {
      workspaceId,
      publicId: pub.channel.id as string,
      privateId: priv.channel.id as string,
    };
  }

  // Precondition: `userId` is a workspace member but NOT a conversation member,
  // so a 200 proves the PUBLIC read widening rather than plain membership.
  function pinNonChannelMember(
    app: TestApp,
    channelId: string,
    workspaceId: string,
    userId: string,
  ): void {
    app.ctx.db
      .prepare('DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
      .run(channelId, userId);
    const wsRow = app.ctx.db
      .prepare('SELECT 1 AS hit FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, userId);
    expect(wsRow).not.toBeUndefined();
  }

  it('lets a workspace member (non-channel-member) read a PUBLIC channel detail + messages (200)', async () => {
    t = buildTestApp();
    const { workspaceId, publicId } = await setup();
    pinNonChannelMember(t, publicId, workspaceId, 'teammate');

    const teammate = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
    expect((await teammate.get(`/api/channels/${publicId}`)).status).toBe(200);
    expect((await teammate.get(`/api/channels/${publicId}/messages`)).status).toBe(200);
  });

  it('still forbids that same non-member on a PRIVATE channel (403)', async () => {
    t = buildTestApp();
    const { workspaceId, privateId } = await setup();
    pinNonChannelMember(t, privateId, workspaceId, 'teammate');

    const teammate = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
    expect((await teammate.get(`/api/channels/${privateId}`)).status).toBe(403);
    expect((await teammate.get(`/api/channels/${privateId}/messages`)).status).toBe(403);
  });

  it('forbids a NON-workspace user even on a PUBLIC channel (403)', async () => {
    t = buildTestApp();
    const { workspaceId, publicId } = await setup();
    // Strip 'other' from the workspace entirely — the public branch requires
    // canViewWorkspace, so a non-workspace user stays fail-closed.
    t.ctx.db
      .prepare('DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .run(workspaceId, 'other');
    const wsRow = t.ctx.db
      .prepare('SELECT 1 AS hit FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, 'other');
    expect(wsRow).toBeUndefined();

    const stranger = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('other'),
    });
    expect((await stranger.get(`/api/channels/${publicId}`)).status).toBe(403);
    expect((await stranger.get(`/api/channels/${publicId}/messages`)).status).toBe(403);
  });
});

// Authoritative per-viewer `is_member` on channel detail + neutralization of
// per-viewer `viewer_reacted` in the messages window for a public non-member.
// Membership is viewer-scoped SSOT computed at the route (not inferred by the
// renderer from a read succeeding); reaction COUNT is a pure read fact and is
// preserved, but `viewer_reacted` is a personal relation (same class as unread
// / follow / read-state) and reads false for a non-member.
describe('channel detail is_member + messages viewer_reacted neutralization', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function setupPublicChannelWithReaction(): Promise<{
    workspaceId: string;
    channelId: string;
    messageId: string;
  }> {
    const agentId = await makeAgent(t!, 'alice');
    const ws = (await (
      await http(t!).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agentId],
      })
    ).json()) as any;
    const workspaceId = ws.workspace.id as string;
    const pub = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'public-room',
        member_agent_ids: [],
        visibility: 'public',
      })
    ).json()) as any;
    const channelId = pub.channel.id as string;
    // A message reacted to by the creator/member `local` (via the real write
    // route, so canPostToConversation membership is exercised).
    const messageId = new MessageRepo(t!.ctx.db).insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'hi',
    }).id;
    expect(
      (await http(t!).post(`/api/messages/${messageId}/reactions`, { emoji: '👀' }))
        .status,
    ).toBe(200);
    return { workspaceId, channelId, messageId };
  }

  it('channel detail returns is_member=true for a member, false for a public non-member', async () => {
    t = buildTestApp();
    const { channelId } = await setupPublicChannelWithReaction();

    const asMember = (await (await http(t).get(`/api/channels/${channelId}`)).json()) as any;
    expect(asMember.is_member).toBe(true);

    t.ctx.db
      .prepare('DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
      .run(channelId, 'teammate');
    const teammate = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
    const res = await teammate.get(`/api/channels/${channelId}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).is_member).toBe(false);
  });

  it('neutralizes viewer_reacted=false for a public non-member while preserving count', async () => {
    t = buildTestApp();
    const { channelId, messageId } = await setupPublicChannelWithReaction();
    // Structural falsifier: a STRAY reaction row for teammate (as if a
    // since-removed member) must STILL read viewer_reacted=false via the
    // null-viewer path — the neutralization can't rely on "teammate has no
    // rows". The row is still counted (count is a pure read fact).
    t.ctx.db
      .prepare(
        `INSERT INTO message_reactions (id, message_id, reactor_kind, reactor_id, emoji, created_at)
         VALUES (?, ?, 'user', 'teammate', '👀', ?)`,
      )
      .run('rx-stray', messageId, 1);
    t.ctx.db
      .prepare('DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
      .run(channelId, 'teammate');

    const teammate = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
    const body = (await (
      await teammate.get(`/api/channels/${channelId}/messages`)
    ).json()) as any;
    const msg = body.messages.find((m: any) => m.id === messageId);
    const eyes = msg.reactions.find((r: any) => r.emoji === '👀');
    expect(eyes.count).toBe(2); // local + stray teammate row both counted
    expect(eyes.viewer_reacted).toBe(false); // neutralized despite teammate's own row
  });

  it('positive control: a reacting member reads viewer_reacted=true', async () => {
    t = buildTestApp();
    const { channelId, messageId } = await setupPublicChannelWithReaction();
    const body = (await (
      await http(t).get(`/api/channels/${channelId}/messages`)
    ).json()) as any;
    const msg = body.messages.find((m: any) => m.id === messageId);
    const eyes = msg.reactions.find((r: any) => r.emoji === '👀');
    expect(eyes.viewer_reacted).toBe(true);
  });

  // `linked_task` is a conversation-visible READ projection, NOT member-gated.
  // On a PUBLIC channel a workspace member browsing as a NON-channel-member
  // reads the same task chip a member does — unlike `viewer_reacted` (personal
  // relation, neutralized above). Only mutation + the cross-channel board are
  // member-gated.
  it('exposes linked_task to a public non-member (read projection, not member-gated)', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const ws = (await (
      await http(t).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agentId],
      })
    ).json()) as any;
    const workspaceId = ws.workspace.id as string;
    const pub = (await (
      await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'public-room',
        member_agent_ids: [agentId],
        visibility: 'public',
      })
    ).json()) as any;
    const channelId = pub.channel.id as string;

    // A source message from the agent, then a task bound to it via the agent
    // create route (the agent is a channel member, so source is accessible).
    const sourceId = new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'please fix the flaky test',
    }).id;
    const created = await http(t).post(
      `/internal/conversations/${channelId}/agents/${agentId}/tasks/create`,
      { tasks: [{ title: 'fix flaky test', source_message_id: sourceId }] },
    );
    expect(created.status).toBe(200);

    // `teammate` is a workspace member but NOT a channel member.
    t.ctx.db
      .prepare('DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
      .run(channelId, 'teammate');
    const teammate = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
    const res = await teammate.get(`/api/channels/${channelId}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const src = body.messages.find((m: any) => m.id === sourceId);
    expect(src.linked_task).not.toBeNull();
    expect(src.linked_task).toMatchObject({ title: 'fix flaky test', status: 'todo' });
  });
});

// Self-join a PUBLIC channel: the only non-member channel
// mutation. Proves the admission matrix (public-target validated BEFORE the
// already-member idempotency check, so a member of a non-public target cannot
// slip through), the self-only wire (no forgeable target — the route reads no
// body), and zero-increment idempotency on the row / attention preference /
// read cursor / events.
describe('POST /api/channels/:id/join — self-join public channel', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function setup(): Promise<{
    workspaceId: string;
    publicId: string;
    privateId: string;
  }> {
    const agentId = await makeAgent(t!, 'alice');
    const ws = (await (
      await http(t!).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agentId],
      })
    ).json()) as any;
    const workspaceId = ws.workspace.id as string;
    // Production-like membership (seedAllFixtureMemberships:false): make
    // `teammate` a WORKSPACE member, but creator-only channel seeding leaves
    // them a NON-member of every channel below.
    t!.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, 'member')`,
      )
      .run(workspaceId, 'teammate', Date.now());
    const pub = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'public-room',
        member_agent_ids: [],
        visibility: 'public',
      })
    ).json()) as any;
    const priv = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'private-room',
        member_agent_ids: [],
      })
    ).json()) as any;
    return {
      workspaceId,
      publicId: pub.channel.id as string,
      privateId: priv.channel.id as string,
    };
  }

  const asUser = (app: TestApp, user: string) =>
    http(app, { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(user) });

  function isMemberRow(app: TestApp, channelId: string, userId: string): boolean {
    return (
      app.ctx.db
        .prepare('SELECT 1 AS hit FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
        .get(channelId, userId) !== undefined
    );
  }

  function mainlineCursor(app: TestApp, channelId: string, userId: string): number | null {
    const row = app.ctx.db
      .prepare<[string, string], { last_read_seq: number }>(
        `SELECT last_read_seq FROM conversation_reads
          WHERE user_id = ? AND conversation_id = ? AND thread_root_id IS NULL`,
      )
      .get(userId, channelId);
    return row ? row.last_read_seq : null;
  }

  it('lets a workspace non-member self-join a PUBLIC channel → 200 {channel, is_member:true}', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    expect(isMemberRow(t, publicId, 'teammate')).toBe(false);
    // Pre-join history so the join baselines a read cursor (an empty channel
    // has no stream head to baseline to — nothing would be unread anyway).
    const head = new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: publicId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'pre-join history',
    });

    const res = await asUser(t, 'teammate').post(`/api/channels/${publicId}/join`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.channel.id).toBe(publicId);
    expect(body.is_member).toBe(true);
    expect(isMemberRow(t, publicId, 'teammate')).toBe(true);

    // Membership transition is same-source as admin-add: mention-only attention
    // preference seeded, read cursor baselined to the current head so pre-join
    // history is not unread.
    const pref = t.ctx.db
      .prepare<[string, string], { mode: string }>(
        'SELECT mode FROM channel_attention_preferences WHERE user_id = ? AND conversation_id = ?',
      )
      .get('teammate', publicId);
    expect(pref?.mode).toBe('mentions');
    expect(mainlineCursor(t, publicId, 'teammate')).toBe(head.seq);

    // Detail now reports the caller as a member (client backfills its cache).
    const detail = await asUser(t, 'teammate').get(`/api/channels/${publicId}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as any).is_member).toBe(true);
  });

  it('rejects self-join of a PRIVATE channel → 403, no membership row (non-channel ⊂ non-public)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    const res = await asUser(t, 'teammate').post(`/api/channels/${privateId}/join`, {});
    expect(res.status).toBe(403);
    expect(isMemberRow(t, privateId, 'teammate')).toBe(false);
  });

  it('rejects self-join of an ARCHIVED public channel → 403', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    expect(
      (await http(t).patch(`/api/channels/${publicId}/archive`, { archived: true })).status,
    ).toBe(200);
    const res = await asUser(t, 'teammate').post(`/api/channels/${publicId}/join`, {});
    expect(res.status).toBe(403);
    expect(isMemberRow(t, publicId, 'teammate')).toBe(false);
  });

  it('rejects self-join for a NON-workspace user even on a PUBLIC channel → 403', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, publicId } = await setup();
    t.ctx.db
      .prepare('DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .run(workspaceId, 'other');
    const res = await asUser(t, 'other').post(`/api/channels/${publicId}/join`, {});
    expect(res.status).toBe(403);
    expect(isMemberRow(t, publicId, 'other')).toBe(false);
  });

  it('rejects self-join of a dm_channel (non-channel kind) even for a workspace member → 403', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    await makeAgent(t, 'alice');
    const conversations = new ConversationRepo(t.ctx.db);
    const dm = conversations.listDmChannels()[0];
    expect(dm).toBeTruthy();
    // Give `teammate` workspace membership on the dm's workspace so the 403 is
    // the kind/visibility guard (dm_channel is always private), not the
    // canViewWorkspace guard.
    t.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, 'member')`,
      )
      .run(dm!.workspace_id, 'teammate', Date.now());
    const res = await asUser(t, 'teammate').post(`/api/channels/${dm!.id}/join`, {});
    expect(res.status).toBe(403);
    expect(isMemberRow(t, dm!.id, 'teammate')).toBe(false);
  });

  it('rejects /join for an EXISTING member of a PRIVATE channel — target validated before idempotency', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    // Make `teammate` a real member of the PRIVATE channel (via the repo so all
    // required columns are written).
    new ConversationRepo(t.ctx.db).addUser(privateId, 'teammate');
    expect(isMemberRow(t, privateId, 'teammate')).toBe(true);
    // A member of a NON-public target must NOT get a success from /join: the
    // public-target admission runs BEFORE the already-member idempotency check.
    const res = await asUser(t, 'teammate').post(`/api/channels/${privateId}/join`, {});
    expect(res.status).toBe(403);
  });

  it('is self-only: the route reads no body, so a forged target user is never added', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    // teammate posts a body naming `other` as the member — the route ignores it.
    const res = await asUser(t, 'teammate').post(`/api/channels/${publicId}/join`, {
      member_user_id: 'other',
      user_id: 'other',
    });
    expect(res.status).toBe(200);
    expect(isMemberRow(t, publicId, 'teammate')).toBe(true); // caller joined
    expect(isMemberRow(t, publicId, 'other')).toBe(false); // forged target NOT joined
  });

  it('idempotent retry is zero-increment: exact cursor, single row/pref, no repeat events', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, publicId } = await setup();
    const messages = new MessageRepo(t.ctx.db);
    // Some pre-join history.
    messages.insertForConversation({ conversationId: publicId, fromKind: 'user', fromUserId: 'local', content: 'hello' });

    // First join baselines the cursor to the current mainline head.
    expect((await asUser(t, 'teammate').post(`/api/channels/${publicId}/join`, {})).status).toBe(200);
    const cursorAfterJoin = mainlineCursor(t, publicId, 'teammate');
    expect(cursorAfterJoin).not.toBeNull();

    // A NEW message advances the mainline head. If the baseline erroneously
    // re-ran on retry, the monotonic markRead would silently ADVANCE the cursor
    // to this — "not regressed" is insufficient; assert EXACTLY unchanged.
    messages.insertForConversation({ conversationId: publicId, fromKind: 'user', fromUserId: 'local', content: 'posted after join' });

    // Capture events only for the retry window.
    const events: string[] = [];
    const unsubSide = t.ctx.events.subscribeScope(conversationSideScope(publicId), e => events.push(e.kind));
    const unsubWs = t.ctx.events.subscribeScope(`workspace:${workspaceId}`, e => events.push(e.kind));

    // Retry: already a member → zero-increment.
    const retry = await asUser(t, 'teammate').post(`/api/channels/${publicId}/join`, {});
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as any).is_member).toBe(true);

    unsubSide();
    unsubWs();
    // Cursor EXACTLY unchanged — the alreadyMember early-return skipped the
    // baseline write entirely (did not advance to the post-join message).
    expect(mainlineCursor(t, publicId, 'teammate')).toBe(cursorAfterJoin);
    // No duplicate membership row, no duplicate attention preference.
    const rowCount = (t.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
      .get(publicId, 'teammate') as any).n;
    expect(rowCount).toBe(1);
    const prefCount = (t.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM channel_attention_preferences WHERE conversation_id = ? AND user_id = ?')
      .get(publicId, 'teammate') as any).n;
    expect(prefCount).toBe(1);
    // No membership/list invalidation events on the idempotent no-op.
    expect(events).not.toContain('conversation_members_changed');
    expect(events).not.toContain('workspace_channels_changed');
  });

  it('first join DOES fire conversation_members_changed + workspace_channels_changed', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, publicId } = await setup();
    const events: string[] = [];
    const unsubSide = t.ctx.events.subscribeScope(conversationSideScope(publicId), e => events.push(e.kind));
    const unsubWs = t.ctx.events.subscribeScope(`workspace:${workspaceId}`, e => events.push(e.kind));
    const unsubMain = t.ctx.events.subscribe(publicId, e => events.push(e.kind));
    // Self-join must NOT touch workspace membership → no viewer_workspaces_changed.
    // Subscribe the joiner's viewer scope so a future erroneous publish is caught.
    const viewerEvents: string[] = [];
    const unsubViewer = t.ctx.events.subscribeScope('viewer:teammate', e => viewerEvents.push(e.kind));

    expect((await asUser(t, 'teammate').post(`/api/channels/${publicId}/join`, {})).status).toBe(200);

    unsubSide();
    unsubWs();
    unsubMain();
    unsubViewer();
    expect(events).toContain('conversation_members_changed');
    expect(events).toContain('workspace_channels_changed');
    // No member-added system message on a self-join (would publish to the
    // main-line conversation scope, which unsubMain covers).
    expect(events).not.toContain('message');
    // Joining a channel is not a workspace-membership change.
    expect(viewerEvents).not.toContain('viewer_workspaces_changed');
  });
});

// Self-leave a channel + private/public visibility toggle, plus the
// settings-modal capability carriers on channel detail. The membership
// mutations are additive onto the existing visibility model (v58 column + the
// three permission gates + `conversation_users` + self-join); leave is the
// symmetric counterpart of /join. These suites prove: member-only leave, the
// archived + last-human-of-private guards, the §12 projection convergence
// (leaver drops from the membership-scoped unread rollup while a PUBLIC channel
// stays in the discovery union), the admin/human visibility gate + non-member
// eject on public→private, exactly-one PATCH, and the carrier values.
describe('POST /api/channels/:id/leave — self-leave a channel', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const asUser = (app: TestApp, user: string) =>
    http(app, { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(user) });

  function isMemberRow(app: TestApp, channelId: string, userId: string): boolean {
    return (
      app.ctx.db
        .prepare('SELECT 1 AS hit FROM conversation_users WHERE conversation_id = ? AND user_id = ?')
        .get(channelId, userId) !== undefined
    );
  }

  /** Workspace (creator `local` = owner) + `teammate` as a workspace member who
   *  is ALSO made a channel member (via the repo) of one public + one private
   *  channel — the leave preconditions. The private channel keeps `local` as a
   *  second human so a `teammate` leave is not the last-human orphan case. */
  async function setup(): Promise<{
    workspaceId: string;
    publicId: string;
    privateId: string;
  }> {
    const agentId = await makeAgent(t!, 'alice');
    const ws = (await (
      await http(t!).post('/api/workspaces', { name: 'eng', member_agent_ids: [agentId] })
    ).json()) as any;
    const workspaceId = ws.workspace.id as string;
    t!.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, 'member')`,
      )
      .run(workspaceId, 'teammate', Date.now());
    const pub = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'public-room',
        member_agent_ids: [],
        visibility: 'public',
      })
    ).json()) as any;
    const priv = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'private-room',
        member_agent_ids: [],
      })
    ).json()) as any;
    const conversations = new ConversationRepo(t!.ctx.db);
    conversations.addUser(pub.channel.id, 'teammate');
    conversations.addUser(priv.channel.id, 'teammate');
    return {
      workspaceId,
      publicId: pub.channel.id as string,
      privateId: priv.channel.id as string,
    };
  }

  it('member leaves a PUBLIC channel → 200 is_member:false, edge gone, channel stays in discovery union', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, publicId } = await setup();
    expect(isMemberRow(t, publicId, 'teammate')).toBe(true);

    const res = await asUser(t, 'teammate').post(`/api/channels/${publicId}/leave`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.channel.id).toBe(publicId);
    expect(body.is_member).toBe(false);
    expect(isMemberRow(t, publicId, 'teammate')).toBe(false);

    // Public → still discoverable + joinable for the now-non-member (is_member:false).
    const list = (await (
      await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)
    ).json()) as any;
    const item = list.channels.find((c: any) => c.id === publicId);
    expect(item).toBeTruthy();
    expect(item.is_member).toBe(false);
  });

  it('member leaves a PRIVATE channel → 200, drops from discovery + detail 403 (visibility loss)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, privateId } = await setup();
    const res = await asUser(t, 'teammate').post(`/api/channels/${privateId}/leave`, {});
    expect(res.status).toBe(200);
    expect(isMemberRow(t, privateId, 'teammate')).toBe(false);

    // Private → the ex-member can no longer resolve detail (read-path validation).
    expect((await asUser(t, 'teammate').get(`/api/channels/${privateId}`)).status).toBe(403);
    // …and it is absent from their discovery union.
    const list = (await (
      await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)
    ).json()) as any;
    expect(list.channels.find((c: any) => c.id === privateId)).toBeUndefined();
  });

  it('§12 convergence: after leaving, the channel drops from the membership-scoped unread rollup', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, publicId } = await setup();
    // A message teammate has not read → unread while a member (no baseline cursor
    // from a raw addUser).
    new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: publicId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'unread for teammate',
    });
    const reads = new ConversationReadRepo(t.ctx.db);
    const before = reads.unreadCountsByConversationForWorkspace(workspaceId, 'teammate');
    expect(before.by_conversation[publicId]).toBeGreaterThan(0);

    expect((await asUser(t, 'teammate').post(`/api/channels/${publicId}/leave`, {})).status).toBe(200);

    // Membership-scoped rollup INNER-joins conversation_users → the leaver is
    // excluded the instant the edge is gone (no per-projection cleanup needed).
    const after = reads.unreadCountsByConversationForWorkspace(workspaceId, 'teammate');
    expect(after.by_conversation[publicId]).toBeUndefined();
  });

  it('non-member leave → 403 not_member (member-only; idempotency must not outrank permission)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    // `other` is not a workspace/channel member.
    const res = await asUser(t, 'other').post(`/api/channels/${publicId}/leave`, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe('not_member');
  });

  it('a second leave after leaving → 403 not_member (leave is member-only, no 200 no-op)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    expect((await asUser(t, 'teammate').post(`/api/channels/${publicId}/leave`, {})).status).toBe(200);
    const second = await asUser(t, 'teammate').post(`/api/channels/${publicId}/leave`, {});
    expect(second.status).toBe(403);
    expect(((await second.json()) as any).code).toBe('not_member');
  });

  it('leaving an ARCHIVED channel → 409 channel_archived (archived is frozen in v1)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    expect((await http(t).patch(`/api/channels/${publicId}/archive`, { archived: true })).status).toBe(200);
    const res = await asUser(t, 'teammate').post(`/api/channels/${publicId}/leave`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('channel_archived');
    expect(isMemberRow(t, publicId, 'teammate')).toBe(true);
  });

  it('last HUMAN member of a PRIVATE channel → 409 last_human_member (orphan guard)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    // Make `teammate` the SOLE human member of the private channel.
    new ConversationRepo(t.ctx.db).removeUser(privateId, 'local');
    const res = await asUser(t, 'teammate').post(`/api/channels/${privateId}/leave`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('last_human_member');
    expect(isMemberRow(t, privateId, 'teammate')).toBe(true);
  });

  it('OWNER of a PRIVATE channel cannot leave even with other humans present → 409 channel_owner', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    // `local` is the workspace OWNER and a member of the private channel;
    // `teammate` is also a member, so this is NOT the last-human case — the
    // block is the owner-bound governance guard, not the orphan guard.
    expect(isMemberRow(t, privateId, 'teammate')).toBe(true);
    const res = await http(t).post(`/api/channels/${privateId}/leave`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('channel_owner');
    expect(isMemberRow(t, privateId, 'local')).toBe(true);
  });

  it('OWNER MAY leave a PUBLIC channel (owner guard is private-only)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    const res = await http(t).post(`/api/channels/${publicId}/leave`, {});
    expect(res.status).toBe(200);
    expect(isMemberRow(t, publicId, 'local')).toBe(false);
  });

  it('owner-of-private guard outranks last_human_member when the owner is the sole human → channel_owner', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    // Make the OWNER (`local`) the sole human of the private channel: both the
    // owner guard AND the last-human guard now apply; the more-specific owner
    // reason must win (it is checked first).
    new ConversationRepo(t.ctx.db).removeUser(privateId, 'teammate');
    const res = await http(t).post(`/api/channels/${privateId}/leave`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('channel_owner');
    expect(isMemberRow(t, privateId, 'local')).toBe(true);
  });

  it('a non-owner ADMIN MAY leave a PRIVATE channel while the owner remains (guard is owner-only, not admin)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, privateId } = await setup();
    // Promote `teammate` to admin — governance authority, but still NOT owner.
    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'admin' WHERE workspace_id = ? AND user_id = ?`)
      .run(workspaceId, 'teammate');
    const res = await asUser(t, 'teammate').post(`/api/channels/${privateId}/leave`, {});
    expect(res.status).toBe(200);
    expect(isMemberRow(t, privateId, 'teammate')).toBe(false);
    // Owner `local` remains → the channel is not stranded.
    expect(isMemberRow(t, privateId, 'local')).toBe(true);
  });

  it('active PUBLIC channel has NO orphan guard: the last human may leave (drop to 0 humans)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    new ConversationRepo(t.ctx.db).removeUser(publicId, 'local');
    const res = await asUser(t, 'teammate').post(`/api/channels/${publicId}/leave`, {});
    expect(res.status).toBe(200);
    expect(isMemberRow(t, publicId, 'teammate')).toBe(false);
  });

  it('leave fires conversation_members_changed + workspace_channels_changed, no message, no viewer_workspaces_changed', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, publicId } = await setup();
    const events: string[] = [];
    const unsubSide = t.ctx.events.subscribeScope(conversationSideScope(publicId), e => events.push(e.kind));
    const unsubWs = t.ctx.events.subscribeScope(`workspace:${workspaceId}`, e => events.push(e.kind));
    const unsubMain = t.ctx.events.subscribe(publicId, e => events.push(e.kind));
    const viewerEvents: string[] = [];
    const unsubViewer = t.ctx.events.subscribeScope('viewer:teammate', e => viewerEvents.push(e.kind));

    expect((await asUser(t, 'teammate').post(`/api/channels/${publicId}/leave`, {})).status).toBe(200);

    unsubSide();
    unsubWs();
    unsubMain();
    unsubViewer();
    expect(events).toContain('conversation_members_changed');
    expect(events).toContain('workspace_channels_changed');
    expect(events).not.toContain('message'); // v1 silent, no system message
    expect(viewerEvents).not.toContain('viewer_workspaces_changed'); // workspace membership unchanged
  });

  it('leaving a dm_channel / unknown id → 404 (leave is regular-channel only)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    await makeAgent(t, 'alice');
    const dm = new ConversationRepo(t.ctx.db).listDmChannels()[0];
    expect(dm).toBeTruthy();
    t.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, 'member')`,
      )
      .run(dm!.workspace_id, 'teammate', Date.now());
    expect((await asUser(t, 'teammate').post(`/api/channels/${dm!.id}/leave`, {})).status).toBe(404);
    expect((await asUser(t, 'teammate').post('/api/channels/does-not-exist/leave', {})).status).toBe(404);
  });
});

describe('PATCH /api/channels/:id — private/public visibility toggle', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const asUser = (app: TestApp, user: string) =>
    http(app, { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(user) });

  async function setup(): Promise<{ workspaceId: string; publicId: string; privateId: string }> {
    const agentId = await makeAgent(t!, 'alice');
    const ws = (await (
      await http(t!).post('/api/workspaces', { name: 'eng', member_agent_ids: [agentId] })
    ).json()) as any;
    const workspaceId = ws.workspace.id as string;
    t!.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, 'member')`,
      )
      .run(workspaceId, 'teammate', Date.now());
    const pub = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'public-room', member_agent_ids: [], visibility: 'public',
      })
    ).json()) as any;
    const priv = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'private-room', member_agent_ids: [],
      })
    ).json()) as any;
    return { workspaceId, publicId: pub.channel.id as string, privateId: priv.channel.id as string };
  }

  it('admin private→public → 200; the channel enters a non-member’s discovery union', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, privateId } = await setup();
    // Before: teammate (non-member) cannot see the private channel.
    let list = (await (await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)).json()) as any;
    expect(list.channels.find((c: any) => c.id === privateId)).toBeUndefined();

    const res = await http(t).patch(`/api/channels/${privateId}`, { visibility: 'public' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channel.visibility).toBe('public');

    // After: the browse-and-join surface shows it as is_member:false.
    list = (await (await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)).json()) as any;
    const item = list.channels.find((c: any) => c.id === privateId);
    expect(item).toBeTruthy();
    expect(item.is_member).toBe(false);
  });

  it('admin public→private → 200; a non-member is ejected (detail 403, drops from discovery)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, publicId } = await setup();
    // teammate can read the public channel as a non-member beforehand.
    expect((await asUser(t, 'teammate').get(`/api/channels/${publicId}`)).status).toBe(200);

    const res = await http(t).patch(`/api/channels/${publicId}`, { visibility: 'private' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channel.visibility).toBe('private');

    // Non-member read-path validation now denies (visibility loss) + discovery drops it.
    expect((await asUser(t, 'teammate').get(`/api/channels/${publicId}`)).status).toBe(403);
    const list = (await (await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)).json()) as any;
    expect(list.channels.find((c: any) => c.id === publicId)).toBeUndefined();
  });

  it('same-value toggle → 200 no-op, no workspace_channels_changed emitted', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, privateId } = await setup();
    const events: string[] = [];
    const unsub = t.ctx.events.subscribeScope(`workspace:${workspaceId}`, e => events.push(e.kind));
    const res = await http(t).patch(`/api/channels/${privateId}`, { visibility: 'private' });
    expect(res.status).toBe(200);
    unsub();
    expect(events).not.toContain('workspace_channels_changed');
  });

  it('a non-admin workspace member cannot toggle visibility → 403', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    const res = await asUser(t, 'teammate').patch(`/api/channels/${privateId}`, { visibility: 'public' });
    expect(res.status).toBe(403);
  });

  it('exactly-one mutation: title+visibility together → 400; neither → 400', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    expect((await http(t).patch(`/api/channels/${privateId}`, { title: 'x', visibility: 'public' })).status).toBe(400);
    expect((await http(t).patch(`/api/channels/${privateId}`, {})).status).toBe(400);
    // A lone title still works (rename path unchanged).
    expect((await http(t).patch(`/api/channels/${privateId}`, { title: 'renamed' })).status).toBe(200);
  });
});

describe('GET /api/channels/:id — settings-modal capability carriers', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const asUser = (app: TestApp, user: string) =>
    http(app, { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(user) });

  async function setup(): Promise<{ workspaceId: string; publicId: string; privateId: string }> {
    const agentId = await makeAgent(t!, 'alice');
    const ws = (await (
      await http(t!).post('/api/workspaces', { name: 'eng', member_agent_ids: [agentId] })
    ).json()) as any;
    const workspaceId = ws.workspace.id as string;
    t!.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, 'member')`,
      )
      .run(workspaceId, 'teammate', Date.now());
    const pub = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'public-room', member_agent_ids: [], visibility: 'public',
      })
    ).json()) as any;
    const priv = (await (
      await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'private-room', member_agent_ids: [],
      })
    ).json()) as any;
    return { workspaceId, publicId: pub.channel.id as string, privateId: priv.channel.id as string };
  }

  it('admin member of a public channel: can_leave true, can_update_visibility true', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    const body = (await (await http(t).get(`/api/channels/${publicId}`)).json()) as any;
    expect(body.is_member).toBe(true);
    expect(body.can_leave).toBe(true);
    expect(body.leave_blocked_reason).toBeNull();
    expect(body.can_update_visibility).toBe(true);
  });

  it('public non-member: is_member false, can_leave false reason not_member, cannot govern', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    const body = (await (await asUser(t, 'teammate').get(`/api/channels/${publicId}`)).json()) as any;
    expect(body.is_member).toBe(false);
    expect(body.can_leave).toBe(false);
    expect(body.leave_blocked_reason).toBe('not_member');
    expect(body.can_update_visibility).toBe(false); // teammate is a plain member
  });

  it('OWNER of a private channel: can_leave false reason channel_owner (even with other humans)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    // `local` is the workspace owner + creator-member; add `teammate` so the
    // block is the owner guard, not the last-human orphan guard.
    new ConversationRepo(t.ctx.db).addUser(privateId, 'teammate');
    const body = (await (await http(t).get(`/api/channels/${privateId}`)).json()) as any;
    expect(body.is_member).toBe(true);
    expect(body.can_leave).toBe(false);
    expect(body.leave_blocked_reason).toBe('channel_owner');
  });

  it('last human of a private channel (non-owner): can_leave false reason last_human_member', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { privateId } = await setup();
    // Make plain-member `teammate` the SOLE human (owner `local` removed) so the
    // owner guard does not fire and last_human_member is the surviving reason.
    const conversations = new ConversationRepo(t.ctx.db);
    conversations.addUser(privateId, 'teammate');
    conversations.removeUser(privateId, 'local');
    const body = (await (await asUser(t, 'teammate').get(`/api/channels/${privateId}`)).json()) as any;
    expect(body.is_member).toBe(true);
    expect(body.can_leave).toBe(false);
    expect(body.leave_blocked_reason).toBe('last_human_member');
  });

  it('archived channel member: can_leave false reason channel_archived', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { publicId } = await setup();
    expect((await http(t).patch(`/api/channels/${publicId}/archive`, { archived: true })).status).toBe(200);
    const body = (await (await http(t).get(`/api/channels/${publicId}`)).json()) as any;
    expect(body.can_leave).toBe(false);
    expect(body.leave_blocked_reason).toBe('channel_archived');
  });
});

describe('GET /api/workspaces/:id/channels — discovery union + per-item is_member', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const asUser = (app: TestApp, user: string) =>
    http(app, { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(user) });

  /** Workspace with `teammate` as a WORKSPACE member (not channel member).
   *  Creator-only channel seeding (seedAllFixtureMemberships:false) leaves
   *  teammate a non-member of every channel until they join / are added. */
  async function setup(): Promise<{
    workspaceId: string;
    pubJoined: string;
    pubUnjoined: string;
    privJoined: string;
    privUnjoined: string;
  }> {
    const agentId = await makeAgent(t!, 'alice');
    const ws = (await (
      await http(t!).post('/api/workspaces', { name: 'eng', member_agent_ids: [agentId] })
    ).json()) as any;
    const workspaceId = ws.workspace.id as string;
    t!.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, joined_at, role)
         VALUES (?, ?, ?, 'member')`,
      )
      .run(workspaceId, 'teammate', Date.now());
    const mk = async (title: string, visibility?: 'public') => {
      const r = (await (
        await http(t!).post(`/api/workspaces/${workspaceId}/channels`, {
          title,
          member_agent_ids: [],
          ...(visibility ? { visibility } : {}),
        })
      ).json()) as any;
      return r.channel.id as string;
    };
    const pubJoined = await mk('pub-joined', 'public');
    const pubUnjoined = await mk('pub-unjoined', 'public');
    const privJoined = await mk('priv-joined');
    const privUnjoined = await mk('priv-unjoined');
    // teammate joins one public + is added to one private.
    expect((await asUser(t!, 'teammate').post(`/api/channels/${pubJoined}/join`, {})).status).toBe(200);
    new ConversationRepo(t!.ctx.db).addUser(privJoined, 'teammate');
    return { workspaceId, pubJoined, pubUnjoined, privJoined, privUnjoined };
  }

  function membershipById(channels: any[]): Record<string, boolean> {
    return Object.fromEntries(channels.map(c => [c.id, c.is_member as boolean]));
  }

  it('unions joined (any visibility) + unjoined public; excludes unjoined private; per-item is_member correct', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, pubJoined, pubUnjoined, privJoined, privUnjoined } = await setup();

    const body = (await (
      await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)
    ).json()) as any;
    const membership = membershipById(body.channels);

    expect(membership[pubJoined]).toBe(true);
    expect(membership[pubUnjoined]).toBe(false);
    expect(membership[privJoined]).toBe(true);
    // Unjoined PRIVATE never appears in the discovery union.
    expect(privUnjoined in membership).toBe(false);
    // Exactly the three expected channels, no more.
    expect(Object.keys(membership).sort()).toEqual([pubJoined, pubUnjoined, privJoined].sort());
  });

  it('excludes an ARCHIVED public channel from the discovery union', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, pubUnjoined } = await setup();
    expect((await http(t).patch(`/api/channels/${pubUnjoined}/archive`, { archived: true })).status).toBe(200);

    const body = (await (
      await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)
    ).json()) as any;
    expect(body.channels.map((c: any) => c.id)).not.toContain(pubUnjoined);
  });

  it('is_member flips false → true after the viewer self-joins the public channel', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, pubUnjoined } = await setup();

    const before = membershipById(
      ((await (await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)).json()) as any).channels,
    );
    expect(before[pubUnjoined]).toBe(false);

    expect((await asUser(t, 'teammate').post(`/api/channels/${pubUnjoined}/join`, {})).status).toBe(200);

    const after = membershipById(
      ((await (await asUser(t, 'teammate').get(`/api/workspaces/${workspaceId}/channels`)).json()) as any).channels,
    );
    expect(after[pubUnjoined]).toBe(true);
  });

  it('the creator (a member of every channel they created) sees is_member:true on all of them', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { pubJoined, pubUnjoined, privJoined, privUnjoined, workspaceId } = await setup();

    const body = (await (await http(t).get(`/api/workspaces/${workspaceId}/channels`)).json()) as any;
    const membership = membershipById(body.channels);
    for (const id of [pubJoined, pubUnjoined, privJoined, privUnjoined]) {
      expect(membership[id]).toBe(true);
    }
  });

  it('DM (agent_home) items carry authoritative is_member:true — no missing field for the renderer gate', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
    const home = wsList.workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === aliceId,
    );
    expect(home).toBeTruthy();

    const body = (await (await http(t).get(`/api/workspaces/${home.id}/channels`)).json()) as any;
    expect(body.channels.length).toBeGreaterThan(0);
    for (const item of body.channels) {
      // Every DM item is a dm_channel and carries an authoritative boolean —
      // the field is PRESENT (never undefined), so the gate never falls to
      // unknown/detail on a DM, and it is always true (DM list is strictly
      // membership-filtered).
      expect(item.kind).toBe('dm_channel');
      expect(item.is_member).toBe(true);
    }
  });
});

/**
 * #task:1987 — the channel-creation governance check exists TWICE: the route's
 * pre-lock `canGovernWorkspace(…, 'admin')` gate, and the re-derivation from the
 * role row inside the write lock (a demotion committing in the seam). They are
 * ONE refusal, so they owe ONE HTTP response. This compares the real pre-lock
 * response against the production mapper's rendering of the in-lock error, so
 * changing either side reddens instead of silently splitting the contract into a
 * public `forbidden` and an internal concurrency code.
 */
describe('POST /api/workspaces/:id/channels — governance refusal is one wire contract', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('renders the in-lock refusal exactly as the route pre-lock gate does', async () => {
    // `seedAllFixtureMemberships: false` — the permissive fixture trigger would
    // seat the viewer as `owner` and the gate would never refuse.
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const OWNER = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const created = await (await http(t).post(
      '/api/workspaces',
      { name: 'governed', member_agent_ids: [] },
      { headers: OWNER },
    )).json() as any;
    const workspaceId = created.workspace.id as string;
    // `local` (the default identity of `http(t)`) joins as a plain member — the
    // role the route's `admin` gate refuses.
    expect(
      (await http(t).post(
        `/api/workspaces/${workspaceId}/members`,
        { kind: 'human', user_id: 'local' },
        { headers: OWNER },
      )).status,
    ).toBe(201);

    const gate = await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title: 'nope',
      member_agent_ids: [],
      member_user_ids: [],
    });
    expect(gate.status).toBe(403);
    const gateBody = await gate.json();
    expect(gateBody).toEqual({ error: 'forbidden' });

    // The same refusal reached one lock later, through the production mapper.
    const mapper = new Hono();
    mapper.get('/', c =>
      channelServiceErrorResponse(
        c,
        new ActorError(
          'user_cannot_govern_workspace',
          'user does not govern this workspace',
        ),
      ) ?? c.text('unmapped', 500),
    );
    const mapped = await mapper.request('/');
    expect(mapped.status).toBe(gate.status);
    expect(await mapped.json()).toEqual(gateBody);
  });
});
