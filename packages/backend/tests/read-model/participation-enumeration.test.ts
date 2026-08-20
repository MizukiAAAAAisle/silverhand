/**
 * Recipient enumeration: the SET-shaped reading of participation
 * (agent-scoped-session-v1 §4.2, #task:2021 P4-5).
 *
 * `conversation-placement-sql.ts` now carries the participation rule TWICE — as a
 * predicate over one agent (`agentParticipates` / `…Correlated`) and as a set of
 * candidate ids produced by the placement (`PARTICIPANT_AGENT_IDS_SQL`). Two texts
 * for one rule is a real cost, taken because the predicate reading cannot
 * enumerate without offering every agent in the installation as a candidate: the
 * send path's recipient query planned as a full `SCAN a` on EVERY message, so cost
 * tracked how many agents exist rather than how big the conversation is.
 *
 * Gate 9 pays for the text half — both roster reads are pinned fragments, so a
 * THIRD one is still a gate failure. This file pays for the other two halves,
 * which no static check can see:
 *
 *   1. AGREEMENT. The two readings are asserted equal over the whole
 *      placement × liveness matrix, in the exact form that states their one
 *      intended difference:
 *
 *          a ∈ listParticipantAgentIds(c)  ⟺  isAgentParticipant(c, a) ∧ live(a)
 *
 *      Not "both return something plausible for a DM": every conversation is
 *      crossed with every agent id, including deleted ones, so an arm dropped from
 *      either reading is reported as a disagreement instead of as an empty list
 *      that looks like a domain decision.
 *   2. THE ACCESS PATH, over the exported production SQL (#1967's rule: EXPLAIN the
 *      constant the repo executes, never a simplified copy). The falsifier is the
 *      regression itself — a candidate scan of `agents` — and it is asserted
 *      against a fixture where scanning would still return the right answer, which
 *      is precisely why values tests cannot catch it.
 *
 * The `agentParticipatesCorrelated` reading keeps ONE caller
 * (`listFollowerAgentIdsParticipating`), and its plan is pinned here too: it
 * FILTERS a set already bounded by `thread_followers`, so the predicate is
 * evaluated per follower row and `agents` is probed by primary key. That is the
 * distinction between the two readings stated as a plan rather than as prose — if
 * the follower query ever starts scanning, the correlated form has been used to
 * enumerate again.
 */
import { fixedWorkspaceName } from '@silverhand/shared';
import { fixedConversationTitle } from '@silverhand/shared';
import type { Database as Db } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import {
  ConversationRepo,
  DIRECT_PAIRS_FOR_VIEWER_SQL,
  LIVE_PARTICIPANT_AGENT_IDS_SQL,
  LIVE_PARTICIPANT_USER_IDS_SQL,
} from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import {
  FOLLOWER_AGENT_IDS_PARTICIPATING_SQL,
  ThreadFollowerRepo,
} from '../../src/repos/thread-follower-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

const NOW = 1_700_000_000_000;

interface Matrix {
  db: Db;
  conversations: ConversationRepo;
  agents: AgentRepo;
  users: UserRepo;
  workspaces: WorkspaceRepo;
  messages: MessageRepo;
  threadFollowers: ThreadFollowerRepo;
  localHostId: string;
  /** The one workspace every placed conversation here belongs to. */
  workspaceId: string;
  /** Every conversation in the fixture, one per placement arm. */
  conversationIds: Record<string, string>;
  /** Every agent id the matrix crosses, INCLUDING the deleted one. */
  agentIds: Record<string, string>;
  /** Every user id the matrix crosses, INCLUDING the deleted one and the two
   *  that hold exactly ONE of the two facts a channel seat requires. */
  userIds: Record<string, string>;
}

