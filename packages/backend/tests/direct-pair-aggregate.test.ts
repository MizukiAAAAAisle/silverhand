/**
 * #task:2020 (P3) — the DirectPair AGGREGATE: its only constructor, its
 * participant authority, and the member state it must not have.
 *
 * v73 gave the placement its endpoint columns and v74 gave the pair a name; the
 * two migration suites own those DB claims. This file owns what the aggregate
 * means to the application, which fails differently and in four ways:
 *
 *   1. ONE AGGREGATE, THREE PAIRINGS. `human↔agent`, `agent↔agent` and
 *      `human↔human` go through the same constructor and produce the same shape.
 *      Every pairing is asserted cell by cell rather than "a DM is created",
 *      because a special case would be invisible in a test that only exercised
 *      the pairing the product happens to ship first.
 *   2. GET-OR-CREATE IS IDEMPOTENT AND ORDER-FREE. A second call returns the
 *      same row with `created: false`, and so does a call that names the pair in
 *      the other order — normalization is the constructor's job, so no caller has
 *      to know which endpoint is the `a` side.
 *   3. THERE IS NO MEMBER STATE. Zero roster rows, and both member-mutation use
 *      cases refuse the placement. This is the half @Cindy's review gate asked
 *      for explicitly: P3 must not recreate member state next to endpoint
 *      identity.
 *   4. THE ROSTER IS NOT AN AUTHORITY HERE — IN EVERY FACE. The ACL suite
 *      (`direct-pair-endpoint-acl.test.ts`) pins the code face; this file pins
 *      the SQL one, `isAgentParticipant`, which delivery and P2's runtime target
 *      gate read. An injected roster row is INERT there too, while the endpoints
 *      are admitted — and the workspace arm still resolves through its roster, so
 *      the placement gate narrowed nothing it should not have.
 *
 * Everything goes through repositories and use cases: unlike the P0-e suites the
 * subject now HAS a production constructor, so a native INSERT here would be
 * testing a row this feature no longer needs anyone to hand-write.
 */
import { fixedWorkspaceName } from '@silverhand/shared';
import { fixedConversationTitle } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import type { ConversationEndpointIdentity } from '@silverhand/shared';
import { addConversationMember, removeConversationMember } from '../src/application/conversation-member.js';
import {
  canAddConversationMember,
  canPostToConversation,
  canReadConversation,
  canViewConversation,
} from '../src/permissions.js';
import type { Principal } from '../src/auth/principal.js';
import { AgentRepo } from '../src/repos/agent-repo.js';
import { UserRepo } from '../src/repos/user-repo.js';
import { WorkspaceRepo } from '../src/repos/workspace-repo.js';
import { ConversationRepo } from '../src/repos/conversation-repo.js';
import { MessageRepo } from '../src/repos/message-repo.js';
import { ChannelAttentionPreferenceRepo } from '../src/repos/channel-attention-preference-repo.js';
import { createSqliteMembershipPersistence } from '../src/repos/membership-persistence.js';
import { MembershipService } from '../src/services/membership-service.js';
import { HostRepo } from '../src/repos/host-repo.js';
import { buildTestApp, type TestApp } from './utils/app.js';

const NOW = 1_700_000_000_000;

interface Fixture {
  readonly t: TestApp;
  readonly agents: AgentRepo;
  readonly users: UserRepo;
  readonly conversations: ConversationRepo;
  /** Three agents and a second human, so every pairing has two live principals
   *  of the right kind AND a third principal that belongs to none of them. */
  readonly alice: ConversationEndpointIdentity;
  readonly bob: ConversationEndpointIdentity;
  readonly stranger: ConversationEndpointIdentity;
  readonly viewer: ConversationEndpointIdentity;
  readonly guest: ConversationEndpointIdentity;
}

/** Memberships are not fixture-seeded: this file asks who a placement admits, so
 *  a trigger that snapshots every fixture user into every conversation would
 *  answer that before the code under test does. */
function setup(): Fixture {
  const t = buildTestApp({ seedAllFixtureMemberships: false });
  const agents = new AgentRepo(t.ctx.db);
  const users = new UserRepo(t.ctx.db);
  const conversations = new ConversationRepo(t.ctx.db);
  const hostId = new HostRepo(t.ctx.db).ensureLocal().id;
  const agent = (name: string): ConversationEndpointIdentity => ({
    kind: 'agent',
    id: agents.create({ name, runtime: 'claude' }, hostId, t.viewerUserId).id,
  });
  return {
    t,
    agents,
    users,
    conversations,
    alice: agent('dp-alice'),
    bob: agent('dp-bob'),
    stranger: agent('dp-stranger'),
    viewer: { kind: 'human', id: t.viewerUserId },
    guest: {
      kind: 'human',
      id: users.create({ id: 'dp-guest-user', name: 'dp-guest', displayName: 'Guest' }).id,
    },
  };
}

