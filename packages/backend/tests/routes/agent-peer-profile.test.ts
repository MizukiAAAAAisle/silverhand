import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';

/**
 * Agent PEER profile read (#task:1823) — `GET .../peer-profile?handle=…`,
 * behind `silverhand profile get --handle <name>`.
 *
 * What these tests lock:
 *  - the read is a SEPARATE axis from the self routes: it takes a handle and
 *    never widens what the token-pinned self URL can do (no peer write exists);
 *  - visibility is workspace CO-MEMBERSHIP, gated by `read_messages`;
 *  - every miss — unknown handle, a human's handle, an agent in a workspace the
 *    caller does not share — is the SAME 404, so the route cannot be used to
 *    probe who exists (anti-enumeration, §AP).
 *
 * Permission-boundary tests, so the fixture's permissive auto-membership
 * triggers are OFF: with them on, "not co-members" would not be reproducible.
 */

function build(): TestApp {
  return buildTestApp({ seedAllFixtureMemberships: false });
}

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id as string;
}

async function makeWorkspace(
  t: TestApp,
  name: string,
  agentIds: string[],
): Promise<{ workspaceId: string; channelId: string }> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: agentIds })
  ).json()) as any;
  return {
    workspaceId: created.workspace.id as string,
    channelId: created.onboarding_channel_id as string,
  };
}

function peerProfile(
  t: TestApp,
  channelId: string,
  agentId: string,
  handle: string,
  workspaceId?: string,
): Promise<Response> {
  const query = new URLSearchParams({ handle });
  if (workspaceId !== undefined) query.set('workspace_id', workspaceId);
  return http(t).get(
    `/internal/conversations/${channelId}/agents/${agentId}/peer-profile?${query.toString()}`,
  );
}

async function setDescription(
  t: TestApp,
  channelId: string,
  agentId: string,
  description: string,
): Promise<void> {
  const form = new FormData();
  form.set('description', description);
  const res = await t.app.fetch(
    new Request(
      `http://localhost/internal/conversations/${channelId}/agents/${agentId}/profile`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${issueTestConversationRuntimeToken(t, channelId, agentId)}`,
        },
        body: form,
      },
    ),
  );
  expect(res.status).toBe(200);
}

describe('agent peer profile read (internal route)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns a co-workspace peer profile in the same shape as the self read', async () => {
    t = build();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const team = await makeWorkspace(t, 'team', [alice, bob]);
    await setDescription(t, team.channelId, bob, 'owns the renderer');

    const res = await peerProfile(t, team.channelId, alice, 'bob');
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as any;
    expect(profile).toEqual({
      id: bob,
      name: 'bob',
      display_name: expect.any(String),
      description: 'owns the renderer',
      avatar_url: null,
    });
  });

  it('accepts a pasted mention (leading @) as the same handle', async () => {
    t = build();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const team = await makeWorkspace(t, 'team', [alice, bob]);

    const res = await peerProfile(t, team.channelId, alice, '@bob');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).profile.id).toBe(bob);
  });

  it('answers an identical 404 for an unknown handle, a human handle, and a non-co-workspace agent', async () => {
    t = build();
    const alice = await makeAgent(t, 'alice');
    const outsider = await makeAgent(t, 'outsider');
    const team = await makeWorkspace(t, 'team', [alice]);
    await makeWorkspace(t, 'other', [outsider]);
    // The fixture's viewer human — a real row in the SAME globally-unique
    // handle namespace (`users.name` ⊕ `agents.name`).
    const humanHandle = (
      t.ctx.db
        .prepare(`SELECT name FROM users WHERE id = ?`)
        .get(t.viewerUserId) as { name: string }
    ).name;
    expect(typeof humanHandle).toBe('string');

    const responses = await Promise.all([
      peerProfile(t, team.channelId, alice, 'nobody-here'),
      peerProfile(t, team.channelId, alice, humanHandle),
      peerProfile(t, team.channelId, alice, 'outsider'),
    ]);
    const bodies: unknown[] = [];
    for (const res of responses) {
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    }
    // Indistinguishable: same status AND same body for all three misses.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    // Sanity: `outsider` really does exist and really does have a profile —
    // the 404 above is a visibility answer, not a missing row.
    expect(outsider).toBeTruthy();
  });

  it('requires read_messages in the workspace the lookup resolves to', async () => {
    t = build();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const team = await makeWorkspace(t, 'team', [alice, bob]);

    new AgentCapabilityRepo(t.ctx.db).replaceSet(team.workspaceId, alice, []);
    const denied = await peerProfile(t, team.channelId, alice, 'bob');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'read_messages',
    });

    // Positive control: the same call succeeds once the bucket is back.
    new AgentCapabilityRepo(t.ctx.db).replaceSet(team.workspaceId, alice, [
      'read_messages',
    ]);
    expect((await peerProfile(t, team.channelId, alice, 'bob')).status).toBe(200);
  });

  it('scopes the lookup to workspace_id, and only within the caller\'s own horizon', async () => {
    t = build();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const outsider = await makeAgent(t, 'outsider');
    const home = await makeWorkspace(t, 'home', [alice]);
    const shared = await makeWorkspace(t, 'shared', [alice, bob]);
    const foreign = await makeWorkspace(t, 'foreign', [outsider]);

    // bob is invisible from `home` (no co-membership there) …
    expect((await peerProfile(t, home.channelId, alice, 'bob')).status).toBe(404);
    // … and visible when the caller names the workspace they DO share.
    const scoped = await peerProfile(t, home.channelId, alice, 'bob', shared.workspaceId);
    expect(scoped.status).toBe(200);
    expect(((await scoped.json()) as any).profile.id).toBe(bob);

    // A workspace outside the caller's horizon is refused before any target
    // resolution — the caller learns nothing about who is in it.
    const off = await peerProfile(
      t,
      home.channelId,
      alice,
      'outsider',
      foreign.workspaceId,
    );
    expect(off.status).toBe(403);
  });

  it('rejects a missing handle with a validation error, not a lookup', async () => {
    t = build();
    const alice = await makeAgent(t, 'alice');
    const team = await makeWorkspace(t, 'team', [alice]);
    const res = await http(t).get(
      `/internal/conversations/${team.channelId}/agents/${alice}/peer-profile`,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a token bound to a different agent (the caller is never caller-chosen)', async () => {
    t = build();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const team = await makeWorkspace(t, 'team', [alice, bob]);
    const res = await t!.app.fetch(
      new Request(
        `http://localhost/internal/conversations/${team.channelId}/agents/${alice}/peer-profile?handle=bob`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${issueTestConversationRuntimeToken(t!, team.channelId, bob)}`,
          },
        },
      ),
    );
    expect(res.status).toBe(401);
  });
});