/**
 * One conversation per placement arm, plus the states that make the arms
 * distinguishable — for BOTH principal kinds, since the same rule is now read two
 * ways for each of them:
 *
 *   - a STRAY roster row on the rosterless placements (it must be inert — the
 *     roster is authoritative for the workspace arm only), agent AND human;
 *   - a DELETED principal that still participates (the `direct_pair` arms ignore
 *     `endpoint_*_deleted_at` on purpose, so existence is the only thing that can
 *     exclude it), agent AND human;
 *   - HALF a channel seat, twice: human participation in a channel is the v25 PAIR,
 *     so one person holds a `conversation_users` seat WITHOUT workspace membership
 *     and another holds membership without a seat. Each fails a different conjunct,
 *     and neither is a participant.
 *
 * `seedAllFixtureMemberships: false`: the fixture trigger would seed roster rows
 * everywhere, which is the one thing that would make a stray row look normal — and
 * would also hand every fixture user a seat, erasing the half-seat states above.
 */
function buildMatrix(): Matrix {
  const { db, localHostId, viewerUserId } = openTestDb({
    seedAllFixtureMemberships: false,
  });
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);
  const users = new UserRepo(db);
  const messages = new MessageRepo(db);
  const threadFollowers = new ThreadFollowerRepo(db);

  const eng = workspaces.insert({ name: fixedWorkspaceName('eng'), description: null });
  workspaces.addUserMember(eng.id, viewerUserId, 'owner');
  // `carol` is a workspace MEMBER with no channel seat; `bob` gets the mirror state
  // (a seat, no membership) below. Neither may be enumerated as a viewer.
  workspaces.addUserMember(eng.id, 'carol', 'member');

  const mk = (name: string) =>
    agents.create({ name, runtime: 'claude' }, localHostId, viewerUserId);
  const alpha = mk('p-alpha');
  const beta = mk('p-beta');
  const gamma = mk('p-gamma');
  const ghost = mk('p-ghost');
  const stray = mk('p-stray');
  for (const a of [alpha, beta, gamma, ghost, stray]) {
    workspaces.insertMembership(eng.id, a.id);
  }

  const channel = conversations.insertChannel({
    workspaceId: eng.id,
    title: fixedConversationTitle('general'),
  });
  conversations.addAgent(channel.id, alpha.id);
  conversations.addAgent(channel.id, beta.id);
  conversations.addUser(channel.id, viewerUserId);
  // The seat whose workspace membership is missing: a channel row that outlived a
  // workspace removal is exactly the state the v25 pair exists to reject.
  conversations.addUser(channel.id, 'bob');

  // Human ↔ agent: the canonical order puts `agent` in slot A, so this row
  // exercises `endpoint_a` for the agent kind and `endpoint_b` for the human one.
  const humanPair = conversations.getOrCreateDirectPair(
    { kind: 'human', id: viewerUserId },
    { kind: 'agent', id: alpha.id },
    NOW,
  ).conversation;
  // Agent ↔ agent: both slots are agents, so `endpoint_b`'s arm is the only thing
  // that can return the second one. Without this row, deleting the `endpoint_b`
  // arm from either reading would still pass every assertion below.
  const agentPair = conversations.getOrCreateDirectPair(
    { kind: 'agent', id: beta.id },
    { kind: 'agent', id: gamma.id },
    NOW,
  ).conversation;
  // Human ↔ human, for the same reason on the other kind: `'agent' < 'human'`, so
  // every agent↔human pair puts the human in slot B and the human `endpoint_a` arm
  // would be untested — deletable in silence. No product path creates this row
  // today; the arm exists because WHICH SLOT holds a human is a fact about the
  // canonicalizer, not about participation, so participation must not encode it.
  const humanHumanPair = conversations.getOrCreateDirectPair(
    { kind: 'human', id: viewerUserId },
    { kind: 'human', id: 'bob' },
    NOW,
  ).conversation;
  // A DM whose agent endpoint is DELETED afterwards: participation stays true,
  // liveness is what removes it from delivery.
  const ghostPair = conversations.getOrCreateDirectPair(
    { kind: 'human', id: viewerUserId },
    { kind: 'agent', id: ghost.id },
    NOW,
  ).conversation;
  // The same state on the human side. `trg_users_stamp_endpoint_deleted` (v73) is
  // the schema's own statement that a deleted human endpoint is an anticipated
  // state, not an invented one: the row survives its person, the survivor keeps
  // reading it, and the viewer enumeration must not offer a person who is gone.
  const ghostHumanPair = conversations.getOrCreateDirectPair(
    { kind: 'human', id: 'someone' },
    { kind: 'agent', id: beta.id },
    NOW,
  ).conversation;

  // Stray roster rows on the rosterless placement. They must be INERT: a
  // participation reading that answered from the roster alone would hand `stray`
  // someone else's DM. Written through the production
  // roster faces on purpose — `addAgent` / `addUser` are `INSERT OR IGNORE` with no
  // placement guard, so this state is REACHABLE and inertness has to be a
  // property of the read rather than of nobody ever writing the row.
  for (const conversationId of [
    humanPair.id,
    agentPair.id,
    humanHumanPair.id,
    ghostPair.id,
    ghostHumanPair.id,
  ]) {
    conversations.addAgent(conversationId, stray.id);
    conversations.addUser(conversationId, 'alice');
  }

  agents.delete(ghost.id);
  // No `UserRepo.delete` exists (no product path deletes a person yet), so the
  // state is reached the way the schema reaches it: the BEFORE DELETE trigger above
  // stamps the endpoint, and the `users` row is gone.
  db.prepare('DELETE FROM users WHERE id = ?').run('someone');

  return {
    db,
    conversations,
    agents,
    users,
    workspaces,
    messages,
    threadFollowers,
    localHostId,
    workspaceId: eng.id,
    conversationIds: {
      channel: channel.id,
      humanPair: humanPair.id,
      agentPair: agentPair.id,
      humanHumanPair: humanHumanPair.id,
      ghostPair: ghostPair.id,
      ghostHumanPair: ghostHumanPair.id,
    },
    agentIds: {
      alpha: alpha.id,
      beta: beta.id,
      gamma: gamma.id,
      ghost: ghost.id,
      stray: stray.id,
    },
    userIds: {
      viewer: viewerUserId,
      // seat, no workspace membership
      bob: 'bob',
      // workspace membership, no seat
      carol: 'carol',
      // stray seat on every rosterless placement
      alice: 'alice',
      // participates in a DM, but the person is gone
      someone: 'someone',
    },
  };
}