function conversationDeps(t: TestApp) {
  const agents = new AgentRepo(t.ctx.db);
  const users = new UserRepo(t.ctx.db);
  const conversations = new ConversationRepo(t.ctx.db);
  const membership = new MembershipService({ agents, users, conversations });
  return {
    ctx: t.ctx,
    agents,
    users,
    workspaces: new WorkspaceRepo(t.ctx.db),
    conversations,
    messages: new MessageRepo(t.ctx.db),
    channelAttentionPrefs: new ChannelAttentionPreferenceRepo(t.ctx.db),
    membershipPersistence: createSqliteMembershipPersistence(t.ctx.db),
    membership,
  };
}

function running(agentId: string, conversationId: string): Principal {
  return { kind: 'agent', agentId, conversationId };
}

function human(userId: string): Principal {
  return { kind: 'user', userId };
}

describe('DirectPair aggregate: get-or-create', () => {
  it('is the same aggregate for all three pairings, cell by cell', () => {
    const f = setup();
    try {
      const ids = new Set<string>();
      for (const [x, y] of [
        [f.alice, f.viewer],
        [f.alice, f.bob],
        [f.viewer, f.guest],
      ] as const) {
        const { conversation, created } = f.conversations.getOrCreateDirectPair(x, y, NOW);
        expect(created).toBe(true);
        ids.add(conversation.id);
        // Nothing here is per-pairing: the placement, the derived `kind`, the
        // absence of both other coordinates, the stored title, and the presence
        // of a pair key are the aggregate's shape, not a property of who is in it.
        expect(conversation).toMatchObject({
          placement_kind: 'direct_pair',
          roster_policy: 'fixed',
          visibility: 'private',
          workspace_id: null,
          archived_at: null,
          endpoint_a_deleted_at: null,
          endpoint_b_deleted_at: null,
        });
        expect(conversation.pair_key).not.toBeNull();
        // The key NAMES the pair: both coordinates are recoverable from it, which
        // is what lets P0-f use `'pair:' || pair_key` as a board identity. The
        // byte format itself is pinned in the v74 migration suite; re-deriving it
        // here would be a second definition.
        expect(conversation.pair_key).toContain(x.id);
        expect(conversation.pair_key).toContain(y.id);
        // A DM stores no title: it has no single label, and a placeholder would
        // ship a stale one to every viewer (#task:2022 derives it per viewer).
        expect(f.conversations.get(conversation.id)?.title).toBe('');
      }
      // Three pairings, three distinct aggregates — not one row that the second
      // and third calls happened to find.
      expect(ids.size).toBe(3);
      // …and none of them appears in `listDmChannels`, which is a WORKSPACE-scoped
      // face (the agent-home DM) and says so with an explicit `WORKSPACE_PLACED`
      // predicate. The absence is a declared exclusion, not a JOIN dropping rows:
      // the `direct_pair` read surfaces are #task:2022's, and until they exist a
      // DM must be invisible rather than half-rendered inside a workspace list.
      expect(f.conversations.listDmChannels()).toEqual([]);
    } finally {
      f.t.cleanup();
    }
  });

  it('is idempotent and order-free', () => {
    const f = setup();
    try {
      const first = f.conversations.getOrCreateDirectPair(f.alice, f.viewer, NOW);
      expect(first.created).toBe(true);

      const again = f.conversations.getOrCreateDirectPair(f.alice, f.viewer, NOW + 1);
      expect(again.created).toBe(false);
      expect(again.conversation.id).toBe(first.conversation.id);

      // The reversed call is the SAME aggregate, not a second row that the unique
      // index happens to reject: `created` is false and the id matches.
      const reversed = f.conversations.getOrCreateDirectPair(f.viewer, f.alice, NOW + 2);
      expect(reversed.created).toBe(false);
      expect(reversed.conversation.id).toBe(first.conversation.id);
      expect(f.conversations.findDirectPair(f.viewer, f.alice)?.id).toBe(
        first.conversation.id,
      );
      expect(f.conversations.findDirectPair(f.alice, f.viewer)?.id).toBe(
        first.conversation.id,
      );
      // Uniqueness itself is the partial UNIQUE index's claim (pinned in the v74
      // suite); what matters here is that the second and third calls did not
      // create anything — `created: false` twice, one id throughout.
      expect(again.conversation.pair_key).toBe(first.conversation.pair_key);
      expect(reversed.conversation.pair_key).toBe(first.conversation.pair_key);
    } finally {
      f.t.cleanup();
    }
  });

  it('finds nothing for a pair that has no DM, without creating one', () => {
    const f = setup();
    try {
      expect(f.conversations.findDirectPair(f.alice, f.stranger)).toBeNull();
      expect(f.conversations.listDmChannels()).toHaveLength(0);
    } finally {
      f.t.cleanup();
    }
  });

  it('refuses a self-pair and every endpoint that names nobody', () => {
    const f = setup();
    try {
      // The one rule the DB cannot state, so the constructor owns it: "a DM with
      // myself" is a product question, not a constraint violation.
      expect(() => f.conversations.getOrCreateDirectPair(f.alice, f.alice, NOW)).toThrow(
        /two different principals/,
      );
      // …and the rules the DB DOES state are left to it: an id that names nobody,
      // and an id that exists in the OTHER principal table. A second TypeScript
      // check here could disagree with the trigger; a throw cannot.
      expect(() =>
        f.conversations.getOrCreateDirectPair(f.alice, { kind: 'agent', id: 'ghost' }, NOW),
      ).toThrow(/must name an existing principal/);
      expect(() =>
        f.conversations.getOrCreateDirectPair(
          f.alice,
          { kind: 'human', id: f.bob.id },
          NOW,
        ),
      ).toThrow(/must name an existing principal/);
      expect(() =>
        f.conversations.getOrCreateDirectPair(
          f.viewer,
          { kind: 'agent', id: f.viewer.id },
          NOW,
        ),
      ).toThrow(/must name an existing principal/);
      expect(f.conversations.listDmChannels()).toHaveLength(0);
    } finally {
      f.t.cleanup();
    }
  });
});

