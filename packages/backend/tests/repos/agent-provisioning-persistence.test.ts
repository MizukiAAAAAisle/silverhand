/**
 * AgentProvisioningUnitOfWork adapter tests (#task:1990).
 *
 * Proves the SQLite adapter's ATOMICITY contract with real file-backed
 * statements: a mid-transaction failure (after `flipToActive`) must roll back
 * EVERY dependent row — agent-home workspace, onboarding DM + edges, owner
 * membership/pointer, onboarding message — and leave the agent row exactly as
 * it was (still `pending_materialization`, so the caller's L3b compensation
 * decides its fate, not a half-committed graph).
 *
 * Failure is injected through the transaction SCOPE (the only persistence seam
 * the application has): `uowWithScopeWrap` + `overrideScope` swap
 * `conversations.insertDmChannel` for a throw AFTER `flipToActive` and
 * `insertAgentHome` have run, so the rollback covers the writes that came
 * before the fault as well as the fault itself.
 *
 * The application-level state machine (catch → L3b marks the agent failed) is
 * proved separately in `tests/application/create-agent-provisioning.test.ts`;
 * an adapter test alone cannot show that.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixedConversationTitle, systemSubtype } from '@silverhand/shared';
import type { AgentProvisioningTxScope } from '../../src/application/agent-provisioning-ports.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { createSqliteAgentProvisioningPersistence } from '../../src/repos/agent-provisioning-persistence.js';
import { openTestDb } from '../utils/db.js';
import { overrideScope, uowWithScopeWrap } from '../utils/tx-fault.js';

function freshKey(): string {
  return `k-${randomBytes(8).toString('base64url')}`;
}

/** The exact write sequence `insertProvisioningDependents` runs, expressed
 *  through the transaction scope. */
function runProvisioningSequence(
  uow: ReturnType<typeof createSqliteAgentProvisioningPersistence>['uow'],
  args: { agentId: string; agentName: string; creatorUserId: string },
) {
  return uow.atomically((tx: AgentProvisioningTxScope) => {
    const outcome = tx.agents.flipToActiveAndGet(args.agentId);
    if (outcome.status === 'lost') throw new Error('eligibility lost');
    const flipped = outcome.row;
    const home = tx.workspaces.insertAgentHome({ agent: flipped });
    const dm = tx.conversations.insertDmChannel({
      workspaceId: home.id,
      title: fixedConversationTitle('Onboarding'),
      agentId: args.agentId,
    });
    tx.conversations.addAgent(dm.id, args.agentId);
    tx.workspaces.addOwnerMember(home.id, args.creatorUserId);
    tx.workspaces.setOwnerUserId(home.id, args.creatorUserId);
    tx.conversations.addUser(dm.id, args.creatorUserId);
    const onboardingMsg = tx.messages.insertForConversation({
      conversationId: dm.id,
      fromKind: 'system',
      content: `hi ${args.agentName}`,
      metadata: { subtype: systemSubtype('onboarding') },
    });
    return { home, dm, onboardingMsg };
  });
}

function bootstrap() {
  const { db, localHostId } = openTestDb({ seedAllFixtureMemberships: false });
  const agents = new AgentRepo(db);
  const hosts = new HostRepo(db);
  hosts.claimOrCreateLocal({ userId: 'local', installationId: 'uow-install' });
  const persistence = createSqliteAgentProvisioningPersistence(db);
  // Through the named reserve face, which is the only way production reserves.
  // Since #task:2072 that is ONE INSERT — the row and nothing beside it — so the
  // dependent-row counts below start from a genuinely bare agent.
  const row = persistence.reserveAgentRow({
    input: { name: 'uow-agent', runtime: 'claude' },
    defaultHostId: localHostId,
    createdByUserId: 'local',
    idempotencyKey: freshKey(),
  });
  return {
    db,
    agents,
    localHostId,
    persistence,
    agentId: row.id,
    agentName: row.name,
    uow: persistence.uow,
  };
}