describe('#task:2021 P4-5 — the two readings of participation agree', () => {
  it('enumerates exactly the LIVE participants of every placement arm', () => {
    const m = buildMatrix();
    const ids = (key: string) => m.conversations.listParticipantAgentIds(m.conversationIds[key]!);
    const { alpha, beta, gamma, ghost, stray } = m.agentIds;

    // Workspace arm: the roster, and only the roster.
    expect(new Set(ids('channel'))).toEqual(new Set([alpha, beta]));
    // `direct_pair`: the endpoints. `stray` has a roster row on each of these
    // and appears in NONE of them — the inertness claim, as a value.
    expect(ids('humanPair')).toEqual([alpha!]);
    expect(new Set(ids('agentPair'))).toEqual(new Set([beta, gamma]));
    // The deleted endpoint: participation says yes, delivery says no.
    expect(m.conversations.isAgentParticipant(m.conversationIds.ghostPair!, ghost!)).toBe(true);
    expect(ids('ghostPair')).toEqual([]);
  });

  it('agrees with the predicate reading for every conversation × agent, differing only by liveness', () => {
    const m = buildMatrix();
    const disagreements: string[] = [];
    for (const [cName, conversationId] of Object.entries(m.conversationIds)) {
      const enumerated = new Set(m.conversations.listParticipantAgentIds(conversationId));
      for (const [aName, agentId] of Object.entries(m.agentIds)) {
        const predicate =
          m.conversations.isAgentParticipant(conversationId, agentId)
          && m.agents.get(agentId) !== null;
        if (enumerated.has(agentId) !== predicate) {
          disagreements.push(
            `${cName} × ${aName}: set=${enumerated.has(agentId)} predicate∧live=${predicate}`,
          );
        }
      }
    }
    // The whole equivalence in one assertion, and it is symmetric: an arm missing
    // from the SET reading shows up as `set=false predicate∧live=true`, an arm
    // missing from the PREDICATE reading as the reverse. Either direction is a
    // second authority that has started disagreeing with the first.
    expect(disagreements).toEqual([]);
    // …and not vacuous: the matrix contains both answers for both readings.
    const answers = Object.values(m.conversationIds).flatMap(conversationId =>
      Object.values(m.agentIds).map(agentId =>
        m.conversations.isAgentParticipant(conversationId, agentId),
      ),
    );
    expect(new Set(answers)).toEqual(new Set([true, false]));
  });

  it('orders recipients by the agent creation order, not by the arm that produced them', () => {
    const m = buildMatrix();
    const { beta, gamma } = m.agentIds;
    const setCreatedAt = (agentId: string, at: number) =>
      m.db.prepare('UPDATE agents SET created_at = ? WHERE id = ?').run(at, agentId);
    const pair = m.conversationIds.agentPair!;

    // The pre-existing recipient order (`created_at ASC, id ASC`) restated over the
    // new text, and asserted in BOTH directions on the same conversation: the two
    // agents are the `endpoint_a` / `endpoint_b` arms of one `direct_pair`, so a
    // query that had started returning the UNION's arm order — or the roster's, or
    // rowid order — would have to answer identically to both of these, and cannot.
    setCreatedAt(beta!, NOW);
    setCreatedAt(gamma!, NOW + 1000);
    expect(m.conversations.listParticipantAgentIds(pair)).toEqual([beta!, gamma!]);

    setCreatedAt(gamma!, NOW - 1000);
    expect(m.conversations.listParticipantAgentIds(pair)).toEqual([gamma!, beta!]);
  });
});

