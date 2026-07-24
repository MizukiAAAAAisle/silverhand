import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteAgent } from '../../src/application/delete-agent.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Application-level tests for the `deleteAgent` use case (#task:982, P11a). The HTTP route suites
 * (agents.test.ts full active-flow, agent-delete-files-purge fail-closed/backfill/
 * partial arms, agent-failed-recovery dispatch arms) remain the behavior
 * characterization — they hit the route, which now delegates here. These call the
 * use case DIRECTLY to pin the extraction-specific risks that are easiest to get
 * wrong: the typed result arms, the failed-row → row-only branch that must SKIP
 * the daemon purge, the confirm-parse ordering (failed row + malformed body stays
 * `deleted`, not `confirmRequired`), and the fail-closed ordering (no DB delete
 * before the purge acks). It is deliberately NOT a copy of the route matrix.
 */

function depsFor(t: TestApp) {
  return {
    ctx: t.ctx,
    agents: new AgentRepo(t.ctx.db),
    workspaces: new WorkspaceRepo(t.ctx.db),
    conversations: new ConversationRepo(t.ctx.db),
    conversationInboxes: new ConversationInboxRepo(t.ctx.db),
  };
}

async function makeActiveAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id as string;
}

function setStatus(t: TestApp, agentId: string, status: string) {
  t.ctx.db
    .prepare('UPDATE agents SET materialization_status = ? WHERE id = ?')
    .run(status, agentId);
}

function purgeCallCount(t: TestApp): number {
  return t.fakeHostWs!.calls.filter(c => c.kind === 'agent_files_purge').length;
}

describe('deleteAgent use case', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns notFound (idempotent) for an unknown id — no throw, no write', async () => {
    t = buildTestApp();
    const result = await deleteAgent(depsFor(t), {
      agentId: 'no-such-agent',
      requesterUserId: t.viewerUserId,
      body: { confirm: true },
    });
    expect(result).toEqual({ kind: 'notFound' });
  });

  it('pending_materialization → pendingInFlight, row preserved', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'pendy');
    setStatus(t, agentId, 'pending_materialization');

    const result = await deleteAgent(depsFor(t), {
      agentId,
      requesterUserId: t.viewerUserId,
      body: { confirm: true },
    });
    expect(result).toEqual({ kind: 'pendingInFlight' });
    expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
  });

  // The Cindy-flagged ordering risk: a failed row is a row-only delete that runs
  // BEFORE the confirm parse, so a missing/malformed confirm must NOT turn it
  // into 400 — and it must NOT dispatch a daemon purge.
  it('failed row + missing confirm → deleted (row-only), no daemon purge dispatched', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'faily');
    setStatus(t, agentId, 'failed');
    t.fakeHostWs!.calls = [];

    const result = await deleteAgent(depsFor(t), {
      agentId,
      requesterUserId: t.viewerUserId,
      body: {}, // no confirm — irrelevant on the failed branch
    });
    expect(result).toEqual({ kind: 'deleted' });
    expect(new AgentRepo(t.ctx.db).get(agentId)).toBeNull();
    expect(purgeCallCount(t)).toBe(0);
  });

  it('active + missing confirm → confirmRequired; row + purge untouched', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'activy');
    t.fakeHostWs!.calls = [];

    const result = await deleteAgent(depsFor(t), {
      agentId,
      requesterUserId: t.viewerUserId,
      body: {},
    });
    expect(result).toEqual({ kind: 'confirmRequired' });
    expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
    expect(purgeCallCount(t)).toBe(0);
  });

  // Fail-closed ordering: a backfill failure short-circuits BEFORE the purge and
  // before any DB delete — the agent row + membership survive and no purge fires.
  it('registry backfill failure → failClosed before any DB delete (rows + membership intact, no purge)', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'backy');
    const ws = (await (
      await http(t).post('/api/workspaces', {
        name: 'engineering',
        member_agent_ids: [agentId],
      })
    ).json()) as any;
    t.fakeHostWs!.calls = [];

    vi.spyOn(t.ctx.workspaceRegistryBackfiller!, 'ensure').mockResolvedValue({
      hostId: 'local',
      status: 'failed',
      provisioned: [],
      alreadyBound: [],
      failed: [
        {
          id: ws.workspace.id,
          code: 'host_attach_pending',
          message: 'backfill could not reach the daemon',
          retriable: true,
        },
      ],
    });

    const result = await deleteAgent(depsFor(t), {
      agentId,
      requesterUserId: t.viewerUserId,
      body: { confirm: true },
    });
    expect(result).toEqual({
      kind: 'failClosed',
      error: 'backfill could not reach the daemon',
      code: 'host_attach_pending',
      status: 503,
    });
    // No DB delete reached, no purge dispatched.
    expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
    const member = t.ctx.db
      .prepare(
        'SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(ws.workspace.id, agentId) as { n: number };
    expect(member.n).toBe(1);
    expect(purgeCallCount(t)).toBe(0);
  });

  it('happy active delete → deleted: purge dispatched, agent row + membership gone', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'happy');
    const ws = (await (
      await http(t).post('/api/workspaces', {
        name: 'engineering',
        member_agent_ids: [agentId],
      })
    ).json()) as any;
    t.fakeHostWs!.calls = [];

    const result = await deleteAgent(depsFor(t), {
      agentId,
      requesterUserId: t.viewerUserId,
      body: { confirm: true },
    });
    expect(result).toEqual({ kind: 'deleted' });
    expect(purgeCallCount(t)).toBe(1);
    expect(new AgentRepo(t.ctx.db).get(agentId)).toBeNull();
    const member = t.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE agent_id = ?')
      .get(agentId) as { n: number };
    expect(member.n).toBe(0);
  });
});