describe('DirectPair aggregate: no member state', () => {
  it('has zero roster rows on either side', () => {
    const f = setup();
    try {
      const { conversation } = f.conversations.getOrCreateDirectPair(f.alice, f.viewer, NOW);
      // Not "the roster is ignored" — there is nothing to ignore. The two
      // participants are the endpoint columns, so a roster row would be a second,
      // divergent record of who is in the DM.
      expect(f.conversations.listAgents(conversation.id)).toEqual([]);
      expect(f.conversations.listUsers(conversation.id)).toEqual([]);
      expect(f.conversations.getAgent(conversation.id, f.alice.id)).toBeNull();
    } finally {
      f.t.cleanup();
    }
  });

  it('refuses both member-mutation use cases as unsupported', async () => {
    const f = setup();
    try {
      const { conversation } = f.conversations.getOrCreateDirectPair(f.alice, f.viewer, NOW);
      const deps = conversationDeps(f.t);
      // Unreachable BY KIND, which is the property worth pinning: the guard is
      // `kind !== 'channel'`, and every non-workspace placement is `fixed` by the
      // DB's arc CHECK, so no future placement can slip past it by forgetting to
      // add itself to a list of exclusions.
      expect(
        await addConversationMember(deps, {
          conversationId: conversation.id,
          principal: human(f.t.viewerUserId),
          member: { kind: 'agent', agent_id: f.stranger.id },
        }),
      ).toEqual({ ok: false, error: { code: 'conversation_member_add_unsupported' } });
      expect(
        await removeConversationMember(deps, {
          conversationId: conversation.id,
          agentId: f.alice.id,
          principal: human(f.t.viewerUserId),
        }),
      ).toEqual({ ok: false, error: { code: 'unsupported' } });
      expect(f.conversations.listAgents(conversation.id)).toEqual([]);
    } finally {
      f.t.cleanup();
    }
  });
});