describe('#task:2035 — the two readings of HUMAN participation agree', () => {
  it('enumerates exactly the extant human participants of every placement arm', () => {
    const m = buildMatrix();
    const ids = (key: string) => m.conversations.listParticipantUserIds(m.conversationIds[key]!);
    const { viewer, bob, carol, alice, someone } = m.userIds;

    // Workspace arm: the v25 PAIR and nothing looser. `bob` holds a seat with no
    // workspace membership, `carol` holds membership with no seat — the enumeration
    // must reject both, or it would disagree with the predicate the request layer
    // has always applied.
    expect(ids('channel')).toEqual([viewer!]);
    expect(new Set(ids('channel'))).not.toContain(bob);
    expect(new Set(ids('channel'))).not.toContain(carol);
    // `direct_pair`: the endpoints. `alice` has a seat on each of these and appears
    // in NONE of them — the inertness claim, as a value, on the human kind.
    expect(ids('humanPair')).toEqual([viewer!]);
    expect(new Set(ids('agentPair'))).toEqual(new Set());
    // Both endpoint slots, and the WORKSPACE gating not leaking into this arm:
    // `bob` is not a workspace member of anything, and that is irrelevant to a DM
    // he is an endpoint of.
    expect(new Set(ids('humanHumanPair'))).toEqual(new Set([viewer, bob]));
    expect(ids('ghostPair')).toEqual([viewer!]);
    // The deleted person: participation says yes, the viewer enumeration says no.
    expect(m.conversations.isUserParticipant(m.conversationIds.ghostHumanPair!, someone!)).toBe(
      true,
    );
    expect(ids('ghostHumanPair')).toEqual([]);
  });

  it('agrees with the predicate reading for every conversation × user, differing only by existence', () => {
    const m = buildMatrix();
    const disagreements: string[] = [];
    for (const [cName, conversationId] of Object.entries(m.conversationIds)) {
      const enumerated = new Set(m.conversations.listParticipantUserIds(conversationId));
      for (const [uName, userId] of Object.entries(m.userIds)) {
        const predicate =
          m.conversations.isUserParticipant(conversationId, userId)
          && m.users.get(userId) !== null;
        if (enumerated.has(userId) !== predicate) {
          disagreements.push(
            `${cName} × ${uName}: set=${enumerated.has(userId)} predicate∧extant=${predicate}`,
          );
        }
      }
    }
    // Same equivalence as the agent readings, on the other kind and in the same
    // symmetric form: an arm missing from the SET reading shows up as `set=false`,
    // one missing from the PREDICATE as the reverse. The human pair's two conjuncts
    // are the interesting direction here — the set correlates workspace membership
    // on the seat it produced, and a copy that dropped it would appear right here.
    expect(disagreements).toEqual([]);
    // …and not vacuous: the matrix contains both answers.
    const answers = Object.values(m.conversationIds).flatMap(conversationId =>
      Object.values(m.userIds).map(userId =>
        m.conversations.isUserParticipant(conversationId, userId),
      ),
    );
    expect(new Set(answers)).toEqual(new Set([true, false]));
  });
});

