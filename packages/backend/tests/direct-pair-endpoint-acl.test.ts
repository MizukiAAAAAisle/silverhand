/**
 * #task:2017 (P0-e) — the ACL half of `direct_pair` endpoints.
 *
 * The migration suite (`direct-pair-endpoint-migration.test.ts`) pins what the
 * SCHEMA guarantees: an endpoint is born naming a live principal of its own
 * kind, its coordinates never change, and its `deleted_at` stamp is written by
 * the delete itself and never unwritten. This file pins what those columns MEAN
 * to authorization, which is a different claim and fails differently:
 *
 *   1. PARTICIPATION IS THE PLACEMENT. A `direct_pair` row has no workspace and
 *      no roster of record: its two participants ARE its endpoints. So the arm
 *      is proved to admit exactly them and — the falsifier that matters — to
 *      ignore `conversation_users` / `conversation_agents` rows for anyone else.
 *      Roster rows on such a row are meaningless, not authoritative, and a
 *      future reader who "fixes" the arm by falling through to the roster tables
 *      would hand a stranger someone's DM.
 *   2. THE AGENT ENDPOINT IS STILL RUNNING-IN GATED. Naming the agent is not
 *      enough; the session must be acting inside that conversation, exactly as
 *      the workspace arm demands. A session in channel A does not reach into a
 *      DM by reference.
 *   3. A HALF-DEAD DM IS READ-ONLY, NOT UNREADABLE. History survives the other
 *      side's deletion — that is the entire reason an endpoint is a historical
 *      coordinate instead of a foreign key — while the WRITE gate closes. There
 *      is no `readonly` column and no status change: `canPostToConversation`
 *      re-derives it from the endpoints every time it is asked.
 *   4. THE TOMBSTONE IS NOT LOAD-BEARING, IN BOTH DIRECTIONS. Two fault
 *      injections, each of which would pass if the gate trusted one source:
 *      delete the principal with the stamping trigger DROPPED (stamp stays
 *      NULL — the lookup must still say "gone"), and stamp an endpoint whose
 *      principal is very much alive (the stamp must still be believed). The
 *      first is the one with teeth: if the gate read only the stamp, any delete
 *      path that ever forgot to stamp would leave the survivor writing into a
 *      DM with nobody on the other end.
 *
 * The `direct_pair` rows are inserted with native SQL on purpose: v73 gives the
 * placement its columns and its rules, and P3 gives it get-or-create, delivery
 * and a wire face. Until then the ACL is reachable and the constructor is not,
 * so the test builds the row the way the schema defines it rather than waiting
 * for a service that does not exist yet.
 */
import { describe, expect, it } from 'vitest';
import {
  canPostToConversation,
  canReadConversation,
  canViewConversation,
} from '../src/permissions.js';
import type { Principal } from '../src/auth/principal.js';
import { AgentRepo } from '../src/repos/agent-repo.js';
import { ConversationRepo } from '../src/repos/conversation-repo.js';
import { HostRepo } from '../src/repos/host-repo.js';
import { buildTestApp, type TestApp } from './utils/app.js';

const INSERT_DIRECT_PAIR = `
  INSERT INTO conversations
    (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
     endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
     endpoint_a_deleted_at, endpoint_b_deleted_at,
     title, status, created_at, updated_at)
  VALUES (?, NULL, NULL, 'direct_pair', 'fixed', ?, ?, ?, ?, NULL, NULL,
          'DM', 'idle', 1, 1)
`;

interface Fixture {
  readonly t: TestApp;
  readonly agents: AgentRepo;
  readonly conversations: ConversationRepo;
  /** The agent endpoint shared by both DM rows below. */
  readonly self: string;
  /** The other agent endpoint of {@link Fixture.dpAgents}. */
  readonly peer: string;
  /** An agent that is an endpoint of nothing. */
  readonly stranger: string;
  /** `agent` ↔ `human` DM: `self` and the fixture viewer `local`. */
  readonly dpHuman: string;
  /** `agent` ↔ `agent` DM: `self` and `peer`. */
  readonly dpAgents: string;
}

/**
 * Memberships are NOT fixture-seeded here: the whole point is which rows admit
 * a principal, so a trigger that snapshots every fixture user into every new
 * conversation would answer the question before the ACL does.
 */
