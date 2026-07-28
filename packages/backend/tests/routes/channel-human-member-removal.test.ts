import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  conversationSideScope,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * `DELETE /api/conversations/:id/members/users/:userId` (#task:1688) — remove
 * ANOTHER human from a channel, the third-party counterpart of self-leave, plus
 * the viewer-scoped `member_removability` carrier that lets a surface hide the
 * action instead of disabling it.
 *
 * The gate is two independent factors — roster AUTHORITY (workspace `admin`) ∧
 * the TARGET being an eligible exit — so every case below pins ONE factor at a
 * time. All roles are real `workspace_users` rows: `seedAllFixtureMemberships:
 * false` because the permissive fixture triggers would seed the viewer as
 * `owner` and quietly satisfy the authority factor everywhere.
 *
 * Two refusal codes of the shared exit predicate are STRUCTURALLY unreachable
 * through this route today, and that is asserted rather than assumed:
 *   - `channel_owner` — reaching it needs a target holding `owner` while the
 *     caller is not outranked, i.e. caller === owner === target, which the
 *     self_target case takes first (`workspace_users` has exactly one owner).
 *     Pinned by 'refuses an admin removing the workspace owner'.
 *   - `last_human_member` — the caller needs conversation membership to pass the
 *     floor, so caller + target are two distinct humans and the target is never
 *     the last one. Pinned by 'refuses a workspace admin who is not a member of
 *     the channel'.
 * Both stay mapped: they are the SAME predicate self-leave uses (one exit rule,
 * no second copy), and each becomes reachable the moment its invariant changes
 * (co-owners; admins gaining non-member visibility of a channel).
 */

const OWNER = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') };
const ADMIN = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('alice') };
const OUTSIDER = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('other') };
// The default identity of `http(t)` with no headers is `local` — a plain
// workspace member throughout this file.
const MEMBER_ID = 'local';

type Scenario = {
  workspaceId: string;
  channelId: string;
};

async function json(res: Response): Promise<any> {
  return await res.json() as any;
}

/**
 * A workspace owned by `teammate` with `alice` promoted to `admin`, `local` and
 * `bob` as plain members, plus one channel containing every one of them.
 * `visibility` is passed through so the private-channel cases can reuse this.
 */
async function seedScenario(
  t: TestApp,
  visibility: 'private' | 'public',
): Promise<Scenario> {
  const workspaceId = (await json(
    await http(t).post('/api/workspaces', { name: 'roster', member_agent_ids: [] }, { headers: OWNER }),
  )).workspace.id as string;

  for (const userId of ['alice', MEMBER_ID, 'bob']) {
    expect(
      (await http(t).post(
        apiPaths.workspaceMembers(workspaceId),
        { kind: 'human', user_id: userId },
        { headers: OWNER },
      )).status,
    ).toBe(201);
  }
  expect(
    (await http(t).patch(
      apiPaths.workspaceHumanMemberRole(workspaceId, 'alice'),
      { role: 'admin' },
      { headers: OWNER },
    )).status,
  ).toBe(200);

  const channelId = (await json(
    await http(t).post(
      apiPaths.workspaceChannels(workspaceId),
      {
        title: 'roster-room',
        member_agent_ids: [],
        member_user_ids: ['alice', MEMBER_ID, 'bob'],
        visibility,
      },
      { headers: OWNER },
    ),
  )).channel.id as string;

  return { workspaceId, channelId };
}

async function humanMemberIds(t: TestApp, channelId: string, headers?: Record<string, string>): Promise<string[]> {
  const body = await json(
    await http(t).get(apiPaths.conversationMembers(channelId), headers ? { headers } : undefined),
  );
  return body.members.filter((m: any) => m.kind === 'human').map((m: any) => m.user_id);
}

function removePath(channelId: string, userId: string): string {
  return apiPaths.conversationHumanMember(channelId, userId);
}

