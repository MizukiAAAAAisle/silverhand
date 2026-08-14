/**
 * Application-level provisioning failure test (#task:1990, Cindy review round 1).
 *
 * The adapter test (`tests/repos/agent-provisioning-persistence.test.ts`) proves
 * the SQLite scope rolls back; THIS file proves the state machine keeps
 * running around it. The SAME mid-transaction failure (a throw from
 * `conversations.insertDmChannel`, after `flipToActive` + `insertAgentHome`)
 * is injected through the production `createAgent` flow; the use case must
 * catch it, run the SEPARATE L3b compensation (`flipToFailed`), and return
 * `materializeFailed` — with zero half-committed dependent rows.
 *
 * Everything except the wrapped provisioning scope is REAL production code:
 * real repos, real placement resolver, real `createSqliteAgentProvisioningPersistence`,
 * a fake host controller that auto-acks `agent_materialize` (the only way to
 * reach L3a without a daemon), and a fake runtime host for the post-commit
 * effects (which must NOT fire on the failure path).
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { systemSubtype } from '@silverhand/shared';
import type {
  OutboundServerCommandParams,
} from '@silverhand/host';
import type { Database as Db } from 'better-sqlite3';
import { createAgent, type CreateAgentDeps } from '../../src/application/create-agent.js';
import { createSqliteAgentProvisioningPersistence } from '../../src/repos/agent-provisioning-persistence.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { RuntimeHostPlacementResolver } from '../../src/runtime/host-placement.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import {
  FakeConversationManager,
  FakeHostWsServerController,
} from '../utils/app.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import { overrideScope, uowWithScopeWrap } from '../utils/tx-fault.js';
import type { AgentProvisioningTxScope } from '../../src/application/agent-provisioning-ports.js';

function freshKey(): string {
  return `k-${randomBytes(8).toString('base64url')}`;
}

/** Temp-dir + DB teardown registry, so every fixture is cleaned up (the tmp-dir
 *  helper itself requires afterEach/afterAll). */
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function buildDeps() {
  const { db } = openTestDb({ seedAllFixtureMemberships: false });
  const tmp = makeTempSilverhandDir();
  cleanups.push(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    tmp.cleanup();
  });
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const users = new UserRepo(db);
  const hosts = new HostRepo(db);
  hosts.claimOrCreateLocal({ userId: 'local', installationId: 'app-install' });
  const fakeHostWs = new FakeHostWsServerController(tmp.silverhandDir);
  const runtimeHost = new FakeConversationManager();
  const events = new ScopeEventBus();
  const agentProvisioning = createSqliteAgentProvisioningPersistence(db);
  const deps: CreateAgentDeps = {
    logger: { info() {}, warn() {}, error() {} },
    events,
    runtimeHost,
    outboundFrameAdapter: () => fakeHostWs,
    placement: new RuntimeHostPlacementResolver({ hosts, agents, workspaces }),
    agents,
    workspaces,
    conversations,
    messages,
    users,
    agentProvisioning,
  };
  return { deps, db, fakeHostWs, runtimeHost, agentProvisioning, agents };
}