function setup(): Fixture {
  const t = buildTestApp({ seedAllFixtureMemberships: false });
  const agents = new AgentRepo(t.ctx.db);
  const conversations = new ConversationRepo(t.ctx.db);
  const hostId = new HostRepo(t.ctx.db).ensureLocal().id;
  const mk = (name: string): string =>
    agents.create({ name, runtime: 'claude' }, hostId, t.viewerUserId).id;
  const self = mk('dp-self');
  const peer = mk('dp-peer');
  const stranger = mk('dp-stranger');

  const insert = t.ctx.db.prepare(INSERT_DIRECT_PAIR);
  insert.run('dp-human', 'agent', self, 'human', t.viewerUserId);
  // Same-kind endpoints are ordered by id, so the canonical-order CHECK decides
  // which agent is the `a` side — not the test's idea of "mine" and "theirs".
  const [lo, hi] = self < peer ? [self, peer] : [peer, self];
  insert.run('dp-agents', 'agent', lo, 'agent', hi);

  return {
    t,
    agents,
    conversations,
    self,
    peer,
    stranger,
    dpHuman: 'dp-human',
    dpAgents: 'dp-agents',
  };
}

/** The agent principal for a session RUNNING IN `conversationId`. */
function running(agentId: string, conversationId: string): Principal {
  return { kind: 'agent', agentId, conversationId };
}

function human(userId: string): Principal {
  return { kind: 'user', userId };
}

const SYSTEM: Principal = { kind: 'system' };

function gates(f: Fixture, principal: Principal, conversationId: string) {
  return {
    view: canViewConversation(f.t.ctx, principal, conversationId),
    read: canReadConversation(f.t.ctx, principal, conversationId),
    post: canPostToConversation(f.t.ctx, principal, conversationId),
  };
}

function tombstones(
  f: Fixture,
  conversationId: string,
): { a: number | null; b: number | null } {
  const row = f.t.ctx.db
    .prepare<
      [string],
      { endpoint_a_deleted_at: number | null; endpoint_b_deleted_at: number | null }
    >(
      `SELECT endpoint_a_deleted_at, endpoint_b_deleted_at
         FROM conversations WHERE id = ?`,
    )
    .get(conversationId)!;
  return { a: row.endpoint_a_deleted_at, b: row.endpoint_b_deleted_at };
}