describe('#task:2021 P4-5 query-plan contract — recipient enumeration', () => {
  const planOf = (db: Db, sql: string, binds: Record<string, unknown>): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(binds) as Array<{ detail: string }>)
      .map(r => r.detail)
      .join('\n');

  /**
   * The regression this whole slice exists to prevent, as plan signatures. A full
   * `SCAN` of `agents` means the candidate set is "every agent in the installation"
   * — the query the predicate reading forced, executed once per message — and no
   * values test can see it, because scanning returns the same rows.
   *
   * `\b` around the alias on purpose: the detail line is `SCAN a`, and a substring
   * check for `SCAN a` would also match `SCAN agent_runtime_slots`.
   */
  const FULL_SCAN_OF_CANDIDATES = /\bSCAN (a|agents)\b/;

  /** Liveness as a PRIMARY-KEY probe of the candidate. `COVERING` is optional
   *  because it depends only on which columns the enclosing query projects — the
   *  claim is the access path, not the projection. */
  const AGENTS_PK_PROBE = /SEARCH a USING (COVERING )?INDEX sqlite_autoindex_agents_1 \(id=\?\)/;

  /** Enough agents that a scan is unambiguously the wrong shape, and enough
   *  conversations that the roster prefix seek has something to skip.
   *
   *  Populated on BOTH principal kinds, because a one-row table makes every access
   *  path look equally good: measured on `buildMatrix` alone, the human reading
   *  reports `SCAN wu_p EXISTS` and `SCAN c_p` — not because the indexes are
   *  missing, but because ANALYZE says a scan of one row is cheapest. Pinning that
   *  would pin an artifact and (worse) would accept the real regression at scale.
   *
   *  `conversations` is populated on the SAME dimension the transpose reads — one
   *  agent↔human pair per bulk principal, the shape every product DM has, so the
   *  viewer's own pairs are a small fraction of the partial indexes rather than
   *  most of the table. Without this the matrix's five pairs in a six-row table
   *  make a scan genuinely cheapest, and the plan claim would flip on any fixture
   *  edit that added or removed one conversation. */
  function buildScaleFixture(): Matrix {
    const m = buildMatrix();
    for (let i = 0; i < 300; i += 1) {
      const bulkAgent = m.agents.create(
        { name: `bulk-${i}`, runtime: 'claude' },
        m.localHostId,
        'local',
      );
      // Each bulk person is a workspace MEMBER with a channel SEAT, so both halves
      // of the v25 pair have a populated table to seek in and the channel roster is
      // wide enough that enumerating it by scan would be visibly wrong.
      m.users.create({
        id: `bulk-${i}`,
        name: `bulk-${i}-test`,
        displayName: `Bulk ${i}`,
      });
      m.workspaces.addUserMember(m.workspaceId, `bulk-${i}`, 'member');
      m.conversations.addUser(m.conversationIds.channel!, `bulk-${i}`);
      // Somebody else's DM: it belongs to neither slot of the viewer's arms, which
      // is what makes both of the viewer's seeks selective.
      m.conversations.getOrCreateDirectPair(
        { kind: 'agent', id: bulkAgent.id },
        { kind: 'human', id: `bulk-${i}` },
        NOW,
      );
    }
    m.db.prepare('ANALYZE').run();
    return m;
  }

  it('reaches the recipient set through the placement, never through a scan of agents', () => {
    const m = buildScaleFixture();
    for (const [name, conversationId] of Object.entries(m.conversationIds)) {
      const plan = planOf(m.db, LIVE_PARTICIPANT_AGENT_IDS_SQL, { conv: conversationId });
      // The candidate set is produced by the placement …
      expect(plan, `${name}: candidates must come from the placement`).toMatch(
        /SEARCH c_p USING (INTEGER )?PRIMARY KEY|SEARCH c_p USING INDEX sqlite_autoindex_conversations/,
      );
      // … the roster arm is a PREFIX SEEK of `PRIMARY KEY (conversation_id,
      // agent_id)`, not a scan of every edge in the installation …
      expect(plan, `${name}: the roster arm must seek by conversation`).toContain(
        'ca_p USING COVERING INDEX sqlite_autoindex_conversation_agents_1 (conversation_id=?)',
      );
      // … and liveness is a primary-key PROBE of the candidate, which is the whole
      // difference between this shape and the one it replaced.
      expect(plan, `${name}: liveness must be a probe, not a scan`).toContain(
        'SEARCH a USING INDEX sqlite_autoindex_agents_1 (id=?)',
      );
      expect(plan, `${name}: recipient enumeration regressed to a candidate scan`).not.toMatch(
        FULL_SCAN_OF_CANDIDATES,
      );
    }
  });

  /**
   * The OTHER reading, kept honest. `listFollowerAgentIdsParticipating` still uses
   * the correlated predicate, and that is correct precisely because its candidate
   * set is bounded by `thread_followers` — the predicate FILTERS rows already in
   * hand. This is that claim as a plan: drive from the follower table, probe
   * `agents` by primary key, never scan.
   */
  it('the follower reading filters a bounded set rather than enumerating', () => {
    const m = buildScaleFixture();
    const root = m.messages.insertForConversation({
      conversationId: m.conversationIds.channel!,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });
    m.threadFollowers.upsert({
      threadRootId: root.id,
      conversationId: m.conversationIds.channel!,
      principalKind: 'agent',
      principalId: m.agentIds.alpha!,
      source: 'reply',
    });
    expect(m.threadFollowers.listFollowerAgentIdsParticipating(root.id)).toEqual([
      m.agentIds.alpha!,
    ]);

    const plan = planOf(m.db, FOLLOWER_AGENT_IDS_PARTICIPATING_SQL, { root: root.id });
    expect(plan).toContain('SEARCH tf USING');
    expect(plan).toMatch(AGENTS_PK_PROBE);
    expect(plan).not.toMatch(FULL_SCAN_OF_CANDIDATES);
  });

  /**
   * The same contract on the human reading (#task:2035). Its cost profile is the
   * one that actually runs per delivered message: `conversationViewerUserIds` is
   * called on every commit that fans out, so a scan here is a scan per message.
   *
   * Two access paths are load-bearing and neither is visible to a values test:
   *
   *   - the workspace arm must SEEK the seat table by conversation, and its
   *     membership conjunct must be a CORRELATED probe of `(workspace_id, user_id)`
   *     — the primary key of `workspace_users`. A copy that hoisted the membership
   *     check out of the correlation would still return the right people while
   *     scanning every membership in the installation once per seat;
   *   - existence must be a primary-key probe of `users`, never a scan of it. This
   *     is the human twin of the agent-liveness claim, and `\bSCAN (u|users)\b` is
   *     precisely the regression `listUsers` would have reintroduced.
   */
  const FULL_SCAN_OF_USERS = /\bSCAN (u|users)\b/;

  it('reaches the viewer set through the placement, never through a scan of users or memberships', () => {
    const m = buildScaleFixture();
    for (const [name, conversationId] of Object.entries(m.conversationIds)) {
      const plan = planOf(m.db, LIVE_PARTICIPANT_USER_IDS_SQL, { conv: conversationId });
      // Candidates come from the placement, by primary key …
      expect(plan, `${name}: candidates must come from the placement`).toMatch(
        /SEARCH c_p USING (INTEGER )?PRIMARY KEY|SEARCH c_p USING INDEX sqlite_autoindex_conversations/,
      );
      // … the seat arm is a PREFIX SEEK of `PRIMARY KEY (conversation_id, user_id)` …
      expect(plan, `${name}: the seat arm must seek by conversation`).toContain(
        'cu_p USING COVERING INDEX sqlite_autoindex_conversation_users_1 (conversation_id=?)',
      );
      // … the v25 membership conjunct is a two-column probe, correlated on the
      // candidate the seat produced (both `=?` are the claim: one column bound
      // would mean the other is being scanned) …
      expect(plan, `${name}: membership must be a correlated PK probe`).toContain(
        'wu_p EXISTS USING COVERING INDEX sqlite_autoindex_workspace_users_1 (workspace_id=? AND user_id=?)',
      );
      // … and existence is a probe of `users`, not a walk of it.
      expect(plan, `${name}: existence must be a probe, not a scan`).toContain(
        'SEARCH u USING INDEX sqlite_autoindex_users_1 (id=?)',
      );
      expect(plan, `${name}: viewer enumeration regressed to a scan of people`).not.toMatch(
        FULL_SCAN_OF_USERS,
      );
    }
  });

  /**
   * The TRANSPOSE (#task:2035): fix the principal, produce the conversations —
   * the viewer's Direct Messages list. Its cost profile is per LIST LOAD rather
   * than per message, and the regression it can hide is worse than a slow query:
   * a scan of `conversations` answers correctly on any fixture, so nothing but a
   * plan can tell "seek my pairs" from "walk every conversation in the
   * installation and keep mine".
   *
   * BOTH arms must seek, and that is the claim v80 exists for. The canonical
   * endpoint order sorts by kind before id and `'agent' < 'human'`, so in every
   * agent↔human pair the person is `endpoint_b` — the one slot the v74 endpoints
   * index cannot lead with. Measuring only the A arm would therefore pass while
   * the arm that answers every real DM scanned:
   *
   *   - the B arm seeks `idx_conversations_direct_pair_endpoint_b` (v80), and the
   *     fixture's agent↔human pairs put the viewer exactly there;
   *   - the A arm is the CONTROL, and it must still ride the pre-existing
   *     `idx_conversations_direct_pair_endpoints` — v80 must not have become the
   *     answer to both questions (`humanHumanPair` gives the viewer an A-slot row
   *     whenever their id sorts first, and the arm is planned regardless);
   *   - the outer join is a primary-key probe of the rows those arms named.
   *
   * `@viewer` is bound once for both arms, so a single plan covers them.
   */
  it('the direct-pair transpose seeks both endpoint slots and never scans conversations', () => {
    const m = buildScaleFixture();
    // Not vacuous: the viewer really does hold pairs, and at least one of them
    // puts them in slot B (the agent↔human shape every product DM has).
    const rows = m.conversations.listDirectPairsForViewer(m.userIds.viewer!);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.some(
        row =>
          row.endpoint_b_kind === 'human' && row.endpoint_b_id === m.userIds.viewer,
      ),
    ).toBe(true);

    const plan = planOf(m.db, DIRECT_PAIRS_FOR_VIEWER_SQL, {
      viewer: m.userIds.viewer!,
    });
    expect(plan, 'the slot-B arm must seek the v80 index').toContain(
      'USING INDEX idx_conversations_direct_pair_endpoint_b',
    );
    expect(plan, 'the slot-A arm must still seek the v74 endpoints index').toContain(
      'USING INDEX idx_conversations_direct_pair_endpoints',
    );
    expect(plan, 'the outer join must probe by primary key').toMatch(
      /SEARCH c USING (INTEGER )?PRIMARY KEY|SEARCH c USING INDEX sqlite_autoindex_conversations/,
    );
    expect(plan, 'the DM list regressed to a walk of every conversation').not.toMatch(
      /\bSCAN (c|c_p|conversations)\b/,
    );
  });
});
