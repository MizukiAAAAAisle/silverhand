import { afterEach, describe, expect, it } from 'vitest';
import { internalPaths } from '@silverhand/shared';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';

/**
 * P3 (#task:969) auth-boundary proof for the membership Hono sub-app mount.
 *
 * Membership routes moved from in-place `register*Routes(app, deps)` (middleware
 * inheritance true by construction) to `app.route('/', create*App(deps))`
 * sub-apps. The one real risk of that change is that the parent app's auth /
 * principal middleware stop wrapping the mounted routes. These tests are the
 * falsifiers from the P3 spec §3.3 — they assert auth rejection/acceptance on
 * the MOUNTED routes themselves (via buildTestApp, which mounts both factories):
 *
 *   1. parent api bearer middleware still wraps the mounted public GET
 *      (invalid bearer rejected; valid accepted);
 *   2. parent internal param-scoped agent-token auth still wraps the mounted
 *      internal add (garbage token → 401);
 *   3. a *foreign* but otherwise-valid agent token is rejected — proving the
 *      param-scoped middleware reads the path's :cid/:aid ACROSS the mount;
 *   4. a positive internal add succeeds and lands in the RIGHT conversation —
 *      proving `getAgentPrincipal`'s :cid/:aid survive the mount;
 *   5. the injected capability guard still denies through the mount.
 *
 * If the mount broke inheritance, 1-3/5 would pass through unchecked and 4 would
 * target the wrong conversation.
 */

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id;
}

async function createWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; onboardingChannelId: string }> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: created.workspace.id,
    onboardingChannelId: created.onboarding_channel_id,
  };
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = (await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json()) as any;
  return created.channel.id;
}

describe('P3 membership sub-app mount — auth-boundary inheritance', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('parent api bearer middleware wraps the mounted public GET (invalid rejected, valid ok)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createWorkspace(t, 'mount-public-bearer', [alice]);

    // Invalid bearer → rejected by the parent api bearer middleware. The
    // explicit header is preserved (not auto-translated), so this exercises
    // the real rejection path on the MOUNTED route.
    const denied = await http(t).get(`/api/workspaces/${reg.workspaceId}/members`, {
      headers: { Authorization: 'Bearer not-a-real-session-token' },
    });
    expect(denied.status).toBe(401);

    // Default (valid session) bearer → 200 through the same mounted route.
    const ok = await http(t).get(`/api/workspaces/${reg.workspaceId}/members`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(Array.isArray(body.members)).toBe(true);
  });

  it('parent internal param-scoped auth wraps the mounted internal add (garbage token → 401)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createWorkspace(t, 'mount-internal-garbage', [alice, bob]);
    const channelId = await createChannel(t, reg.workspaceId, 'room', [alice]);

    const res = await http(t).post(
      internalPaths.agentAddConversationMember(channelId, alice),
      { handle: '@bob' },
      { headers: { Authorization: 'Bearer garbage-not-an-agent-token' } },
    );
    expect(res.status).toBe(401);
  });

  it('rejects a FOREIGN valid agent token — proves :cid/:aid read across the mount', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createWorkspace(t, 'mount-foreign-token', [alice, bob]);
    const channelA = await createChannel(t, reg.workspaceId, 'room-a', [alice]);
    const channelB = await createChannel(t, reg.workspaceId, 'room-b', [alice]);

    // A token validly issued for (channelB, alice) must NOT authorize a request
    // to (channelA, alice): the param-scoped middleware verifies the token
    // against the path's :cid/:aid, which only works if those params resolve
    // through the mount.
    const foreignToken = issueTestConversationRuntimeToken(t, channelB, alice);
    const res = await http(t).post(
      internalPaths.agentAddConversationMember(channelA, alice),
      { handle: '@bob' },
      { headers: { Authorization: `Bearer ${foreignToken}` } },
    );
    expect(res.status).toBe(401);
  });

  it('positive internal add lands in the RIGHT conversation (getAgentPrincipal :cid/:aid intact)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createWorkspace(t, 'mount-positive-add', [alice, bob]);
    const channelId = await createChannel(t, reg.workspaceId, 'room', [alice]);

    // Default helper translates the public bearer to a valid (channelId, alice)
    // token. Success + bob present proves the principal's conversationId resolved
    // to channelId across the mount.
    const res = await http(t).post(
      internalPaths.agentAddConversationMember(channelId, alice),
      { handle: '@bob' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(
      body.members.filter((m: any) => m.kind === 'agent').map((m: any) => m.agent_id),
    ).toEqual(expect.arrayContaining([alice, bob]));
  });

  it('injected capability guard still denies through the mount', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createWorkspace(t, 'mount-cap-denied', [alice, bob]);
    const channelId = await createChannel(t, reg.workspaceId, 'room', [alice]);

    new AgentCapabilityRepo(t.ctx.db).replaceSet(reg.workspaceId, alice, ['read_messages']);
    const res = await http(t).post(
      internalPaths.agentAddConversationMember(channelId, alice),
      { handle: '@bob' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'manage_conversation_members',
    });
  });
});
