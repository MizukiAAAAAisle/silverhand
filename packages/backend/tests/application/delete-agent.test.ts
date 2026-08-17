import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_AVAILABILITY_CHANGED_EVENT } from '@silverhand/shared';
import {
  commitAgentTeardown,
  deleteAgent,
  type AgentTeardownEligibility,
} from '../../src/application/delete-agent.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { createSqliteAgentTeardownPersistence } from '../../src/repos/agent-teardown-persistence.js';
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
    teardown: createSqliteAgentTeardownPersistence(t.ctx.db),
    deletionRunner: t.agentDeletionRunner,
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

/**
 * Every `runtime_stop` the runtime host received, in order.
 *
 * Load-bearing detail for the post-commit assertions: the fake records `hostId`
 * ONLY when the caller named it, and in production naming it is the difference
 * between a delivered stop and a warning — after the cascade the dispatcher's
 * `agents.host_id` → `hosts` resolve throws before the command goes out. So a
 * catch-up entry that carries `hostId` is the proof that the CAPTURED routing
 * authority was used, and one without it is the #task:1616 orphan bug.
 */
function runtimeStops(
  t: TestApp,
): Array<{
  conversationId: string | null;
  agentId: string;
  hostId?: string;
}> {
  return t.fake.stops;
}

/** An active agent that is a member of one workspace, plus that workspace's
 *  onboarding channel — where it holds an `idle` conversation_agents row. The
 *  agent's computer comes back too: it is what the post-commit catch-up must
 *  route by, and it is only readable while the row still exists. */
async function activeAgentInChannel(
  t: TestApp,
  name: string,
): Promise<{ agentId: string; channelId: string; hostId: string }> {
  const agentId = await makeActiveAgent(t, name);
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: `ws-${name}`,
      member_agent_ids: [agentId],
    })
  ).json()) as { channel: { id: string } };
  const hostId = new AgentRepo(t.ctx.db).get(agentId)!.host_id;
  t.fakeHostWs!.calls = [];
  t.fake.stops = [];
  return { agentId, channelId: workspace.channel.id, hostId };
}

/**
 * Move an agent to a second, freshly created computer.
 *
 * The ONE native statement this suite adds (Gate 4 ledger row, reviewed):
 * production has no placement writer at all, so this interleave is not
 * expressible through any repo or route — and inventing a production mutation
 * capability just so a test can reach it would put the hazard into the product.
 * The port promises the refusal regardless of who could trigger it (a UnitOfWork
 * whose safety rests on the absence of a writer documents nothing), so the test
 * plays the writer.
 */
