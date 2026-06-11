import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('workspace/conversation routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lists regular and agent_home workspaces with their channel conversations', async () => {
    t = buildTestApp();
    const agentBody = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const workspaceBody = await (
      await http(t).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agentBody.agent.id],
      })
    ).json() as any;

    const workspaces = await (
      await http(t).get('/api/workspaces')
    ).json() as any;
    const regular = workspaces.workspaces.find((w: any) => w.id === workspaceBody.workspace.id);
    const home = workspaces.workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === agentBody.agent.id,
    );
    expect(regular).toBeDefined();
    expect(home).toBeDefined();
    expect(home.dm_channel_ids).toEqual([home.dm_channel_id]);

    const channels = await (
      await http(t).get(`/api/workspaces/${workspaceBody.workspace.id}/channels`)
    ).json() as any;
    expect(channels.channels).toHaveLength(1);
    expect(channels.channels[0]).toMatchObject({
      id: workspaceBody.onboarding_channel_id,
      workspace_id: workspaceBody.workspace.id,
      kind: 'channel',
      workspace_path: workspaceBody.workspace.workspace_path,
    });

    const dms = await (
      await http(t).get(`/api/workspaces/${home.id}/channels`)
    ).json() as any;
    expect(dms.channels).toHaveLength(1);
    expect(dms.channels[0]).toMatchObject({
      kind: 'dm_channel',
      workspace_id: home.id,
      workspace_path: join(t.ctx.silverhandDir, 'agents', agentBody.agent.id),
    });

    const secondary = await (
      await http(t).post(`/api/workspaces/${home.id}/channels`, {
        title: 'Mentions',
        member_agent_ids: [],
      })
    ).json() as any;
    expect(secondary.channel).toMatchObject({
      kind: 'dm_channel',
      workspace_id: home.id,
      title: 'Mentions',
    });
    const dmsAfter = await (
      await http(t).get(`/api/workspaces/${home.id}/channels`)
    ).json() as any;
    expect(dmsAfter.channels.map((c: any) => c.id)).toEqual([
      dms.channels[0].id,
      secondary.channel.id,
    ]);
    const workspacesAfter = await (
      await http(t).get('/api/workspaces')
    ).json() as any;
    const homeAfter = workspacesAfter.workspaces.find((w: any) => w.id === home.id);
    expect(homeAfter.dm_channel_id).toBe(dms.channels[0].id);
    expect(homeAfter.dm_channel_ids).toEqual([
      dms.channels[0].id,
      secondary.channel.id,
    ]);
  });

  it('defaults workspace host to the creator owned local host', async () => {
    t = buildTestApp();
    const ownedLocal = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
    const res = await http(t).post('/api/workspaces', {
      name: 'owned-host-default',
      member_agent_ids: [],
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.workspace.workspace_host_id).toBe(ownedLocal?.id);
  });

  it('adds selected human initial members to workspace and onboarding channel', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );

    const res = await http(t).post('/api/workspaces', {
      name: 'initial-humans',
      member_agent_ids: [],
      member_user_ids: ['teammate'],
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    const workspaceUsers = t.ctx.db
      .prepare(
        `SELECT user_id FROM workspace_users
         WHERE workspace_id = ?
         ORDER BY user_id`,
      )
      .all(body.workspace.id)
      .map((row: any) => row.user_id);
    const onboardingUsers = t.ctx.db
      .prepare(
        `SELECT user_id FROM conversation_users
         WHERE conversation_id = ?
         ORDER BY user_id`,
      )
      .all(body.onboarding_channel_id)
      .map((row: any) => row.user_id);

    expect(workspaceUsers).toEqual(['local', 'teammate']);
    expect(onboardingUsers).toEqual(['local', 'teammate']);
  });

  it('creates regular channels with selected human members', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );

    const workspaceRes = await http(t).post('/api/workspaces', {
      name: 'channel-humans',
      member_agent_ids: [],
      member_user_ids: ['teammate'],
    });
    expect(workspaceRes.status).toBe(201);
    const workspaceBody = await workspaceRes.json() as any;

    const creatorOnlyRes = await http(t).post(
      `/api/workspaces/${workspaceBody.workspace.id}/channels`,
      {
        title: 'creator-only',
        member_agent_ids: [],
        member_user_ids: [],
      },
    );
    expect(creatorOnlyRes.status).toBe(201);
    const creatorOnlyBody = await creatorOnlyRes.json() as any;
    const creatorOnlyUsers = t.ctx.db
      .prepare(
        `SELECT user_id FROM conversation_users
         WHERE conversation_id = ?
         ORDER BY user_id`,
      )
      .all(creatorOnlyBody.channel.id)
      .map((row: any) => row.user_id);
    expect(creatorOnlyUsers).toEqual(['local']);

    const teammateRes = await http(t).post(
      `/api/workspaces/${workspaceBody.workspace.id}/channels`,
      {
        title: 'with-teammate',
        member_agent_ids: [],
        member_user_ids: ['teammate'],
      },
    );
    expect(teammateRes.status).toBe(201);
    const teammateBody = await teammateRes.json() as any;
    const teammateUsers = t.ctx.db
      .prepare(
        `SELECT user_id FROM conversation_users
         WHERE conversation_id = ?
         ORDER BY user_id`,
      )
      .all(teammateBody.channel.id)
      .map((row: any) => row.user_id);
    expect(teammateUsers).toEqual(['local', 'teammate']);
  });

  it('fails closed when workspace creator has no owned local host', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const res = await http(t).post('/api/workspaces', {
      name: 'no-local-host',
      member_agent_ids: [],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'local_host_unbound' });
  });

  it('rejects an explicit workspace host owned by another user', async () => {
    t = buildTestApp();
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('teammate');
    expect(teammateHost).not.toBeNull();
    const res = await http(t).post('/api/workspaces', {
      name: 'cross-user-host',
      workspace_host_id: teammateHost!.id,
      member_agent_ids: [],
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'host_not_owned' });
  });

  it('rejects workspace create members whose host does not match the workspace host', async () => {
    t = buildTestApp();
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const teammateAgent = await (
      await http(t).post(
        '/api/agents',
        { name: 'teammate-agent', runtime: 'claude' },
        { headers: teammateHeaders },
      )
    ).json() as any;

    const res = await http(t).post('/api/workspaces', {
      name: 'host-mismatch-create',
      member_agent_ids: [teammateAgent.agent.id],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'host_mismatch' });
  });

  it('rejects addMember when agent and workspace hosts differ', async () => {
    t = buildTestApp();
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const teammateAgent = await (
      await http(t).post(
        '/api/agents',
        { name: 'teammate-member', runtime: 'claude' },
        { headers: teammateHeaders },
      )
    ).json() as any;
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'host-mismatch-add',
        member_agent_ids: [],
      })
    ).json() as any;

    const res = await http(t).post(
      `/api/workspaces/${workspace.workspace.id}/members`,
      { agent_id: teammateAgent.agent.id },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'host_mismatch' });
  });

  it('enforces channel/thread kind guards on message routes', async () => {
    t = buildTestApp();
    const agentBody = await (
      await http(t).post('/api/agents', { name: 'bob', runtime: 'claude' })
    ).json() as any;
    const workspaceBody = await (
      await http(t).post('/api/workspaces', {
        name: 'guards',
        member_agent_ids: [agentBody.agent.id],
      })
    ).json() as any;

    const channelId = workspaceBody.onboarding_channel_id;
    expect((await http(t).get(`/api/channels/${channelId}/messages`)).status)
      .toBe(200);
    expect((await http(t).get(`/api/threads/${channelId}/messages`)).status)
      .toBe(404);

    const conversations = new ConversationRepo(t.ctx.db);
    const thread = conversations.insertThread({
      channelId,
      title: 'legacy thread',
    });
    conversations.addAgent(thread.id, agentBody.agent.id);
    for (const member of conversations.listUsers(channelId)) {
      conversations.addUser(thread.id, member.user_id);
    }
    const threadId = thread.id;

    expect((await http(t).get(`/api/channels/${threadId}/messages`)).status)
      .toBe(404);
    expect((await http(t).get(`/api/threads/${threadId}/messages`)).status)
      .toBe(200);
  });

  it('writes user_id into conversation_users when creating a DM under agent_home (v25 PR-A blocker fix)', async () => {
    // Regression for PR-A blocker #2: agent_home POST /channels used
    // to only conversations.addAgent(dm, owner) without writing
    // conversation_users for the human creator. After v25 permission
    // tightening, that left the user unable to GET /messages on the
    // DM they just created.
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    const agentBody = await (
      await http(t).post('/api/agents', { name: 'creator', runtime: 'claude' })
    ).json() as any;
    const home = (await (
      await http(t).get('/api/workspaces')
    ).json() as any).workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === agentBody.agent.id,
    );
    expect(home).toBeDefined();

    // Create a secondary DM under the agent_home as the principal user.
    const created = await http(t).post(`/api/workspaces/${home.id}/channels`, {
      title: 'Mentions',
      member_agent_ids: [],
    });
    expect(created.status).toBe(201);
    const dm = (await created.json() as any).channel;

    // The creator (default 'local') must be a conversation_users
    // member of the new DM, otherwise GET /messages would 403.
    const dmMembers = t.ctx.db
      .prepare<[string], { user_id: string }>(
        `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
      )
      .all(dm.id)
      .map(r => r.user_id);
    expect(dmMembers).toEqual(['local']);

    // And the route they own must be readable.
    const messagesResp = await http(t).get(`/api/channels/${dm.id}/messages`);
    expect(messagesResp.status).toBe(200);
  });
});