describe('createAgent provisioning failure (application integration)', () => {
  it('mid-transaction failure → catch → L3b marks the agent failed, zero dependent rows, no post-commit effects', async () => {
    const { db, deps, runtimeHost, fakeHostWs } = buildDeps();
    // Wrap the production provisioning scope: the SAME fault as the adapter
    // test — conversations.insertDmChannel throws after flipToActive + home.
    // Only the DEPENDENT-GRAPH uow is faulted; `reserveAgentAggregate` stays
    // real, because the L1 aggregate (row + inbox) must already have committed
    // before this failure — that is what the assertions below read.
    deps.agentProvisioning = {
      ...deps.agentProvisioning,
      uow: uowWithScopeWrap(deps.agentProvisioning.uow, () => tx =>
        overrideScope(tx, {
          conversations: overrideScope(tx.conversations, {
            insertDmChannel: () => {
              throw new Error('forced application-level provisioning failure');
            },
          }),
        }),
      ) as unknown as ReturnType<typeof createSqliteAgentProvisioningPersistence>['uow'],
    };

    const result = await createAgent(deps, {
      input: { name: 'app-provision-fail', runtime: 'claude' },
      idempotencyKey: freshKey(),
      retry: false,
      creatorUserId: 'local',
    });

    // The use case catches the L3a failure and reports the typed code.
    expect(result.kind).toBe('materializeFailed');
    if (result.kind === 'materializeFailed') {
      expect(result.failedCode).toBe('dependent_row_insert_failed');
    }

    // L3b ran in a SEPARATE tx: the row is failed with the typed code.
    const row = db
      .prepare<
        [],
        { materialization_status: string; materialization_failed_code: string | null }
      >(
        `SELECT materialization_status, materialization_failed_code
           FROM agents WHERE name = 'app-provision-fail'`,
      )
      .get()!;
    expect(row.materialization_status).toBe('failed');
    expect(row.materialization_failed_code).toBe('dependent_row_insert_failed');

    // The rolled-back tx left no dependent rows behind.
    const agentId = db
      .prepare<[], { id: string }>(
        `SELECT id FROM agents WHERE name = 'app-provision-fail'`,
      )
      .get()!.id;
    const workspaces = db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspaces WHERE owner_agent_id = ?`,
      )
      .get(agentId)!.c;
    const conversations = db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM conversations c
          JOIN conversation_agents ca ON ca.conversation_id = c.id
         WHERE ca.agent_id = ?`,
      )
      .get(agentId)!.c;
    expect(workspaces).toBe(0);
    expect(conversations).toBe(0);

    // No post-commit effects fire on the failure path.
    expect(runtimeHost.delivered).toHaveLength(0);
    expect(runtimeHost.starts).toHaveLength(0);
    expect(fakeHostWs.calls.some(c => c.kind === 'agent_materialize')).toBe(true);
  });

  it('P1 real interleave (failed winner): eligibility lost to a named failed code is NOT compensated — the winner code is preserved, no graph, no effects', async () => {
    const { db, deps, runtimeHost, fakeHostWs } = buildDeps();
    // Real interleave: while the daemon ack is being awaited (between L2 and
    // L3a), a concurrent writer flips the row to `failed` under ITS OWN code.
    const fake = fakeHostWs!;
    const origSend = fake.sendCommand.bind(fake);
    fake.sendCommand = async (hostId, kind, params) => {
      if (kind === 'agent_materialize') {
        const p = params as OutboundServerCommandParams<'agent_materialize'>;
        new AgentRepo(db).flipToFailed(
          p.agent_id,
          'fs_quota_exceeded',
          Date.now(),
        );
      }
      return origSend(hostId, kind, params);
    };

    const result = await createAgent(deps, {
      input: { name: 'app-provision-failed-winner', runtime: 'claude' },
      idempotencyKey: freshKey(),
      retry: false,
      creatorUserId: 'local',
    });

    // NOT materializeFailed/dependent_row_insert_failed: the loser must not
    // overwrite the winner's stamp. The winner's code surfaces instead.
    expect(result.kind).toBe('previouslyFailed');
    if (result.kind === 'previouslyFailed') {
      expect(result.failedCode).toBe('fs_quota_exceeded');
    }

    // Row keeps the winner's authoritative code — untouched by compensation.
    const agentId = db
      .prepare<[], { id: string }>(
        `SELECT id FROM agents WHERE name = 'app-provision-failed-winner'`,
      )
      .get()!.id;
    const row = db
      .prepare<
        [string],
        { materialization_status: string; materialization_failed_code: string | null }
      >(`SELECT materialization_status, materialization_failed_code FROM agents WHERE id = ?`)
      .get(agentId)!;
    expect(row.materialization_status).toBe('failed');
    expect(row.materialization_failed_code).toBe('fs_quota_exceeded');

    // Zero graph, zero effects.
    const workspaces = db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspaces WHERE owner_agent_id = ?`,
      )
      .get(agentId)!.c;
    const conversations = db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM conversations c
          JOIN conversation_agents ca ON ca.conversation_id = c.id
         WHERE ca.agent_id = ?`,
      )
      .get(agentId)!.c;
    expect(workspaces).toBe(0);
    expect(conversations).toBe(0);
    expect(runtimeHost.delivered).toHaveLength(0);
    expect(runtimeHost.starts).toHaveLength(0);
  });

  it('P1 real interleave (active winner): eligibility lost to a completed graph echoes the winner, never builds a second graph or effects', async () => {
    const { db, deps, runtimeHost, fakeHostWs } = buildDeps();
    const fake = fakeHostWs!;
    const origSend = fake.sendCommand.bind(fake);
    fake.sendCommand = async (hostId, kind, params) => {
      if (kind === 'agent_materialize') {
        // Real interleave: a concurrent writer completes the WHOLE graph (flip
        // + home + DM + edges + onboarding) before our L3a runs.
        const provisioning = createSqliteAgentProvisioningPersistence(db);
        const p = params as OutboundServerCommandParams<'agent_materialize'>;
        const agentId = p.agent_id;
        provisioning.uow.atomically(tx => {
          const outcome = tx.agents.flipToActiveAndGet(agentId);
          if (outcome.status !== 'transitioned') throw new Error('setup lost');
          const home = tx.workspaces.insertAgentHome({ agent: outcome.row });
          const dm = tx.conversations.insertDmChannel({
            name: 'ch-1',
            workspaceId: home.id,
            title: 'Onboarding',
            agentId,
          });
          tx.conversations.addAgent(dm.id, agentId);
          tx.workspaces.addOwnerMember(home.id, 'local');
          tx.workspaces.setOwnerUserId(home.id, 'local');
          tx.conversations.addUser(dm.id, 'local');
          tx.messages.insertForConversation({
            conversationId: dm.id,
            fromKind: 'system',
            content: 'hi',
            metadata: { subtype: systemSubtype('onboarding') },
          });
        });
      }
      return origSend(hostId, kind, params);
    };

    const result = await createAgent(deps, {
      input: { name: 'app-provision-active-winner', runtime: 'claude' },
      idempotencyKey: freshKey(),
      retry: false,
      creatorUserId: 'local',
    });

    // The loser does NOT compensate: the winner's graph is re-derived as echo.
    expect(result.kind).toBe('echo');
    if (result.kind === 'echo') {
      expect(result.payload.dmChannelId).toBeTruthy();
      expect(result.payload.onboardingMessageId).toBeTruthy();
    }

    // Exactly ONE graph — the winner's; the loser added nothing.
    const agentId = db
      .prepare<[], { id: string }>(
        `SELECT id FROM agents WHERE name = 'app-provision-active-winner'`,
      )
      .get()!.id;
    const row = db
      .prepare<[string], { materialization_status: string }>(
        `SELECT materialization_status FROM agents WHERE id = ?`,
      )
      .get(agentId)!;
    expect(row.materialization_status).toBe('active');
    const workspaces = db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspaces WHERE owner_agent_id = ?`,
      )
      .get(agentId)!.c;
    const conversations = db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM conversations c
          JOIN conversation_agents ca ON ca.conversation_id = c.id
         WHERE ca.agent_id = ?`,
      )
      .get(agentId)!.c;
    expect(workspaces).toBe(1);
    expect(conversations).toBe(1);
    // echo has no effects.
    expect(runtimeHost.delivered).toHaveLength(0);
    expect(runtimeHost.starts).toHaveLength(0);
  });

  it('happy path commits the graph, reports created, and builds the post-commit effects (route drains them; runtime stays untouched here)', async () => {
    const { db, deps, runtimeHost, fakeHostWs } = buildDeps();
    const result = await createAgent(deps, {
      input: { name: 'app-provision-ok', runtime: 'claude' },
      idempotencyKey: freshKey(),
      retry: false,
      creatorUserId: 'local',
    });
    expect(result.kind).toBe('created');
    if (result.kind === 'created') {
      const agentId = result.payload.agent.id;
      expect(result.payload.agentHomeWorkspaceId).toBeTruthy();
      expect(result.payload.dmChannelId).toBeTruthy();
      expect(result.payload.onboardingMessageId).toBeTruthy();
      const workspaces = db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM workspaces WHERE owner_agent_id = ?`,
        )
        .get(agentId)!.c;
      const conversations = db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM conversations c
            JOIN conversation_agents ca ON ca.conversation_id = c.id
           WHERE ca.agent_id = ?`,
        )
        .get(agentId)!.c;
      expect(workspaces).toBe(1);
      expect(conversations).toBe(1);
      // The route drains these after the L3a commit; here we only assert the
      // closures were BUILT (the fake runtime records calls when drained).
      expect(result.effects.length).toBe(3);
    }
    expect(runtimeHost.delivered).toHaveLength(0);
    expect(runtimeHost.starts).toHaveLength(0);
    expect(fakeHostWs.calls.some(c => c.kind === 'agent_materialize')).toBe(true);
  });

  it('AgentSlot materializes only L1: no home/DM/onboarding graph and one agent-scoped runtime slot', async () => {
    const { db, deps, runtimeHost, fakeHostWs } = buildDeps();
    const idempotencyKey = freshKey();
    const result = await createAgent(deps, {
      input: {
        name: 'app-provision-agent-slot',
        runtime: 'claude',
        session_scope: 'agent',
      },
      idempotencyKey,
      retry: false,
      creatorUserId: 'local',
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    const agentId = result.payload.agent.id;
    expect(result.payload).toMatchObject({
      agent: { session_scope: 'agent' },
      agentHomeWorkspaceId: null,
      dmChannelId: null,
      onboardingMessageId: null,
    });
    expect(
      db.prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM workspaces WHERE owner_agent_id = ?',
      ).get(agentId)!.c,
    ).toBe(0);
    expect(
      db.prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM conversation_agents WHERE agent_id = ?',
      ).get(agentId)!.c,
    ).toBe(0);
    const slots = new RuntimeSlotRepo(db);
    expect(slots.getAgent(agentId)).toMatchObject({
      agent_id: agentId,
      conversation_id: null,
      generation: 0,
    });
    expect(result.effects).toHaveLength(1);
    expect(runtimeHost.delivered).toHaveLength(0);
    expect(runtimeHost.starts).toHaveLength(0);
    expect(fakeHostWs.calls.some(c => c.kind === 'agent_materialize')).toBe(true);

    const echo = await createAgent(deps, {
      input: {
        name: 'app-provision-agent-slot',
        runtime: 'claude',
        session_scope: 'agent',
      },
      idempotencyKey,
      retry: false,
      creatorUserId: 'local',
    });
    expect(echo).toMatchObject({
      kind: 'echo',
      payload: {
        agent: { id: agentId, session_scope: 'agent' },
        agentHomeWorkspaceId: null,
        dmChannelId: null,
        onboardingMessageId: null,
      },
    });
  });
});
