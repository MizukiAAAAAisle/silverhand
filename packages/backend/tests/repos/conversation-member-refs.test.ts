/**
 * The membership cascade's READ SHAPE (#task:1987) — `(workspaceId, member)` as
 * ONE scoped query instead of "list the whole `conversations` table, then probe
 * membership once per row".
 *
 * Three properties are gated here, and each one is the reason a different way of
 * getting this wrong would redden:
 *
 *  1. EQUIVALENCE, differentially. The pre-#1987 algorithm is frozen below and
 *     executed as an ORACLE over the same fixture — with the same still-existing
 *     repo methods it used in production. A hand-written expectation table would
 *     only encode what I believe the old shape returned; the old shape itself is
 *     the authority on that. Both member arms and both workspaces run through it,
 *     with a per-case row count so no pair can pass by both sides being empty.
 *  2. COST, mechanically. The statement counter below wraps the `Database` handle
 *     the adapter is built from, so the assertion is over what production really
 *     prepares. "N+1 is gone" is asserted as SCALE INVARIANCE — the count must not
 *     move when the workspace grows — and the same counter run against the frozen
 *     oracle shows it reddening, which is what proves the instrument works.
 *  3. The ACCESS PATH, over the exported production SQL. EXPLAINing a simplified
 *     copy would stay green while production regressed to a scan.
 *
 * Ordering is part of the contract, not decoration: the cascade writes one audit
 * message per conversation in the order this query returns them, so the order
 * decides those messages' `seq`. That contract is `updated_at DESC` and nothing
 * more — ties stay undefined, exactly as before this change.
 */
import type { Database as Db } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  MembershipConversationRef,
  WorkspaceMemberRef,
} from '../../src/application/membership-ports.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import {
  ConversationRepo,
  WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL,
  WORKSPACE_CONVERSATION_REFS_FOR_USER_SQL,
} from '../../src/repos/conversation-repo.js';
import { createSqliteMembershipPersistence } from '../../src/repos/membership-persistence.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

/**
 * The pre-#1987 `createSqliteMembershipPersistence.conversationsWithMember`,
 * frozen verbatim: full-table list → workspace filter → per-row membership probe.
 * It still runs on today's repos because every method it used survives — which is
 * exactly what makes it a usable oracle rather than a re-implementation.
 */
function legacyRefs(
  conversations: ConversationRepo,
  workspaceId: string,
  member: WorkspaceMemberRef,
): MembershipConversationRef[] {
  return conversations
    .list()
    .filter(
      conversation =>
        conversation.workspace_id === workspaceId
        && (member.kind === 'agent'
          ? conversations.getAgent(conversation.id, member.id) !== null
          : conversations.getUser(conversation.id, member.id) !== null),
    )
    .map(conversation => ({
      id: conversation.id,
      // The filter above established `workspace_id === workspaceId`, so naming the
      // scope here is the same value the frozen algorithm projected — and it stays
      // exact now that a conversation's `workspace_id` is nullable (a
      // workspace-less placement can never satisfy that filter).
      workspace_id: workspaceId,
    }));
}

/** Production's own entry point, so the differential covers the adapter (and its
 *  projection boundary), not just the repo method underneath it. */
function currentRefs(
  db: Db,
  workspaceId: string,
  member: WorkspaceMemberRef,
): MembershipConversationRef[] {
  return createSqliteMembershipPersistence(db).read.listConversationsWithMember(
    workspaceId,
    member,
  );
}

/**
 * A `Database` façade that records every prepared statement. The adapter builds
 * its repos from whatever handle it is given, so wrapping the handle measures the
 * queries PRODUCTION issues — no repo needs to know it is being counted.
 */
