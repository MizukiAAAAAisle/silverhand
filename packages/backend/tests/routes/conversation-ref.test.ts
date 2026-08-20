import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
  type DirectPairListResponse,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { insertAgentScopedAgent } from '../utils/agent-scope.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { canReadConversation } from '../../src/permissions.js';

async function makeAgent(t: TestApp, name: string): Promise<{
  agentId: string;
  dmChannelId: string;
  agentHomeWorkspaceId: string;
}> {
  const created = await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json() as any;
  const workspaces = await (await http(t).get('/api/workspaces')).json() as any;
  const home = workspaces.workspaces.find(
    (w: any) =>
      w.owner_agent_id === created.agent.id,
  );
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    agentId: created.agent.id,
    dmChannelId: created.dm_channel_id,
    agentHomeWorkspaceId: home.id,
  };
}

async function createRegularWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; onboardingChannelId: string }> {
  const created = await (
    await http(t).post('/api/workspaces', {
      name,
      member_agent_ids: memberAgentIds,
    })
  ).json() as any;
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
  visibility?: 'public' | 'private',
): Promise<string> {
  const created = await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
      ...(visibility ? { visibility } : {}),
    })
  ).json() as any;
  return created.channel.id;
}

function refPath(id: string): string {
  return `/api/conversations/${id}/ref`;
}

describe('GET /api/conversations/:id/ref', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns a regular channel ref with workspace metadata', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'planning', [
      alice.agentId,
    ]);

    const res = await http(t).get(refPath(channelId));
    expect(res.status).toBe(200);
    const { ref } = await res.json() as any;
    expect(ref).toMatchObject({
      id: channelId,
      placement_kind: 'workspace',
      roster_policy: 'open',
      title: 'planning',
      workspace_id: reg.workspaceId,
      closed_at: null,
      archived_at: null,
    });
  });

  it("projects an agent's fixed-roster ref with the workspace COORDINATE and no container word", async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');

    const res = await http(t).get(refPath(alice.dmChannelId));
    expect(res.status).toBe(200);
    const { ref } = await res.json() as any;
    expect(ref).toMatchObject({
      id: alice.dmChannelId,
      placement_kind: 'workspace',
      roster_policy: 'fixed',
      workspace_id: alice.agentHomeWorkspaceId,
    });
    // This cell used to assert the hard contract "external callers never see a
    // PHYSICAL kind" by pinning the published word `agent_space`. #task:2075's
    // stop-publish step made the stronger statement true: no container word at
    // all rides this ref, so the physical word cannot leak through a broken
    // projection because there is no projection. An agent home is the right
    // fixture for that claim — it is the container that had the special branch.
    // This reads the PARSED HTTP BODY, so an absent key is a fact about the
    // wire rather than an artifact of a zod object stripping it.
    expect(Object.keys(ref)).not.toContain('workspace_kind');
  });

  it('returns 404 for a missing conversation id', async () => {
    t = buildTestApp();
    const res = await http(t).get(refPath('nonexistent-id'));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toContain('not found');
  });

  it('exposes refs across workspaces (no per-workspace narrowing)', async () => {
    // The ref endpoint is not narrowed to the currently-open
    // workspace. A user can resolve any conversation they are a member
    // of, even if the main pane is on a different workspace.
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const wsA = await createRegularWorkspace(t, 'ws-a', [alice.agentId]);
    const wsB = await createRegularWorkspace(t, 'ws-b', [alice.agentId]);
    const channelInB = await createChannel(t, wsB.workspaceId, 'b-channel', [
      alice.agentId,
    ]);

    // Sanity: this is a real cross-workspace lookup.
    expect(wsA.workspaceId).not.toBe(wsB.workspaceId);

    const res = await http(t).get(refPath(channelInB));
    expect(res.status).toBe(200);
    const { ref } = await res.json() as any;
    expect(ref.workspace_id).toBe(wsB.workspaceId);
  });

  it('rejects a workspace member who is not a member of a PRIVATE conversation', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-secret-ref', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'private', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`)
      .run(channelId);

    const res = await http(t).get(refPath(channelId));
    expect(res.status).toBe(403);
  });

  it('rejects unauthorized callers with 401 (token guard upstream)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    // Use the raw app with no Bearer header to exercise the public
    // bearer middleware. This is the same shape as a UI session that
    // failed to attach a token; we just verify the route doesn't leak
    // ref data without an auth header.
    const res = await t.app.fetch(
      new Request(`http://localhost${refPath(alice.dmChannelId)}`, {
        method: 'GET',
      }),
    );
    expect(res.status).toBe(401);
  });
});