function dependentRowCounts(t: ReturnType<typeof bootstrap>, agentId: string) {
  const workspaces = t.db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM workspaces WHERE owner_agent_id = ?`,
    )
    .get(agentId)!.c;
  const conversations = t.db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM conversations c
        JOIN conversation_agents ca ON ca.conversation_id = c.id
       WHERE ca.agent_id = ?`,
    )
    .get(agentId)!.c;
  const workspaceMemberships = t.db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM workspace_users wu
        JOIN workspaces w ON w.id = wu.workspace_id
       WHERE w.owner_agent_id = ?`,
    )
    .get(agentId)!.c;
  const conversationMemberships = t.db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM conversation_users cu
        JOIN conversations c ON c.id = cu.conversation_id
        JOIN conversation_agents ca ON ca.conversation_id = c.id
       WHERE ca.agent_id = ?`,
    )
    .get(agentId)!.c;
  const messages = t.db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN conversation_agents ca ON ca.conversation_id = c.id
       WHERE ca.agent_id = ?`,
    )
    .get(agentId)!.c;
  return { workspaces, conversations, workspaceMemberships, conversationMemberships, messages };
}

function agentStatus(t: ReturnType<typeof bootstrap>, agentId: string) {
  return t.db
    .prepare<[string], { materialization_status: string }>(
      `SELECT materialization_status FROM agents WHERE id = ?`,
    )
    .get(agentId)!;
}

describe('AgentProvisioningUnitOfWork (SQLite adapter)', () => {
  it('commits the whole dependent graph and flips the agent to active', () => {
    const t = bootstrap();
    const created = runProvisioningSequence(t.uow, {
      agentId: t.agentId,
      agentName: t.agentName,
      creatorUserId: 'local',
    });
    expect(created.home.id).toBeTruthy();
    expect(created.dm.id).toBeTruthy();
    expect(created.onboardingMsg.id).toBeTruthy();
    expect(agentStatus(t, t.agentId).materialization_status).toBe('active');
    const counts = dependentRowCounts(t, t.agentId);
    expect(counts.workspaces).toBe(1);
    expect(counts.conversations).toBe(1);
    expect(counts.workspaceMemberships).toBe(1);
    expect(counts.conversationMemberships).toBe(1);
    expect(counts.messages).toBe(1);
  });

  it('rolls back every dependent row when a mid-transaction write fails (insertDmChannel throws after flipToActive + insertAgentHome)', () => {
    const t = bootstrap();
    // Swap ONLY the conversation face's DM insert for a throw. The agent and
    // workspace faces stay REAL, so flipToActive + insertAgentHome really run
    // before the fault — the rollback must undo them too.
    const wrapped = uowWithScopeWrap(t.uow, () => tx =>
      overrideScope(tx, {
        conversations: overrideScope(tx.conversations, {
          insertDmChannel: () => {
            throw new Error('forced mid-transaction failure');
          },
        }),
      }),
    );
    expect(() =>
      runProvisioningSequence(wrapped, {
        agentId: t.agentId,
        agentName: t.agentName,
        creatorUserId: 'local',
      }),
    ).toThrow('forced mid-transaction failure');
    // The agent row is untouched by the rolled-back tx: still pending, so the
    // caller's separate L3b compensation is what decides its fate.
    expect(agentStatus(t, t.agentId).materialization_status).toBe(
      'pending_materialization',
    );
    expect(dependentRowCounts(t, t.agentId)).toEqual({
      workspaces: 0,
      conversations: 0,
      workspaceMemberships: 0,
      conversationMemberships: 0,
      messages: 0,
    });
  });

  it('rolls back when the LAST write fails (onboarding message insert)', () => {
    const t = bootstrap();
    const wrapped = uowWithScopeWrap(t.uow, () => tx =>
      overrideScope(tx, {
        messages: overrideScope(tx.messages, {
          insertForConversation: () => {
            throw new Error('forced last-write failure');
          },
        }),
      }),
    );
    expect(() =>
      runProvisioningSequence(wrapped, {
        agentId: t.agentId,
        agentName: t.agentName,
        creatorUserId: 'local',
      }),
    ).toThrow('forced last-write failure');
    expect(agentStatus(t, t.agentId).materialization_status).toBe(
      'pending_materialization',
    );
    expect(dependentRowCounts(t, t.agentId)).toEqual({
      workspaces: 0,
      conversations: 0,
      workspaceMemberships: 0,
      conversationMemberships: 0,
      messages: 0,
    });
  });

  it('P1 falsifier: a row that lost eligibility (failed in the L2→L3a window) gets NO dependent graph', () => {
    const t = bootstrap();
    // Simulate the race: something flips the reserved row to `failed` after L2
    // dispatch decided to materialize but before the L3a transaction begins.
    t.agents.flipToFailed(t.agentId, 'host_attach_pending', Date.now());
    // The conditional transition inside the scope must fail closed — a failed
    // row must never be able to carry a home/DM/membership/message graph.
    expect(() =>
      runProvisioningSequence(t.uow, {
        agentId: t.agentId,
        agentName: t.agentName,
        creatorUserId: 'local',
      }),
    ).toThrow('eligibility lost');
    // Row stays failed, graph stays empty.
    expect(agentStatus(t, t.agentId).materialization_status).toBe('failed');
    expect(dependentRowCounts(t, t.agentId)).toEqual({
      workspaces: 0,
      conversations: 0,
      workspaceMemberships: 0,
      conversationMemberships: 0,
      messages: 0,
    });
  });

  it('P1 active arm: a row that is ALREADY active is not eligible — a second provisioning run must not build a second graph', () => {
    const t = bootstrap();
    // First run succeeds: builds the full graph and flips the row active.
    runProvisioningSequence(t.uow, {
      agentId: t.agentId,
      agentName: t.agentName,
      creatorUserId: 'local',
    });
    expect(agentStatus(t, t.agentId).materialization_status).toBe('active');
    expect(dependentRowCounts(t, t.agentId).workspaces).toBe(1);

    // Second run on the SAME row: pending-only transition must report lost
    // (active is not a legal pre-state — a second DM/message graph must not
    // exist), and must not build a second graph.
    expect(() =>
      runProvisioningSequence(t.uow, {
        agentId: t.agentId,
        agentName: t.agentName,
        creatorUserId: 'local',
      }),
    ).toThrow('eligibility lost');
    expect(agentStatus(t, t.agentId).materialization_status).toBe('active');
    expect(dependentRowCounts(t, t.agentId)).toEqual({
      workspaces: 1,
      conversations: 1,
      workspaceMemberships: 1,
      conversationMemberships: 1,
      messages: 1,
    });
  });

  it('P2-1: the owner membership is written with role=owner, not the caller-provided role', () => {
    const t = bootstrap();
    const created = runProvisioningSequence(t.uow, {
      agentId: t.agentId,
      agentName: t.agentName,
      creatorUserId: 'local',
    });
    const role = t.db
      .prepare<[string, string], { role: string }>(
        `SELECT role FROM workspace_users
          WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(created.home.id, 'local')!;
    expect(role.role).toBe('owner');
  });
});