describe('DirectPair aggregate: participation authority', () => {
  it('admits the endpoints through the SQL face and nobody else', () => {
    const f = setup();
    try {
      const { conversation } = f.conversations.getOrCreateDirectPair(f.alice, f.bob, NOW);
      // `isAgentParticipant` is the port P2's runtime target gate and the delivery
      // faces read. Before P3 its `direct_pair` answer was NO for everyone, which
      // would have made a DM undeliverable rather than private.
      expect(f.conversations.isAgentParticipant(conversation.id, f.alice.id)).toBe(true);
      expect(f.conversations.isAgentParticipant(conversation.id, f.bob.id)).toBe(true);
      expect(f.conversations.isAgentParticipant(conversation.id, f.stranger.id)).toBe(false);
    } finally {
      f.t.cleanup();
    }
  });

  it('leaves an injected roster row INERT in the SQL face too', () => {
    const f = setup();
    try {
      const { conversation } = f.conversations.getOrCreateDirectPair(f.alice, f.bob, NOW);
      // The roster row is as real as any other — `getAgent` sees it — and it still
      // decides nothing. Both faces have to agree on that: a placement-blind
      // `EXISTS (SELECT … conversation_agents)` in the SQL arm would hand a
      // stranger someone's DM through delivery while the code arm correctly said
      // no, and nothing in the ACL suite would have noticed.
      f.conversations.addAgent(conversation.id, f.stranger.id);
      expect(f.conversations.getAgent(conversation.id, f.stranger.id)).not.toBeNull();
      expect(f.conversations.isAgentParticipant(conversation.id, f.stranger.id)).toBe(false);
      expect(
        canViewConversation(f.t.ctx, running(f.stranger.id, conversation.id), conversation.id),
      ).toBe(false);
      // The endpoints are unaffected by the noise.
      expect(f.conversations.isAgentParticipant(conversation.id, f.alice.id)).toBe(true);
    } finally {
      f.t.cleanup();
    }
  });

  it('still resolves the WORKSPACE arm through its roster', () => {
    const f = setup();
    try {
      // The placement gate narrows the roster EXISTS to the arm that owns it, so
      // the regression it could cause is the opposite one: a channel member must
      // still be a participant.
      const workspaces = new WorkspaceRepo(f.t.ctx.db);
      const ws = workspaces.insert({ name: fixedWorkspaceName('dp-room-ws'), description: null });
      const channel = f.conversations.insertChannel({
        workspaceId: ws.id,
        title: fixedConversationTitle('room'),
        visibility: 'public',
      });
      expect(f.conversations.isAgentParticipant(channel.id, f.alice.id)).toBe(false);
      f.conversations.addAgent(channel.id, f.alice.id);
      expect(f.conversations.isAgentParticipant(channel.id, f.alice.id)).toBe(true);
    } finally {
      f.t.cleanup();
    }
  });

  it('every ACL entry answers from the one placement resolver', () => {
    const f = setup();
    try {
      const { conversation } = f.conversations.getOrCreateDirectPair(f.alice, f.viewer, NOW);
      const id = conversation.id;
      // The convergence claim, stated as agreement between the entry points rather
      // than by inspecting the resolver: view / read / post are three questions
      // whose whole answer here IS participation, so any entry that re-derived
      // participation its own way would disagree with the others on at least one
      // of these rows.
      //
      // `canAddConversationMember` is deliberately NOT in this set: since @Cindy's
      // M1 it is a conjunction (participation floor AND "this roster is mutable at
      // all"), so on a DM it is false for admitted and refused principals alike —
      // which makes it useless as a convergence signal and would silently accept a
      // resolver that had started refusing the endpoints. It gets its own oracle
      // below, where the two conjuncts are varied independently.
      const entries = (principal: Principal) => ({
        view: canViewConversation(f.t.ctx, principal, id),
        read: canReadConversation(f.t.ctx, principal, id),
        post: canPostToConversation(f.t.ctx, principal, id),
      });
      const admitted = { view: true, read: true, post: true };
      const refused = { view: false, read: false, post: false };
      expect(entries(running(f.alice.id, id))).toEqual(admitted);
      expect(entries(human(f.t.viewerUserId))).toEqual(admitted);
      // A non-endpoint agent, an endpoint agent whose session runs somewhere else,
      // and a human who is not the endpoint: three ways to be outside the pair.
      expect(entries(running(f.stranger.id, id))).toEqual(refused);
      expect(entries(running(f.alice.id, 'somewhere-else'))).toEqual(refused);
      expect(entries(human(f.guest.id))).toEqual(refused);
    } finally {
      f.t.cleanup();
    }
  });
});

/**
 * @Cindy M1 on #task:2020 — the EXPORTED capability must not report a
 * participation fact under an operation's name.
 *
 * `canAddConversationMember` used to be the participation floor alone, so on a DM
 * it answered `true`: "this principal is inside the conversation" wearing the name
 * "this principal may add a member here". The use case refused anyway, on its own
 * `kind` guard — which is exactly the shape that does not survive a second caller,
 * because the next one inherits the `true`, not the guard.
 *
 * So the oracle varies the two conjuncts INDEPENDENTLY rather than asserting
 * `false` on a DM and stopping:
 *   - hold participation at its maximum (an endpoint, the owner, an admin) and
 *     vary the roster axis ⇒ every `fixed` roster is false, in both placements
 *     that can hold one, including the legacy WORKSPACE-placed `dm_channel` that
 *     has both a workspace and a real roster table;
 *   - hold the roster axis at `open` and vary participation ⇒ still true for a
 *     member and false for an outsider, so the narrowing did not degenerate into
 *     "member-add is never allowed", which would pass a `return false` stub.
 */
