import { afterEach, describe, expect, it } from 'vitest';
import { deleteAgent } from '../../src/application/delete-agent.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Application-level tests for the `deleteAgent` use case (#task:982, P11a). The HTTP route suites
 * (agents.test.ts full active-flow, agent-delete-files-purge fail-closed/
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

/** Capture `agent_changed` ids published on the `app` scope from the moment of
 *  subscription. Delete reuses `agent_changed` as its terminal identity-change
 *  signal (#task:1791) — the post-commit freshness effect that lets every
 *  historical-author carrier reconcile to the `deleted` snapshot. Without it the
 *  author carrier stays `active` forever, so this signal firing exactly on a
 *  committed delete (and NEVER on a refusal/fail-closed) is load-bearing. */
function captureAgentChanged(t: TestApp): string[] {
  const ids: string[] = [];
  t.ctx.events.subscribeScope('app', e => {
    if (e.kind === 'agent_changed') ids.push((e.payload as any).agent_id);
  });
  return ids;
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

  it('happy active delete → deleted: purge dispatched, agent row + membership gone', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'happy');
    const workspaceResponse = await http(t).post('/api/workspaces', {
      name: 'engineering',
      member_agent_ids: [agentId],
    });
    expect(workspaceResponse.status).toBe(201);
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

  // #task:1791 — the post-commit freshness signal. `deleteAgent` publishes the
  // terminal `agent_changed` EXACTLY on a committed delete (both the failed-row
  // and the active branch) and NEVER on a refusal or a fail-closed purge. A
  // false negative strands the author carrier at `active`; a false positive
  // tells clients an agent is gone while its row (and files) still exist.
  describe('post-commit identity-change publish (agent_changed)', () => {
    it('failed-row delete success → publishes agent_changed once for that id', async () => {
      t = buildTestApp();
      const agentId = await makeActiveAgent(t, 'faily');
      setStatus(t, agentId, 'failed');
      const changed = captureAgentChanged(t);

      const result = await deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: {},
      });
      expect(result).toEqual({ kind: 'deleted' });
      expect(changed).toEqual([agentId]);
    });

    it('active delete success → publishes agent_changed once for that id', async () => {
      t = buildTestApp();
      const agentId = await makeActiveAgent(t, 'happy');
      await http(t).post('/api/workspaces', {
        name: 'engineering',
        member_agent_ids: [agentId],
      });
      const changed = captureAgentChanged(t);

      const result = await deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: { confirm: true },
      });
      expect(result).toEqual({ kind: 'deleted' });
      expect(changed).toEqual([agentId]);
    });

    it('fail-closed purge → NO agent_changed (identity never told to change while the row survives)', async () => {
      t = buildTestApp();
      const agentId = await makeActiveAgent(t, 'bob');
      await http(t).post('/api/workspaces', {
        name: 'engineering',
        member_agent_ids: [agentId],
      });
      t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
        throw new HostWsCommandResponseError(
          'partial_purge' as never,
          'failed to remove 1 target(s): EACCES',
          { hostId: 'local', commandKind: 'agent_files_purge', requestId: 'r' },
        );
      };
      const changed = captureAgentChanged(t);

      const result = await deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: { confirm: true },
      });
      expect(result.kind).toBe('failClosed');
      expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
      expect(changed).toEqual([]);
    });

    it('refusals (pendingInFlight / confirmRequired / notFound) → NO agent_changed', async () => {
      t = buildTestApp();
      const pending = await makeActiveAgent(t, 'pendy');
      setStatus(t, pending, 'pending_materialization');
      const active = await makeActiveAgent(t, 'activy');
      const changed = captureAgentChanged(t);

      expect(
        (await deleteAgent(depsFor(t), {
          agentId: pending,
          requesterUserId: t.viewerUserId,
          body: { confirm: true },
        })).kind,
      ).toBe('pendingInFlight');
      expect(
        (await deleteAgent(depsFor(t), {
          agentId: active,
          requesterUserId: t.viewerUserId,
          body: {},
        })).kind,
      ).toBe('confirmRequired');
      expect(
        (await deleteAgent(depsFor(t), {
          agentId: 'no-such-agent',
          requesterUserId: t.viewerUserId,
          body: { confirm: true },
        })).kind,
      ).toBe('notFound');

      expect(changed).toEqual([]);
    });
  });
});