/**
 * The L1 reserve — #task:2014's AGGREGATE FACTORY, reduced to one INSERT by
 * #task:2072. The three properties the aggregate owed are not relaxed here, they
 * are gone with the thing they were about: a row was never allowed to exist
 * without an `agent_inbox` because a mention of the handle needed a destination
 * the agent possessed, and the destination is now a function of the SENDER (the
 * author's direct line, minted at the send boundary). So what is left to prove is
 * the reduction itself, in the only form that stays true when the placement is
 * dropped: the reserve writes the `agents` row and NOTHING beside it.
 */
describe('reserveAgentRow (SQLite adapter)', () => {
  const conversationCount = (t: ReturnType<typeof bootstrap>): number =>
    t.db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM conversations`).get()!.c;

  it('writes the row in `pending_materialization` and creates no conversation', () => {
    // Counted as a DELTA over the whole table rather than as "no row with this
    // agent's placement": the claim is that nothing is written beside the row, and
    // a per-carrier assertion would have to name the carriers — the same list that
    // would silently shrink under it when one of them is retired.
    const t = bootstrap();
    const before = conversationCount(t);
    const row = t.persistence.reserveAgentRow({
      input: { name: 'uow-agent-bare', runtime: 'claude' },
      defaultHostId: t.localHostId,
      createdByUserId: 'local',
      idempotencyKey: freshKey(),
    });
    expect(t.agents.getRow(row.id)!.materialization_status).toBe(
      'pending_materialization',
    );
    expect(conversationCount(t)).toBe(before);
  });

  it('needs no transaction to be safe: a failing INSERT leaves no row behind', () => {
    // The aggregate's atomicity test faulted the inbox insert to prove the pair was
    // wrapped. With one statement there is no pair to half-commit, and the property
    // that replaces it is the statement's own: a rejected reserve adds nothing.
    const t = bootstrap();
    const before = conversationCount(t);
    t.db.exec(
      `CREATE TRIGGER t2072_fail_agent_insert
         BEFORE INSERT ON agents
         WHEN NEW.name = 'uow-agent-atomic'
       BEGIN
         SELECT RAISE(ABORT, 'forced agents insert failure');
       END`,
    );
    try {
      expect(() =>
        t.persistence.reserveAgentRow({
          input: { name: 'uow-agent-atomic', runtime: 'claude' },
          defaultHostId: t.localHostId,
          createdByUserId: 'local',
          idempotencyKey: freshKey(),
        }),
      ).toThrow(/forced agents insert failure/);
    } finally {
      t.db.exec('DROP TRIGGER t2072_fail_agent_insert');
    }
    expect(
      t.db
        .prepare<[], { c: number }>(
          `SELECT COUNT(*) AS c FROM agents WHERE name = 'uow-agent-atomic'`,
        )
        .get()!.c,
    ).toBe(0);
    expect(conversationCount(t)).toBe(before);
  });
});