function movePlacement(t: TestApp, agentId: string): string {
  const otherComputer = new HostRepo(t.ctx.db).createUserInvite({
    userId: t.viewerUserId,
  });
  t.ctx.db
    .prepare('UPDATE agents SET host_id = ? WHERE id = ?')
    .run(otherComputer.id, agentId);
  return otherComputer.id;
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

  it('a concurrent or ordinary repeated DELETE returns the dedicated deletion 409', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'single-flight');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    t.fakeHostWs!.agentFilesPurgeAckOverride = async () => {
      await blocked;
      return { ok: true, purged_count: 1, quiesced_count: 0 };
    };

    const first = deleteAgent(depsFor(t), {
      agentId,
      requesterUserId: t.viewerUserId,
      body: { confirm: true },
    });
    await vi.waitFor(() => expect(purgeCallCount(t!)).toBe(1));
    await expect(
      deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: { confirm: true },
      }),
    ).resolves.toEqual({ kind: 'deletionInProgress' });
    await expect(
      deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: { confirm: true },
        retry: true,
      }),
    ).resolves.toEqual({ kind: 'deletionInProgress' });
    release();
    await expect(first).resolves.toEqual({ kind: 'deleted' });
  });

  it('202 remains visible after refresh and explicit retry resumes the same marker', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'retry-delete');
    t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
      throw new HostWsCommandResponseError(
        'partial_purge' as never,
        'filesystem still busy',
        { hostId: 'local', commandKind: 'agent_files_purge', requestId: 'r' },
      );
    };

    const first = await http(t).del(`/api/agents/${agentId}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(first.status).toBe(202);
    expect(new AgentRepo(t.ctx.db).get(agentId)?.deletion_started_at).not.toBeNull();

    const ordinaryRepeat = await http(t).del(`/api/agents/${agentId}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(ordinaryRepeat.status).toBe(409);
    expect(await ordinaryRepeat.json()).toMatchObject({
      code: 'agent_deletion_in_progress',
    });

    t.fakeHostWs!.agentFilesPurgeAckOverride = () => ({
      ok: true,
      purged_count: 0,
      quiesced_count: 0,
    });
    const retried = await http(t).del(`/api/agents/${agentId}?retry=true`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(retried.status).toBe(204);
    expect(new AgentRepo(t.ctx.db).get(agentId)).toBeNull();
  });

  // #task:2043 B (Cindy) — the AGENT-VALIDITY availability edge. `begin` flips
  // `deletion_started_at` null→ts on its `started` arm, so the availability read
  // face returns Offline while the transport stays connected and the host stays
  // un-revoked — NO per-host edge fires, and the terminal `agent_changed` is
  // seconds-to-minutes away on the resumer's [1s,5s,30s] schedule. `deleteAgent`
  // must publish exactly ONE per-agent `agent_availability_changed` per viewer on
  // that committed transition, and an `alreadyPending` retry (a fact-free repeat)
  // must NOT re-fire. This is the falsifier: without the begin-edge publish the
  // frame count is 0 and a cached `online` viewer never learns to refetch.
  it('teardown-begin fires ONE availability invalidation per viewer (row/ACL still present); the read face flips Offline; an alreadyPending retry does not re-fire', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'avail-teardown');
    // The creator (default viewer `local`) is a viewer of the agent; count only
    // its availability frames on the private viewer scope.
    let frames = 0;
    t.ctx.events.subscribeScope(`viewer:${t.viewerUserId}`, e => {
      if (e.kind === AGENT_AVAILABILITY_CHANGED_EVENT) frames += 1;
    });

    // Pre-state: connected local host, un-revoked, not-deleted agent ⇒ Online.
    const before = await http(t).get(`/api/agents/${agentId}/availability`);
    expect(await before.json()).toMatchObject({ availability: 'online' });

    // Stall the worker: the purge ack throws, so `tryNow` returns pending, the
    // agent row + `deletion_started_at` marker persist, and the transport is
    // never disconnected. `deletion_started_at` is the ONLY fact that moved.
    t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
      throw new HostWsCommandResponseError(
        'partial_purge' as never,
        'filesystem still busy',
        { hostId: 'local', commandKind: 'agent_files_purge', requestId: 'r' },
      );
    };
    const begun = await deleteAgent(depsFor(t), {
      agentId,
      requesterUserId: t.viewerUserId,
      body: { confirm: true },
    });
    expect(begun.kind).toBe('deletionPendingRetry');

    // Row + ACL still present (status stays `active`; `begin` sets only the
    // marker), so the audience resolved and the viewer got EXACTLY ONE frame.
    expect(
      new AgentRepo(t.ctx.db).get(agentId)?.deletion_started_at,
    ).not.toBeNull();
    expect(frames).toBe(1);

    // The read face already answers Offline off the marker alone.
    const after = await http(t).get(`/api/agents/${agentId}/availability`);
    expect(await after.json()).toMatchObject({ availability: 'offline' });

    // An explicit retry re-enters `begin` → `alreadyPending`: a fact-free repeat.
    // The purge still stalls (still pending), but NO new frame is emitted.
    const retried = await deleteAgent(depsFor(t), {
      agentId,
      requesterUserId: t.viewerUserId,
      body: { confirm: true },
      retry: true,
    });
    expect(retried.kind).toBe('deletionPendingRetry');
    expect(frames).toBe(1);
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
      expect(result.kind).toBe('deletionPendingRetry');
      expect(
        new AgentRepo(t.ctx.db).get(agentId)?.deletion_started_at,
      ).not.toBeNull();
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

  // #task:1987 D — the in-scope eligibility re-read. Both branches decide their
  // sequence (row-only vs stop+purge+cascade) from a PRE-LOCK snapshot, so the
  // commit step re-reads status AND placement under the write lock and refuses
  // when either moved. Driven directly, because the race window it closes cannot
  // be opened from outside the transaction.
  describe('commitAgentTeardown (in-scope eligibility gate)', () => {
    it('status moved since the pre-flight → eligibilityMoved/materialization, row preserved', async () => {
      t = buildTestApp();
      const agentId = await makeActiveAgent(t, 'mover');
      const teardown = createSqliteAgentTeardownPersistence(t.ctx.db);

      // The row is `active`; a caller that dispatched on `failed` must not get a
      // row-only delete out of it.
      const outcome = commitAgentTeardown(teardown.uow, agentId, {
        materializationStatus: 'failed',
        purgedHostId: null,
      });
      expect(outcome).toMatchObject({
        kind: 'eligibilityMoved',
        moved: 'materialization',
        facts: { id: agentId, materializationStatus: 'active' },
      });
      expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
    });

    // The other half of the gate: the pre-lock phase purged ONE computer's tree,
    // so the row it deletes must still name that computer.
    it('placement moved since the purge → eligibilityMoved/placement, row preserved', async () => {
      t = buildTestApp();
      const agentId = await makeActiveAgent(t, 'relocated');
      const teardown = createSqliteAgentTeardownPersistence(t.ctx.db);

      const outcome = commitAgentTeardown(teardown.uow, agentId, {
        materializationStatus: 'active',
        purgedHostId: 'some-other-computer',
      });
      expect(outcome).toMatchObject({
        kind: 'eligibilityMoved',
        moved: 'placement',
      });
      expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
    });

    // Both LEGAL arms commit — and there are exactly two of them.
    it('the two eligible arms commit: active on its purged computer, failed row-only', async () => {
      t = buildTestApp();
      const agents = new AgentRepo(t.ctx.db);
      const teardown = createSqliteAgentTeardownPersistence(t.ctx.db);

      const activeId = await makeActiveAgent(t, 'still-here');
      expect(
        commitAgentTeardown(teardown.uow, activeId, {
          materializationStatus: 'active',
          purgedHostId: agents.get(activeId)!.host_id,
        }).kind,
      ).toBe('committed');
      expect(agents.get(activeId)).toBeNull();

      const failedId = await makeActiveAgent(t, 'never-materialized');
      setStatus(t, failedId, 'failed');
      expect(
        commitAgentTeardown(teardown.uow, failedId, {
          materializationStatus: 'failed',
          purgedHostId: null,
        }).kind,
      ).toBe('committed');
      expect(agents.get(failedId)).toBeNull();
    });

    /**
     * The illegal combinations are not test cases because they are not
     * expressible: `AgentTeardownEligibility` is a discriminated union, so the
     * COMPILER is this gate. Keeping the proof here rather than in prose means
     * flattening the union back into two independent fields makes these
     * `@ts-expect-error`s unused, and `tsc` fails.
     */
    it('the illegal eligibility combinations do not type-check', () => {
      const legal: AgentTeardownEligibility[] = [
        { materializationStatus: 'active', purgedHostId: 'some-computer' },
        { materializationStatus: 'failed', purgedHostId: null },
        // An active graph deleted with NO purge and no placement re-check.
        // @ts-expect-error active must name the computer it already purged
        { materializationStatus: 'active', purgedHostId: null },
        // A row-only delete claiming a purge it never dispatched.
        // @ts-expect-error failed dispatches no host-local work
        { materializationStatus: 'failed', purgedHostId: 'some-computer' },
        // A materialization in flight is refused before the write core is
        // reached at all, so it is not an eligibility this port accepts.
        // @ts-expect-error pending is not a teardown-eligible status
        { materializationStatus: 'pending_materialization', purgedHostId: null },
      ];
      expect(legal).toHaveLength(5);
    });

    it('row vanished → gone, nothing deleted', () => {
      t = buildTestApp();
      const teardown = createSqliteAgentTeardownPersistence(t.ctx.db);
      expect(
        commitAgentTeardown(teardown.uow, 'no-such-agent', {
          materializationStatus: 'active',
          purgedHostId: 'local',
        }),
      ).toEqual({ kind: 'gone' });
    });
  });

  /** #task:1988 — active deletion no longer owns an optimistic backend
   * pre-stop/catch-up pair. The daemon purge result means its shared fence has
   * quiesced every existing or late-admitted child before rm; backend stop
   * commands here would reintroduce the very timing window the fence replaces. */
  describe('durable deletion intent + daemon quiescence', () => {
    it('a runtime that appears while purge is in flight is covered by daemon quiescence, not a backend catch-up', async () => {
      t = buildTestApp();
      const { agentId, channelId } = await activeAgentInChannel(
        t,
        'spawner',
      );
      const conversations = new ConversationRepo(t.ctx.db);
      t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
        // The pre-flight read saw `idle` and stopped nothing; the daemon spawns
        // a child for this pair while the purge is in flight.
        new RuntimeSlotRepo(t!.ctx.db).updateCurrentConversationProjection(channelId, agentId, {
          status: 'active',
        });
        return { ok: true as const, purged_count: 1, quiesced_count: 1 };
      };

      const result = await deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: { confirm: true },
      });

      expect(result).toEqual({ kind: 'deleted' });
      expect(new AgentRepo(t.ctx.db).get(agentId)).toBeNull();
      expect(runtimeStops(t)).toEqual([]);
    });

    // Cindy's counter-example for why a pair set cannot carry generations: the
    // SAME key is acked pre-stop and then respawned before the lock.
    it('an already-active pair is not pre-stopped; purge quiescence is the single child authority', async () => {
      t = buildTestApp();
      const { agentId, channelId } = await activeAgentInChannel(
        t,
        'restarted',
      );
      const conversations = new ConversationRepo(t.ctx.db);
      const runtimeSlots = new RuntimeSlotRepo(t.ctx.db);
      runtimeSlots.updateCurrentConversationProjection(channelId, agentId, { status: 'active' });
      t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
        // The acked child exits, and the daemon spawns a NEW one for the same
        // pair. Nothing in the row distinguishes the two generations, so the
        // pre-commit ack must not be allowed to cover this child.
        runtimeSlots.updateCurrentConversationProjection(channelId, agentId, { status: 'idle' });
        runtimeSlots.updateCurrentConversationProjection(channelId, agentId, { pid: 4242 });
        runtimeSlots.updateCurrentConversationProjection(channelId, agentId, {
          status: 'active',
        });
        return { ok: true as const, purged_count: 1, quiesced_count: 1 };
      };

      const result = await deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: { confirm: true },
      });

      expect(result).toEqual({ kind: 'deleted' });
      expect(runtimeStops(t)).toEqual([]);
    });

    it('a partial purge returns pending, preserves the marker and publishes nothing', async () => {
      t = buildTestApp();
      const { agentId, channelId } = await activeAgentInChannel(t, 'refused');
      const conversations = new ConversationRepo(t.ctx.db);
      const changed = captureAgentChanged(t);
      t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
        new RuntimeSlotRepo(t!.ctx.db).updateCurrentConversationProjection(channelId, agentId, {
          status: 'active',
        });
        throw new HostWsCommandResponseError(
          'partial_purge' as never,
          'failed to remove 1 target(s): EACCES',
          { hostId: 'local', commandKind: 'agent_files_purge', requestId: 'r' },
        );
      };

      const result = await deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: { confirm: true },
      });

      expect(result.kind).toBe('deletionPendingRetry');
      expect(
        new AgentRepo(t.ctx.db).get(agentId)?.deletion_started_at,
      ).not.toBeNull();
      expect(runtimeStops(t)).toEqual([]);
      expect(changed).toEqual([]);
    });

    it('an impossible placement drift leaves the CAS-keyed attempt pending', async () => {
      t = buildTestApp();
      const { agentId, channelId } = await activeAgentInChannel(t, 'moved');
      const conversations = new ConversationRepo(t.ctx.db);
      const changed = captureAgentChanged(t);
      t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
        movePlacement(t!, agentId);
        new RuntimeSlotRepo(t!.ctx.db).updateCurrentConversationProjection(channelId, agentId, {
          status: 'active',
        });
        return { ok: true as const, purged_count: 1, quiesced_count: 1 };
      };

      const result = await deleteAgent(depsFor(t), {
        agentId,
        requesterUserId: t.viewerUserId,
        body: { confirm: true },
      });

      expect(result).toMatchObject({
        kind: 'deletionPendingRetry',
        code: 'agent_deletion_attempt_lost',
      });
      expect(
        new AgentRepo(t.ctx.db).get(agentId)?.deletion_started_at,
      ).not.toBeNull();
      expect(changed).toEqual([]);
      expect(runtimeStops(t)).toEqual([]);
    });

    it('the route exposes a durable placement-drift attempt as retry-pending 202', async () => {
      t = buildTestApp();
      const { agentId } = await activeAgentInChannel(t, 'moved-route');
      t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
        movePlacement(t!, agentId);
        return { ok: true as const, purged_count: 1, quiesced_count: 1 };
      };

      const res = await http(t).del(`/api/agents/${agentId}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        error: 'deletion attempt no longer matches agent placement or marker',
        code: 'agent_deletion_pending_retry',
      });
      expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
    });

    it('completion logs the CAS-keyed attempt and performs no backend stop phase', async () => {
      t = buildTestApp();
      const { agentId, channelId } = await activeAgentInChannel(t, 'logged');
      const conversations = new ConversationRepo(t.ctx.db);
      const agents = new AgentRepo(t.ctx.db);
      const infoSpy = vi.spyOn(t.ctx.logger, 'info');
      t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
        new RuntimeSlotRepo(t!.ctx.db).updateCurrentConversationProjection(channelId, agentId, {
          status: 'active',
        });
        agents.update(agentId, { display_name: 'renamed-in-window' });
        return { ok: true as const, purged_count: 1, quiesced_count: 1 };
      };

      expect(
        (
          await deleteAgent(depsFor(t), {
            agentId,
            requesterUserId: t.viewerUserId,
            body: { confirm: true },
          })
        ).kind,
      ).toBe('deleted');

      const summary = infoSpy.mock.calls.find(
        call => call[1] === 'agent deletion completed',
      );
      expect(summary?.[0]).toMatchObject({
        agentId,
        hostId: expect.any(String),
        deletionStartedAt: expect.any(Number),
      });
      expect(runtimeStops(t)).toEqual([]);
    });
  });
});
