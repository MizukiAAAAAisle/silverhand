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
import { fixedConversationTitle } from '@silverhand/shared';
import type { Database as Db } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import {
  ConversationRepo,
  LIVE_PARTICIPANT_AGENT_IDS_SQL,
} from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import {
  FOLLOWER_AGENT_IDS_PARTICIPATING_SQL,
  ThreadFollowerRepo,
} from '../../src/repos/thread-follower-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

const NOW = 1_700_000_000_000;

interface Matrix {
  db: Db;
  conversations: ConversationRepo;
  agents: AgentRepo;
  messages: MessageRepo;
  threadFollowers: ThreadFollowerRepo;
  localHostId: string;
  /** Every conversation in the fixture, one per placement arm. */
  conversationIds: Record<string, string>;
  /** Every agent id the matrix crosses, INCLUDING the deleted one. */
  agentIds: Record<string, string>;
}

/**
 * One conversation per placement arm, plus the two states that make the arms
 * distinguishable: a STRAY roster row on the rosterless placements (it must be
 * inert — the roster is authoritative for the workspace arm only) and a DELETED
 * agent that still participates (the `direct_pair` arms ignore
 * `endpoint_*_deleted_at` on purpose, so liveness is the only thing that can
 * exclude it).
 *
 * `seedAllFixtureMemberships: false`: the fixture trigger would seed roster rows
 * everywhere, which is the one thing that would make a stray row look normal.
 */
function buildMatrix(): Matrix {
  const { db, localHostId, viewerUserId } = openTestDb({
    seedAllFixtureMemberships: false,
  });
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);
  const messages = new MessageRepo(db);
  const threadFollowers = new ThreadFollowerRepo(db);

  const eng = workspaces.insert({ name: 'eng', description: null });
  workspaces.addUserMember(eng.id, viewerUserId, 'owner');

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

  // Human ↔ agent: the canonical order puts `agent` in slot A, so this row
  // exercises `endpoint_a`.
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
  // A DM whose agent endpoint is DELETED afterwards: participation stays true,
  // liveness is what removes it from delivery.
  const ghostPair = conversations.getOrCreateDirectPair(
    { kind: 'human', id: viewerUserId },
    { kind: 'agent', id: ghost.id },
    NOW,
  ).conversation;

  const inbox = conversations.insertAgentInbox(gamma.id, gamma.created_at);

  // Stray roster rows on the rosterless placements. They must be INERT: a
  // participation reading that answered from the roster alone would hand `stray`
  // someone else's DM and someone else's inbox. Written through the production
  // roster face on purpose — `addAgent` is an `INSERT OR IGNORE` with no
  // placement guard, so this state is REACHABLE and inertness has to be a
  // property of the read rather than of nobody ever writing the row.
  for (const conversationId of [humanPair.id, agentPair.id, ghostPair.id, inbox.id]) {
    conversations.addAgent(conversationId, stray.id);
  }

  agents.delete(ghost.id);

  return {
    db,
    conversations,
    agents,
    messages,
    threadFollowers,
    localHostId,
    conversationIds: {
      channel: channel.id,
      humanPair: humanPair.id,
      agentPair: agentPair.id,
      ghostPair: ghostPair.id,
      inbox: inbox.id,
    },
    agentIds: {
      alpha: alpha.id,
      beta: beta.id,
      gamma: gamma.id,
      ghost: ghost.id,
      stray: stray.id,
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
    // `agent_inbox`: its owner, who is not on its roster and never will be.
    expect(ids('inbox')).toEqual([gamma!]);
    expect(new Set(ids('inbox'))).not.toContain(stray);
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
   *  conversations that the roster prefix seek has something to skip. */
  function buildScaleFixture(): Matrix {
    const m = buildMatrix();
    for (let i = 0; i < 300; i += 1) {
      m.agents.create({ name: `bulk-${i}`, runtime: 'claude' }, m.localHostId, 'local');
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
});