// Route-wiring falsifiers for the ref gate. `/ref` serves the `#conv:<id>`
// chip and the `?side` pane, so it flipped from strict `canViewConversation`
// to the PUBLIC-aware `canReadConversation` used by channel detail + message
// history — a ref must not be narrower than the read it introduces. These pin
// the exact widening boundary; both falsifiers were run:
//   - reverting the gate to `canViewConversation` reddens EXACTLY the
//     active-public non-member case (1 red / 10 green);
//   - over-widening it to `canViewWorkspace`-only reddens the private,
//     archived-public and dm_channel cases (3 red / 8 green). The
//     non-workspace case survives both, since either gate rejects it.
describe('GET /api/conversations/:id/ref — public-aware read gate boundary', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  // `teammate`: a workspace member who is deliberately NOT a conversation
  // member, so a 200 proves the PUBLIC branch rather than plain membership.
  function asTeammate(app: TestApp) {
    return http(app, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    });
  }

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

  async function setupPublic(): Promise<{
    workspaceId: string;
    publicId: string;
  }> {
    const alice = await makeAgent(t!, 'alice');
    const reg = await createRegularWorkspace(t!, 'eng-ref', [alice.agentId]);
    const publicId = await createChannel(
      t!,
      reg.workspaceId,
      'public-room',
      [],
      'public',
    );
    pinNonChannelMember(t!, publicId, reg.workspaceId, 'teammate');
    return { workspaceId: reg.workspaceId, publicId };
  }

  it('resolves an ACTIVE PUBLIC channel for a workspace member who is not a channel member', async () => {
    t = buildTestApp();
    const { workspaceId, publicId } = await setupPublic();

    const res = await asTeammate(t).get(refPath(publicId));
    expect(res.status).toBe(200);
    const { ref } = await res.json() as any;
    // Identity + routing only — the widened surface carries no messages,
    // no unread state, no roster.
    expect(ref).toMatchObject({
      id: publicId,
      placement_kind: 'workspace',
      roster_policy: 'open',
      title: 'public-room',
      workspace_id: workspaceId,
      archived_at: null,
    });
  });

  it('still rejects an ARCHIVED public channel for a non-member (archive drops the public surface)', async () => {
    t = buildTestApp();
    const { publicId } = await setupPublic();
    expect(
      (await http(t).patch(`/api/channels/${publicId}/archive`, { archived: true }))
        .status,
    ).toBe(200);

    expect((await asTeammate(t).get(refPath(publicId))).status).toBe(403);
  });

  it('keeps an ARCHIVED channel resolvable for its MEMBERS (archive is not delete)', async () => {
    t = buildTestApp();
    const { publicId } = await setupPublic();
    expect(
      (await http(t).patch(`/api/channels/${publicId}/archive`, { archived: true }))
        .status,
    ).toBe(200);

    // `local` created the channel, so it is still a conversation member.
    const res = await http(t).get(refPath(publicId));
    expect(res.status).toBe(200);
    const { ref } = await res.json() as any;
    expect(ref.archived_at).not.toBeNull();
  });

  it('rejects a NON-workspace user even on an active PUBLIC channel', async () => {
    t = buildTestApp();
    const { workspaceId, publicId } = await setupPublic();
    // The public branch requires canViewWorkspace: strip `other` from the
    // workspace entirely, so this is the cross-workspace boundary.
    t.ctx.db
      .prepare('DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .run(workspaceId, 'other');
    expect(
      t.ctx.db
        .prepare('SELECT 1 AS hit FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
        .get(workspaceId, 'other'),
    ).toBeUndefined();

    const stranger = http(t, {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('other'),
    });
    expect((await stranger.get(refPath(publicId))).status).toBe(403);
  });

  it("rejects a non-participant on a dm_channel (no public branch for 'dm_channel')", async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');

    // Legacy fixtures seed every fixture user into the agent_home workspace
    // AND its dm_channel, so strip `teammate` from the conversation while
    // KEEPING the workspace row: this is precisely "a workspace member who is
    // not a participant". The 403 is owed jointly to the public branch's
    // open-roster and `visibility === 'public'` legs — a fixed-roster row
    // is structurally excluded from both.
    pinNonChannelMember(t, alice.dmChannelId, alice.agentHomeWorkspaceId, 'teammate');

    // The participant (`local`, the DM's human side) still resolves it.
    expect((await http(t).get(refPath(alice.dmChannelId))).status).toBe(200);
    expect((await asTeammate(t).get(refPath(alice.dmChannelId))).status).toBe(403);
  });
});

// The WORKSPACE-ARM NARROWING (#task:2038, ruling A). `ConversationRef` names a
// workspace in its contract, so a workspace-less placement is unnameable on this
// face — and since #task:2035 that is a LIVE branch rather than an unreachable
// defence: a human endpoint of their own `direct_pair` genuinely reads the
// conversation and still gets 404 here. Before this block the branch had zero
// coverage, which is exactly how its justification ("a user can never read a
// workspace-less placement") went stale without anything failing.
//
// The 404 is only ACCEPTABLE because the identity is available elsewhere in full,
// so the test asserts the substitute in the same breath: the pair appears on
// `GET /api/direct-pairs`, whose complete-set contract is pinned by
// `direct-pairs.test.ts`.
describe('GET /api/conversations/:id/ref — workspace-arm narrowing', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('404s a direct_pair the viewer can READ (contract-face narrowing, not an ACL answer)', async () => {
    t = buildTestApp();
    const parent = await makeAgent(t, 'parent');
    const confidant = insertAgentScopedAgent(t, parent.agentId, 'confidant');
    const pairId = new ConversationRepo(t.ctx.db).getOrCreateDirectPair(
      { kind: 'agent', id: confidant },
      { kind: 'human', id: t.viewerUserId },
      1_000,
    ).conversation.id;

    // 1. The ACL admits the viewer — the placement authority's human-endpoint arm.
    expect(
      canReadConversation(
        t.ctx,
        { kind: 'user', userId: t.viewerUserId },
        pairId,
      ),
    ).toBe(true);
    // 2. Not a theoretical `true`: the SAME gate serves message history, and that
    //    face answers 200 for this exact conversation.
    expect(
      (await http(t).get(apiPaths.channelMessages(pairId))).status,
    ).toBe(200);
    // 3. The ref face nonetheless 404s. If someone "fixes" this by making
    //    `ConversationRef.workspace_id` nullable, this assertion is the one that
    //    has to be deleted deliberately — the pseudo-coordinate cannot come back
    //    by accident.
    expect((await http(t).get(refPath(pairId))).status).toBe(404);

    // 4. And the identity the chip/pane needs is on the private line's own face.
    const list = await http(t).get(apiPaths.directPairs);
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as DirectPairListResponse).direct_pairs.map(
        p => p.conversation_id,
      ),
    ).toContain(pairId);
  });
});