describe('DirectPair aggregate: member-add capability', () => {
  it('never claims a fixed roster can gain a member, whatever the placement or the principal', () => {
    const f = setup();
    try {
      const workspaces = new WorkspaceRepo(f.t.ctx.db);
      // The admin is the strongest human in the model: workspace `admin` role AND
      // a conversation_users row wherever one is possible. If the capability were
      // still a floor, this is the principal it would say `true` for.
      const admin = f.t.viewerUserId;

      const dm = f.conversations.getOrCreateDirectPair(f.alice, f.viewer, NOW).conversation;
      // The legacy arm: `placement_kind = 'workspace'`, an allocated address, a
      // roster that physically accepts rows — and `roster_policy = 'fixed'`, which
      // is the only reason it must refuse. Reading the generated `kind` instead
      // would happen to agree here and disagree on nothing observable, so the
      // point is that this row is covered by the SAME predicate as the DM.
      const ws = workspaces.insert({ name: fixedWorkspaceName('dp-cap-ws'), description: null });
      workspaces.addUserMember(ws.id, admin, 'admin');
      const legacyDm = f.conversations.insertDmChannel({
        workspaceId: ws.id,
        title: fixedConversationTitle('legacy dm'),
      });
      f.conversations.addUser(legacyDm.id, admin);
      f.conversations.addAgent(legacyDm.id, f.alice.id);

      for (const [label, id, insider] of [
        ['direct_pair', dm.id, running(f.alice.id, dm.id)],
        ['legacy dm_channel', legacyDm.id, running(f.alice.id, legacyDm.id)],
      ] as const) {
        // The insider IS a participant — asserted, so the `false` below cannot be
        // explained away as "this principal was outside anyway".
        expect(canViewConversation(f.t.ctx, insider, id), label).toBe(true);
        expect(canAddConversationMember(f.t.ctx, insider, id), label).toBe(false);
        expect(canAddConversationMember(f.t.ctx, human(admin), id), label).toBe(false);
        expect(canAddConversationMember(f.t.ctx, human(f.guest.id), id), label).toBe(false);
        expect(
          canAddConversationMember(f.t.ctx, running(f.stranger.id, id), id),
          label,
        ).toBe(false);
      }
      // The human endpoint of the DM is admitted to everything else and still
      // cannot add: on this placement the participant set is the two endpoint
      // columns, and no principal in the system can change it.
      expect(canReadConversation(f.t.ctx, human(admin), dm.id)).toBe(true);
      expect(canAddConversationMember(f.t.ctx, human(admin), dm.id)).toBe(false);
    } finally {
      f.t.cleanup();
    }
  });

  it('still claims it for an OPEN roster, and only for a participant', () => {
    const f = setup();
    try {
      const workspaces = new WorkspaceRepo(f.t.ctx.db);
      const ws = workspaces.insert({ name: fixedWorkspaceName('dp-cap-open-ws'), description: null });
      workspaces.addUserMember(ws.id, f.t.viewerUserId, 'admin');
      const channel = f.conversations.insertChannel({
        workspaceId: ws.id,
        title: fixedConversationTitle('room'),
        visibility: 'private',
      });
      // Floor first: not a conversation member yet ⇒ false even though the roster
      // is mutable, so the conjunction still has its participation half.
      expect(canAddConversationMember(f.t.ctx, human(f.t.viewerUserId), channel.id)).toBe(
        false,
      );
      f.conversations.addUser(channel.id, f.t.viewerUserId);
      expect(canAddConversationMember(f.t.ctx, human(f.t.viewerUserId), channel.id)).toBe(
        true,
      );
      f.conversations.addAgent(channel.id, f.alice.id);
      expect(
        canAddConversationMember(f.t.ctx, running(f.alice.id, channel.id), channel.id),
      ).toBe(true);
      expect(
        canAddConversationMember(f.t.ctx, running(f.stranger.id, channel.id), channel.id),
      ).toBe(false);
    } finally {
      f.t.cleanup();
    }
  });
});