function countingDb(db: Db): { handle: Db; prepared: string[] } {
  const prepared: string[] = [];
  const handle = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (source: string) => {
          prepared.push(source);
          return target.prepare(source);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Db;
  return { handle, prepared };
}

interface Fixture {
  db: Db;
  conversations: ConversationRepo;
  /** The two workspaces: the cascade's target and a bystander. */
  wsA: string;
  wsB: string;
  /** wsA channels: subject is a member of 1 and 2, absent from 3. */
  chA1: string;
  chA2: string;
  chA3: string;
  /** wsB channel the subject IS a member of — only the workspace term excludes it. */
  chB1: string;
  subjectAgent: string;
  decoyAgent: string;
  /** A USER whose id equals `subjectAgent`, member of a channel the agent is not
   *  in: an arm that read the wrong membership table would pick it up. */
  twinUserChannel: string;
  members: Array<{ label: string; member: WorkspaceMemberRef }>;
}

/**
 * `updated_at` is distinct across every conversation on purpose: under distinct
 * keys the frozen oracle's order (`ORDER BY updated_at DESC` over the whole
 * table) is a TOTAL order, so the differential can assert exact arrays. Ties are
 * not contracted by either shape, so the fixture never creates one.
 */
function buildFixture(): Fixture {
  const { db, localHostId } = openTestDb({ seedAllFixtureMemberships: false });
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);

  const subject = agents.create({ name: 'refs-subject', runtime: 'claude' }, localHostId, 'local');
  const decoy = agents.create({ name: 'refs-decoy', runtime: 'claude' }, localHostId, 'local');

  const wsA = workspaces.insert({ name: 'refs-a', description: null }).id;
  const wsB = workspaces.insert({ name: 'refs-b', description: null }).id;

  const channel = (workspaceId: string, title: string): string =>
    conversations.insertChannel({ name: title, workspaceId, title }).id;
  const chA1 = channel(wsA, 'a1');
  const chA2 = channel(wsA, 'a2');
  const chA3 = channel(wsA, 'a3-no-subject');
  const twinUserChannel = channel(wsA, 'a4-twin-user-only');
  const chB1 = channel(wsB, 'b1');

  // A user id that COLLIDES with the agent id. Nothing forbids it, and it is the
  // only fixture that can tell "read `conversation_agents`" apart from "read
  // whichever membership table" — the agent is not a member of this channel.
  new UserRepo(db).create({
    id: subject.id,
    name: 'refs-twin-test',
    displayName: 'Refs Twin',
  });
  conversations.addUser(twinUserChannel, subject.id);

  for (const conversationId of [chA1, chA2, chB1]) {
    conversations.addAgent(conversationId, subject.id);
    conversations.addUser(conversationId, 'local');
  }
  // The bystanders: another agent and another human in a channel the subject is
  // not in, so an arm that ignored its member argument would over-report.
  conversations.addAgent(chA3, decoy.id);
  conversations.addUser(chA3, 'alice');

  // Distinct, deliberately NOT insertion order: the query must sort, not echo.
  const stamp = db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`);
  for (const [i, conversationId] of [chA2, chB1, twinUserChannel, chA1, chA3].entries()) {
    stamp.run(1_000 + i, conversationId);
  }

  return {
    db,
    conversations,
    wsA,
    wsB,
    chA1,
    chA2,
    chA3,
    chB1,
    subjectAgent: subject.id,
    decoyAgent: decoy.id,
    twinUserChannel,
    members: [
      { label: 'subject agent', member: { kind: 'agent', id: subject.id } },
      { label: 'decoy agent', member: { kind: 'agent', id: decoy.id } },
      { label: 'subject human', member: { kind: 'human', id: 'local' } },
      { label: 'bystander human', member: { kind: 'human', id: 'alice' } },
      { label: 'human with no rows', member: { kind: 'human', id: 'bob' } },
    ],
  };
}

describe('#task:1987 membership cascade read shape — equivalence', () => {
  it('matches the frozen list-then-probe oracle for every (workspace, member) pair', () => {
    const f = buildFixture();
    // Row counts per pair, asserted individually: the differential must never be
    // able to pass because both sides returned nothing everywhere.
    const expected: Record<string, number> = {
      'refs-a|subject agent': 2,
      'refs-a|decoy agent': 1,
      'refs-a|subject human': 2,
      'refs-a|bystander human': 1,
      'refs-a|human with no rows': 0,
      'refs-b|subject agent': 1,
      'refs-b|decoy agent': 0,
      'refs-b|subject human': 1,
      'refs-b|bystander human': 0,
      'refs-b|human with no rows': 0,
    };
    for (const [name, workspaceId] of [
      ['refs-a', f.wsA],
      ['refs-b', f.wsB],
    ] as const) {
      for (const { label, member } of f.members) {
        const actual = currentRefs(f.db, workspaceId, member);
        expect(actual).toEqual(legacyRefs(f.conversations, workspaceId, member));
        expect(actual).toHaveLength(expected[`${name}|${label}`]!);
      }
    }
    // The twin: same id, different membership table. The agent arm must not see
    // the channel the equally-named USER joined, and the human arm must see only
    // that one.
    const twin: WorkspaceMemberRef = { kind: 'human', id: f.subjectAgent };
    expect(currentRefs(f.db, f.wsA, twin).map(r => r.id)).toEqual([f.twinUserChannel]);
    expect(currentRefs(f.db, f.wsA, { kind: 'agent', id: f.subjectAgent }).map(r => r.id)).not
      .toContain(f.twinUserChannel);
  });

  it('carries exactly the two ref fields — no conversation DTO leaks through', () => {
    const f = buildFixture();
    for (const ref of currentRefs(f.db, f.wsA, { kind: 'agent', id: f.subjectAgent })) {
      expect(Object.keys(ref).sort()).toEqual(['id', 'workspace_id']);
      expect(ref.workspace_id).toBe(f.wsA);
    }
  });

  it('keeps `updated_at DESC` — the pre-existing ordering contract', () => {
    const f = buildFixture();
    const agentRefs = (): string[] =>
      currentRefs(f.db, f.wsA, { kind: 'agent', id: f.subjectAgent }).map(r => r.id);
    // chA1 was stamped after chA2 in the fixture, so it leads.
    expect(agentRefs()).toEqual([f.chA1, f.chA2]);
    f.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(9_999, f.chA2);
    expect(agentRefs()).toEqual([f.chA2, f.chA1]);
  });
});

describe('#task:1987 membership cascade read shape — cost', () => {
  /** Grow the workspace: `withMember` conversations the subject joins plus
   *  `bystanders` it does not, so both the scan-sized and the probe-sized term of
   *  the old shape grow. */
  function grow(f: Fixture, withMember: number, bystanders: number): void {
    for (let i = 0; i < withMember; i += 1) {
      const id = f.conversations.insertChannel({
        name: `grow-${i}`,
        workspaceId: f.wsA,
        title: `grow-${i}`,
      }).id;
      f.conversations.addAgent(id, f.subjectAgent);
    }
    for (let i = 0; i < bystanders; i += 1) {
      f.conversations.insertChannel({
        name: `bystander-${i}`,
        workspaceId: f.wsB,
        title: `bystander-${i}`,
      });
    }
  }

  it('is ONE query per pass — the hint and the in-lock recompute alike', () => {
    const f = buildFixture();
    const member: WorkspaceMemberRef = { kind: 'agent', id: f.subjectAgent };
    const { handle, prepared } = countingDb(f.db);
    const persistence = createSqliteMembershipPersistence(handle);

    persistence.read.listConversationsWithMember(f.wsA, member);
    expect(prepared).toEqual([WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL]);

    // The authoritative recompute is the same query, so a removal's two passes
    // cost two statements in total — not 2 × (1 + N).
    prepared.length = 0;
    persistence.uow.atomically({ workspaceId: f.wsA, member }, tx => {
      tx.membership.listConversationsWithMemberForUpdate();
    });
    expect(prepared.filter(sql => sql.includes('FROM conversation_agents m'))).toEqual([
      WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL,
    ]);
  });

  it('costs the same at 25 conversations as at 2 — while the oracle does not', () => {
    const f = buildFixture();
    const member: WorkspaceMemberRef = { kind: 'human', id: 'local' };
    const { handle, prepared } = countingDb(f.db);
    const persistence = createSqliteMembershipPersistence(handle);
    const countCurrent = (): number => {
      prepared.length = 0;
      persistence.read.listConversationsWithMember(f.wsA, member);
      return prepared.length;
    };
    const countLegacy = (): number => {
      prepared.length = 0;
      legacyRefs(new ConversationRepo(handle), f.wsA, member);
      return prepared.length;
    };

    const currentBefore = countCurrent();
    const legacyBefore = countLegacy();
    expect(currentBefore).toBe(1);

    grow(f, 20, 20);
    // Scale invariance is the claim; the oracle's growth on the same counter is
    // what proves the counter would notice a regression.
    expect(countCurrent()).toBe(currentBefore);
    expect(countLegacy()).toBeGreaterThan(legacyBefore);
    expect(countCurrent()).toBe(1);
  });
});

describe('#task:1987 membership cascade read shape — query plan', () => {
  const planOf = (db: Db, sql: string, binds: unknown[]): string[] =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>).map(
      r => r.detail,
    );

  /**
   * Asserted structurally, never by wall clock — and asserted as PROPERTIES of the
   * access path rather than as a pinned plan, because the loop DIRECTION is
   * deliberately left to the planner.
   *
   * The two arms' selectivity profiles are opposite, so there is no single
   * direction to pin. A human is a member of nearly every conversation (v1 has one
   * human), so their edge set is the size of the database and the workspace term is
   * the selective one; an agent joins a handful of channels, so its edge set is the
   * selective one. Nailing the order with `CROSS JOIN` would optimize one arm and
   * pessimize the other.
   *
   * What must hold either way is that BOTH terms are index seeks, so the loop is
   * bounded by one workspace's conversations or one member's edges — never by the
   * table. That is the whole difference from the pre-#1987 shape, and these are its
   * two mechanical signatures: no `SCAN` anywhere, and the member column appearing
   * as an index CONSTRAINT rather than a row filter.
   */
  const expectSeekOnly = (plan: string[], memberColumn: string): void => {
    expect(plan.filter(line => line.startsWith('SEARCH'))).toHaveLength(2);
    expect(plan.join('\n')).not.toContain('SCAN');
    const member = plan.find(line => line.startsWith('SEARCH m '));
    expect(member).toMatch(/USING (COVERING )?INDEX \S+ \(/);
    expect(member).toContain(`${memberColumn}=?`);
    const conversation = plan.find(line => line.startsWith('SEARCH c '));
    expect(conversation).toMatch(/USING (COVERING )?(INDEX \S+|INTEGER PRIMARY KEY) \(/);
    expect(conversation).toMatch(/\b(workspace_id=\?|id=\?|rowid=\?)/);
    // The one temp b-tree is the ORDER BY over the rows those seeks produced. A
    // second one would mean something upstream is materializing more than them.
    expect(plan.join('\n').match(/USE TEMP B-TREE/g)).toEqual(['USE TEMP B-TREE']);
    expect(plan).toContain('USE TEMP B-TREE FOR ORDER BY');
  };

  it('reaches both tables by a constrained index seek, in either direction', () => {
    const f = buildFixture();
    expectSeekOnly(
      planOf(f.db, WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL, [f.subjectAgent, f.wsA]),
      'agent_id',
    );
    expectSeekOnly(
      planOf(f.db, WORKSPACE_CONVERSATION_REFS_FOR_USER_SQL, ['local', f.wsA]),
      'user_id',
    );
  });

  it('needs no new index: the seeks above use ones the schema already had', () => {
    const f = buildFixture();
    // The "add the index in the same cut if it is missing" obligation, discharged
    // by evidence instead of by reading the schema: every index the two plans rely
    // on is named here, and each is either a pre-existing declared index or a
    // primary-key autoindex.
    const used = [
      ...planOf(f.db, WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL, [f.subjectAgent, f.wsA]),
      ...planOf(f.db, WORKSPACE_CONVERSATION_REFS_FOR_USER_SQL, ['local', f.wsA]),
    ]
      .flatMap(line => line.match(/USING (?:COVERING )?INDEX (\S+)/)?.slice(1) ?? [])
      .sort();
    expect(used.length).toBeGreaterThan(0);
    const declared = new Set(
      (
        f.db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
          .all() as Array<{ name: string }>
      ).map(r => r.name),
    );
    for (const index of used) expect(declared).toContain(index);
  });
});