describe('direct_pair endpoints: participation', () => {
  it('admits exactly the two endpoints, each on its own kind of principal', () => {
    const f = setup();
    try {
      expect(gates(f, running(f.self, f.dpHuman), f.dpHuman)).toEqual({
        view: true,
        read: true,
        post: true,
      });
      expect(gates(f, human(f.t.viewerUserId), f.dpHuman)).toEqual({
        view: true,
        read: true,
        post: true,
      });
      expect(gates(f, running(f.self, f.dpAgents), f.dpAgents)).toEqual({
        view: true,
        read: true,
        post: true,
      });
      expect(gates(f, running(f.peer, f.dpAgents), f.dpAgents)).toEqual({
        view: true,
        read: true,
        post: true,
      });
      // `system` is admitted before placement is even consulted (it is the
      // delivery/maintenance principal), and a live DM is writable by it.
      expect(gates(f, SYSTEM, f.dpHuman)).toEqual({
        view: true,
        read: true,
        post: true,
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('does not admit the WRONG principal kind for an endpoint', () => {
    const f = setup();
    try {
      // The human endpoint names `local`; an AGENT with that id would be a
      // different namespace's principal, and vice versa. Both directions are
      // asserted because a kind-blind `endpoint.id === principal id` comparison
      // would pass one of them.
      expect(gates(f, running(f.t.viewerUserId, f.dpHuman), f.dpHuman)).toEqual({
        view: false,
        read: false,
        post: false,
      });
      expect(gates(f, human(f.self), f.dpHuman)).toEqual({
        view: false,
        read: false,
        post: false,
      });
      // …and the agent↔agent DM admits no human at all, viewer included.
      expect(gates(f, human(f.t.viewerUserId), f.dpAgents)).toEqual({
        view: false,
        read: false,
        post: false,
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('ignores roster rows: they are not the participant authority here', () => {
    const f = setup();
    try {
      // Both rows exist and are as real as any other roster row — they are
      // simply not what decides participation for this placement.
      f.conversations.addUser(f.dpHuman, 'bob');
      f.conversations.addAgent(f.dpHuman, f.stranger);
      expect(f.t.ctx.authorizationReads.isConversationUser(f.dpHuman, 'bob')).toBe(
        true,
      );
      expect(
        f.t.ctx.authorizationReads.isConversationAgent(f.dpHuman, f.stranger),
      ).toBe(true);

      expect(gates(f, human('bob'), f.dpHuman)).toEqual({
        view: false,
        read: false,
        post: false,
      });
      expect(gates(f, running(f.stranger, f.dpHuman), f.dpHuman)).toEqual({
        view: false,
        read: false,
        post: false,
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('keeps the agent endpoint RUNNING-IN gated', () => {
    const f = setup();
    try {
      // `self` is an endpoint of BOTH DMs. A session running in one of them
      // does not thereby act inside the other.
      expect(gates(f, running(f.self, f.dpHuman), f.dpAgents)).toEqual({
        view: false,
        read: false,
        post: false,
      });
      expect(gates(f, running(f.self, f.dpAgents), f.dpHuman)).toEqual({
        view: false,
        read: false,
        post: false,
      });
      // The human endpoint has no such rule — a person is not "running in" a
      // conversation — which is why the two arms are written separately.
      expect(canViewConversation(f.t.ctx, human(f.t.viewerUserId), f.dpHuman)).toBe(
        true,
      );
    } finally {
      f.t.cleanup();
    }
  });
});

describe('direct_pair endpoints: a half-dead DM is read-only', () => {
  it('survivor keeps reading, loses posting, per side and per kind', () => {
    const f = setup();
    try {
      f.agents.delete(f.peer);
      expect(f.t.ctx.authorizationReads.agent(f.peer)).toBeNull();
      // Whichever side `peer` landed on is now stamped, and only that side.
      const stamps = tombstones(f, f.dpAgents);
      const [dead, alive] = f.self < f.peer ? [stamps.b, stamps.a] : [stamps.a, stamps.b];
      expect(dead).toBeGreaterThan(0);
      expect(alive).toBeNull();

      expect(gates(f, running(f.self, f.dpAgents), f.dpAgents)).toEqual({
        view: true,
        read: true,
        post: false,
      });
      // The OTHER DM is untouched: read-only is a fact about one row's
      // endpoints, not a mode the agent enters.
      expect(gates(f, running(f.self, f.dpHuman), f.dpHuman)).toEqual({
        view: true,
        read: true,
        post: true,
      });

      // Now kill the agent side of the human DM. The human survivor reads a DM
      // whose agent is gone, and cannot write into it.
      f.agents.delete(f.self);
      expect(tombstones(f, f.dpHuman).a).toBeGreaterThan(0);
      expect(tombstones(f, f.dpHuman).b).toBeNull();
      expect(gates(f, human(f.t.viewerUserId), f.dpHuman)).toEqual({
        view: true,
        read: true,
        post: false,
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('read-only means read-only: `system` cannot post either', () => {
    const f = setup();
    try {
      f.agents.delete(f.peer);
      // Deliberate, and the reason the gate tests the CONVERSATION rather than
      // the caller: there is nobody to deliver to. If P3 wants a farewell
      // notice in the transcript it is written inside the teardown transaction,
      // by the code that knows the agent is going away — not admitted here by
      // widening the write gate for a privileged principal.
      expect(gates(f, SYSTEM, f.dpAgents)).toEqual({
        view: true,
        read: true,
        post: false,
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('a deleted principal cannot write through its own coordinate', () => {
    const f = setup();
    try {
      f.agents.delete(f.peer);
      // The coordinate still names `peer` — that is the point of a historical
      // coordinate — so the view gate still matches it. Only a live process
      // could present this principal, so this is a property statement, not a
      // reachable attack: BOTH endpoints are tested, so the answer does not
      // depend on which side is asking.
      expect(gates(f, running(f.peer, f.dpAgents), f.dpAgents)).toEqual({
        view: true,
        read: true,
        post: false,
      });
    } finally {
      f.t.cleanup();
    }
  });
});

describe('direct_pair endpoints: the tombstone is not load-bearing', () => {
  it('deleted WITHOUT a stamp is still gone (lookup is the authority)', () => {
    const f = setup();
    try {
      // Fault injection: the only writer of the stamp is removed, so the delete
      // below leaves the column NULL. A gate that read the stamp alone would
      // hand the survivor a live write path into a dead DM.
      f.t.ctx.db.exec('DROP TRIGGER trg_agents_stamp_endpoint_deleted');
      f.agents.delete(f.peer);

      expect(tombstones(f, f.dpAgents)).toEqual({ a: null, b: null });
      expect(gates(f, running(f.self, f.dpAgents), f.dpAgents)).toEqual({
        view: true,
        read: true,
        post: false,
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('stamped while the principal is ALIVE is still gone (the stamp is believed)', () => {
    const f = setup();
    try {
      // The other direction: the stamp is a shortcut, so it must answer without
      // a lookup. A gate that only ever asked the lookup would ignore it, and
      // the monotonic trigger's whole purpose — a stamp, once written, is
      // permanent — would be unobservable at the ACL.
      f.t.ctx.db
        .prepare('UPDATE conversations SET endpoint_b_deleted_at = 500 WHERE id = ?')
        .run(f.dpHuman);
      expect(f.t.ctx.authorizationReads.agent(f.self)).not.toBeNull();

      expect(gates(f, running(f.self, f.dpHuman), f.dpHuman)).toEqual({
        view: true,
        read: true,
        post: false,
      });
      expect(gates(f, human(f.t.viewerUserId), f.dpHuman)).toEqual({
        view: true,
        read: true,
        post: false,
      });
    } finally {
      f.t.cleanup();
    }
  });
});