describe('channel human-member removal (#task:1688)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lets a workspace admin remove another human, writing the audit message and roster events', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, channelId } = await seedScenario(t, 'public');
    const events: Array<{ kind: string; payload: any }> = [];
    const offStream = t.ctx.events.subscribe(channelId, e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );
    const offSide = t.ctx.events.subscribeScope(conversationSideScope(channelId), e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );

    const res = await http(t).del(removePath(channelId, 'bob'), { headers: ADMIN });
    offStream();
    offSide();
    expect(res.status).toBe(200);
    // The write envelope is the plain roster — no viewer-scoped carrier.
    const body = await json(res);
    expect(body.member_removability).toBeUndefined();
    expect(body.members.filter((m: any) => m.kind === 'human').map((m: any) => m.user_id))
      .not.toContain('bob');
    expect(await humanMemberIds(t, channelId, ADMIN)).toEqual(
      expect.arrayContaining(['alice', MEMBER_ID]),
    );
    expect(await humanMemberIds(t, channelId, ADMIN)).not.toContain('bob');

    // Someone ELSE ended this membership, so unlike self-leave it is announced.
    const messages = new MessageRepo(t.ctx.db).listForConversation(channelId, 50);
    const removed = messages.filter(
      m => (m.metadata as any)?.subtype === 'conversation_member_removed',
    );
    expect(removed).toHaveLength(1);
    expect(removed[0]!.content).toContain('@bob');
    expect(removed[0]!.metadata as any).toMatchObject({
      member_kind: 'human',
      member_id: 'bob',
      actor_kind: 'user',
      actor_id: 'alice',
    });

    expect(events.map(e => e.kind)).toEqual(['message', 'conversation_members_changed']);

    // The workspace roster is untouched — only the conversation edge went.
    const wsMembers = await json(
      await http(t).get(apiPaths.workspaceMembers(workspaceId), { headers: ADMIN }),
    );
    expect(wsMembers.human_members.map((m: any) => m.user_id)).toContain('bob');
  });

  it('refuses a plain workspace member removing someone else', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { channelId } = await seedScenario(t, 'public');

    const res = await http(t).del(removePath(channelId, 'bob'));
    expect(res.status).toBe(403);
    expect(await humanMemberIds(t, channelId)).toContain('bob');
  });

  it('refuses removing YOURSELF (leave is that verb), even for an admin', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { channelId } = await seedScenario(t, 'public');

    const adminSelf = await http(t).del(removePath(channelId, 'alice'), { headers: ADMIN });
    expect(adminSelf.status).toBe(422);
    expect((await json(adminSelf)).code).toBe('self_target');

    // A plain member asking about their own row gets the same accurate answer,
    // not a misleading "you lack admin".
    const memberSelf = await http(t).del(removePath(channelId, MEMBER_ID));
    expect(memberSelf.status).toBe(422);
    expect((await json(memberSelf)).code).toBe('self_target');
    expect(await humanMemberIds(t, channelId)).toEqual(
      expect.arrayContaining(['alice', MEMBER_ID, 'bob']),
    );
  });

  it('refuses an admin removing the workspace owner (governance is not transitive upward)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { channelId } = await seedScenario(t, 'public');

    const res = await http(t).del(removePath(channelId, 'teammate'), { headers: ADMIN });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('target_outranks_actor');
    expect(await humanMemberIds(t, channelId, ADMIN)).toContain('teammate');
  });

  it('refuses a workspace admin who is not a member of the channel (floor is membership, and it leaks nothing)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, channelId } = await seedScenario(t, 'private');
    // `carol` is a workspace ADMIN but not in the channel.
    expect(
      (await http(t).post(
        apiPaths.workspaceMembers(workspaceId),
        { kind: 'human', user_id: 'carol' },
        { headers: OWNER },
      )).status,
    ).toBe(201);
    expect(
      (await http(t).patch(
        apiPaths.workspaceHumanMemberRole(workspaceId, 'carol'),
        { role: 'admin' },
        { headers: OWNER },
      )).status,
    ).toBe(200);
    const carol = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('carol') };

    // Existing target and a nonexistent one are indistinguishable: no id
    // enumeration through the removal route.
    const real = await http(t).del(removePath(channelId, 'bob'), { headers: carol });
    const fake = await http(t).del(removePath(channelId, 'no-such-user'), { headers: carol });
    expect(real.status).toBe(403);
    expect(fake.status).toBe(403);
    expect(await json(real)).toEqual(await json(fake));

    // A workspace outsider is refused the same way.
    expect((await http(t).del(removePath(channelId, 'bob'), { headers: OUTSIDER })).status).toBe(403);
    expect(await humanMemberIds(t, channelId, ADMIN)).toContain('bob');
  });

  it('answers nothing about a conversation the caller cannot see — shape, closed state and all (#task:1688 review)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, channelId } = await seedScenario(t, 'private');
    // `carol` is the STRONGEST outsider: a workspace admin, so only the
    // conversation-membership floor stands between her and these ids.
    expect(
      (await http(t).post(
        apiPaths.workspaceMembers(workspaceId),
        { kind: 'human', user_id: 'carol' },
        { headers: OWNER },
      )).status,
    ).toBe(201);
    expect(
      (await http(t).patch(
        apiPaths.workspaceHumanMemberRole(workspaceId, 'carol'),
        { role: 'admin' },
        { headers: OWNER },
      )).status,
    ).toBe(200);
    const carol = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('carol') };

    // A second channel she is not in, then closed: `closed_at` is as private as
    // the roster rows, so it must not surface above the floor.
    const closedId = (await json(
      await http(t).post(
        apiPaths.workspaceChannels(workspaceId),
        { title: 'closed-room', member_agent_ids: [], member_user_ids: ['bob'], visibility: 'private' },
        { headers: OWNER },
      ),
    )).channel.id as string;
    expect(new ConversationRepo(t.ctx.db).close(closedId, 'done')?.closed_at).toBeTruthy();

    // A DM between `teammate` and their own agent — a different conversation
    // KIND, which must not be observable either.
    const dmId = (await json(
      await http(t).post('/api/agents', { name: 'owner-dm-agent', runtime: 'claude' }, { headers: OWNER }),
    )).dm_channel_id as string;

    const app = t;
    const responses = await Promise.all(
      [channelId, closedId, dmId, 'no-such-conversation'].map(id =>
        http(app).del(removePath(id, 'bob'), { headers: carol }),
      ),
    );
    const [invisible, closed, dm, missing] = responses;
    // Invisible channel / closed channel / DM are ONE bucket: same status, same
    // body. Before this order was fixed they were 403 / 409 / 422 — a free
    // classifier for any id in the workspace.
    expect([invisible!.status, closed!.status, dm!.status]).toEqual([403, 403, 403]);
    const bodies = await Promise.all([invisible!, closed!, dm!].map(json));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    // A nonexistent id keeps the pre-existing route convention (404 from the
    // conversation lookup) — unchanged by this gate, and it is the one answer
    // that reveals nothing beyond "not a conversation you can act on".
    expect(missing!.status).toBe(404);

    // Nothing moved anywhere.
    expect(await humanMemberIds(t, channelId, ADMIN)).toContain('bob');
    expect(new ConversationRepo(t.ctx.db).getUser(closedId, 'bob')).not.toBeNull();
  });

  it('is an idempotent no-op for a target with no membership row', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, channelId } = await seedScenario(t, 'public');
    expect(
      (await http(t).post(
        apiPaths.workspaceMembers(workspaceId),
        { kind: 'human', user_id: 'carol' },
        { headers: OWNER },
      )).status,
    ).toBe(201);

    const before = new MessageRepo(t.ctx.db).listForConversation(channelId, 50).length;
    const events: string[] = [];
    const off = t.ctx.events.subscribeScope(conversationSideScope(channelId), e =>
      events.push(e.kind),
    );
    // `carol` is a workspace member but not a channel member; `someone` has no
    // workspace row at all. Both are already in the requested post-state.
    const nonChannelMember = await http(t).del(removePath(channelId, 'carol'), { headers: ADMIN });
    const nonWorkspaceMember = await http(t).del(removePath(channelId, 'someone'), { headers: ADMIN });
    off();

    expect(nonChannelMember.status).toBe(200);
    expect(nonWorkspaceMember.status).toBe(200);
    expect(events).toEqual([]);
    expect(new MessageRepo(t.ctx.db).listForConversation(channelId, 50).length).toBe(before);
  });

  it('refuses on an archived channel (v1 freezes it; restore first)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { channelId } = await seedScenario(t, 'public');
    expect(
      (await http(t).patch(apiPaths.channelArchive(channelId), { archived: true }, { headers: OWNER }))
        .status,
    ).toBe(200);

    const res = await http(t).del(removePath(channelId, 'bob'), { headers: ADMIN });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('channel_archived');
    expect(await humanMemberIds(t, channelId, ADMIN)).toContain('bob');
  });

  it('computes member_removability per ROW, not from one admin flag', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, channelId } = await seedScenario(t, 'public');

    // An agent created by `local` (the plain member) and placed in the channel:
    // its creator may retract it with no governance role at all.
    const agentId = (await json(
      await http(t).post('/api/agents', { name: 'roster-agent', runtime: 'claude' }),
    )).agent.id as string;
    expect(
      (await http(t).post(apiPaths.workspaceMembers(workspaceId), { agent_id: agentId })).status,
    ).toBe(201);
    expect(
      (await http(t).post(apiPaths.conversationMembers(channelId), { kind: 'agent', agent_id: agentId }))
        .status,
    ).toBe(200);

    const asAdmin = await json(
      await http(t).get(apiPaths.conversationMembers(channelId), { headers: ADMIN }),
    );
    const removable = (body: any) =>
      new Map<string, boolean>(
        body.member_removability.map((r: any) => [`${r.kind}:${r.id}`, r.can_remove]),
      );
    // One entry per member, addressable by (kind, id) — never by index.
    expect(asAdmin.member_removability).toHaveLength(asAdmin.members.length);
    const adminView = removable(asAdmin);
    expect(adminView.get(`human:${MEMBER_ID}`)).toBe(true);
    expect(adminView.get('human:bob')).toBe(true);
    expect(adminView.get('human:alice')).toBe(false); // self → Leave, not remove
    expect(adminView.get('human:teammate')).toBe(false); // outranks the admin
    expect(adminView.get(`agent:${agentId}`)).toBe(true); // admin governs the roster

    const asMember = removable(await json(await http(t).get(apiPaths.conversationMembers(channelId))));
    expect(asMember.get('human:bob')).toBe(false);
    expect(asMember.get('human:teammate')).toBe(false);
    expect(asMember.get(`human:${MEMBER_ID}`)).toBe(false);
    // …but the agent they created is theirs to retract: a single "am I an admin"
    // boolean would be wrong here in the other direction.
    expect(asMember.get(`agent:${agentId}`)).toBe(true);

    // The carrier is advisory and matches the write: every `false` human row the
    // admin sees is actually refused, every `true` one actually succeeds.
    expect((await http(t).del(removePath(channelId, 'teammate'), { headers: ADMIN })).status).toBe(403);
    expect((await http(t).del(removePath(channelId, 'alice'), { headers: ADMIN })).status).toBe(422);
    expect((await http(t).del(removePath(channelId, 'bob'), { headers: ADMIN })).status).toBe(200);
  });

  it('reports every human row unremovable once the channel is archived (carrier tracks the same guards)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { channelId } = await seedScenario(t, 'public');
    expect(
      (await http(t).patch(apiPaths.channelArchive(channelId), { archived: true }, { headers: OWNER }))
        .status,
    ).toBe(200);

    const body = await json(
      await http(t).get(apiPaths.conversationMembers(channelId), { headers: ADMIN }),
    );
    for (const row of body.member_removability) {
      if (row.kind === 'human') expect(row.can_remove).toBe(false);
    }
  });

  it('refuses on a non-channel conversation (dm_channel)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const created = await json(
      await http(t).post('/api/agents', { name: 'dm-owner-agent', runtime: 'claude' }),
    );
    const dmChannelId = created.dm_channel_id as string;

    const res = await http(t).del(removePath(dmChannelId, 'bob'));
    expect(res.status).toBe(422);
    expect((await json(res)).code).toBe('conversation_member_remove_unsupported');
  });
});
