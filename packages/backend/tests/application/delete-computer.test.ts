import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createSqliteAgentTeardownPersistence } from '../../src/repos/agent-teardown-persistence.js';
import type { AgentTeardownPersistence } from '../../src/application/agent-teardown-ports.js';
import {
  deleteComputer,
  type DeleteComputerDeps,
} from '../../src/application/delete-computer.js';
import { buildTestApp, type TestApp } from '../utils/app.js';

/**
 * Destruction boundaries for the computer-delete cascade (#task:1616).
 *
 * Two things are worth proving at this layer, and the route suite
 * (`tests/routes/hosts.test.ts`) cannot prove either: (a) every refusal destroys
 * NOTHING — no DB row, no attachment blob, no daemon `agent_files_purge`; and
 * (b) the destructive half is atomic, so a failure that lands after the agent
 * rows and their homes are already deleted inside the transaction rolls all of
 * them back. (b) is the original bug this use case exists for: the old flow
 * deleted agents one at a time outside any transaction, so a late refusal left
 * some of them irreversibly gone while the computer stayed.
 *
 * relocation-v1 §7-4 — what the cascade REACHES shrank: a `regular` workspace is
 * rooted on no computer, so only the computer's agents (and each agent's own
 * `agent_home` with its DM bytes) are destroyed. The fixture therefore carries
 * TWO attachments: one in the agent's DM (the destruction witness, captured
 * inside the transaction) and one in a shared regular channel (the survival
 * witness — computer-independent content the cascade must not touch).
 *
 * There is deliberately no "a dependency appeared after the snapshot" test any
 * more: the plan is read INSIDE the transaction, so there is no window between
 * the read the checks use and the deletes that consume it, and consent is one
 * boolean over the computer rather than an id snapshot to compare against.
 */

interface Fixture {
  t: TestApp;
  hostId: string;
  workspaceId: string;
  channelId: string;
  homeId: string;
  dmChannelId: string;
  agentId: string;
  /** Attachment in the shared regular channel — must SURVIVE the cascade. */
  sharedBlobPath: string;
  /** Attachment in the agent's DM — destroyed with the agent's home. */
  dmBlobPath: string;
  purgeCalls: () => number;
  deps: () => DeleteComputerDeps;
}

/**
 * Fault injection at the PORT, not at a repo subclass: the real teardown scope,
 * with `deleteComputerRow` throwing an unmodeled FK violation AFTER the agent
 * rows and their homes are already deleted inside it. That is exactly the
 * half-delete the old agent-by-agent loop produced, and the only way to prove the
 * whole cascade rolls back is to fail at the very last write in the scope.
 */
function failingComputerRowDelete(t: TestApp): AgentTeardownPersistence {
  const base = createSqliteAgentTeardownPersistence(t.ctx.db);
  return {
    read: base.read,
    deletion: base.deletion,
    uow: {
      atomicallyForAgent: (key, fn) => base.uow.atomicallyForAgent(key, fn),
      atomicallyForComputer: (key, fn) =>
        base.uow.atomicallyForComputer(key, tx =>
          fn({
            computer: {
              listAgentsForUpdate: () => tx.computer.listAgentsForUpdate(),
              forAgent: agentId => tx.computer.forAgent(agentId),
              deleteComputerRow: () => {
                throw new Error('FOREIGN KEY constraint failed');
              },
            },
          }),
        ),
    },
  };
}

async function setup(t: TestApp): Promise<Fixture> {
  const hosts = new HostRepo(t.ctx.db);
  const host = hosts.createUserInvite({ userId: t.viewerUserId });
  hosts.markActivated(host.id);
  hosts.markFinalized(host.id);

  const workspaces = new WorkspaceRepo(t.ctx.db);
  const workspace = workspaces.insert({
    name: 'Cascade Workspace',
    description: null,
  });
  const agent = new AgentRepo(t.ctx.db).create(
    { name: 'racer', runtime: 'claude' },
    host.id,
    t.viewerUserId,
  );
  workspaces.insertMembership(workspace.id, agent.id);
  const conversations = new ConversationRepo(t.ctx.db);
  const channel = conversations.insertChannel({
    name: 'ch-1',
    workspaceId: workspace.id,
    title: 'cascade channel',
  });
  conversations.addAgent(channel.id, agent.id);
  // A LIVE run, so the post-commit runtime stop has something to dispatch:
  // only `starting` / `active` captured sessions are stopped.
  const runtimeSlots = new RuntimeSlotRepo(t.ctx.db);
  runtimeSlots.updateCurrentConversationProjection(channel.id, agent.id, {
    status: 'active',
  });
  runtimeSlots.claimGeneration({
    scope: {
      kind: 'conversation',
      conversationId: channel.id,
      agentId: agent.id,
    },
    daemonInstanceId: 'daemon-delete-computer',
    status: 'active',
  });

  // The agent's own home + DM: this is what the cascade destroys, and the only
  // place it can capture blob refs from (the in-scope capture walks the owned
  // home's DM channels).
  const home = workspaces.insertAgentHome({ agent });
  const dm = conversations.insertDmChannel({
    name: 'ch-2',
    workspaceId: home.id,
    title: agent.name,
    agentId: agent.id,
  });
  conversations.addAgent(dm.id, agent.id);

  // Two real blobs, so both "survived a refusal" and "the shared channel's bytes
  // are not this cascade's business" are filesystem facts.
  const uploadedShared = await t.ctx.attachmentService.upload({
    sourceConversationId: channel.id,
    filename: 'shared-evidence.bin',
    contentType: 'application/octet-stream',
    buffer: Buffer.from('shared evidence'),
    createdByKind: 'user',
    createdById: t.viewerUserId,
  });
  await t.ctx.attachmentService.upload({
    sourceConversationId: dm.id,
    filename: 'dm-evidence.bin',
    contentType: 'application/octet-stream',
    buffer: Buffer.from('dm evidence'),
    createdByKind: 'user',
    createdById: t.viewerUserId,
  });
  const sharedRefs = t.ctx.attachmentService.collectChannelBlobRefs([channel.id]);
  const dmRefs = t.ctx.attachmentService.collectChannelBlobRefs([dm.id]);
  expect(sharedRefs).toHaveLength(1);
  expect(dmRefs).toHaveLength(1);
  const sharedBlobPath = join(t.silverhandDir, 'blobs', sharedRefs[0]!.storageKey);
  const dmBlobPath = join(t.silverhandDir, 'blobs', dmRefs[0]!.storageKey);
  expect(existsSync(sharedBlobPath)).toBe(true);
  expect(existsSync(dmBlobPath)).toBe(true);
  expect(uploadedShared.channel_id).toBe(channel.id);

  return {
    t,
    hostId: host.id,
    workspaceId: workspace.id,
    channelId: channel.id,
    homeId: home.id,
    dmChannelId: dm.id,
    agentId: agent.id,
    sharedBlobPath,
    dmBlobPath,
    purgeCalls: () =>
      (t.fakeHostWs?.calls ?? []).filter(
        call => call.kind === 'agent_files_purge',
      ).length,
    deps: () => ({
      ctx: t.ctx,
      teardown: createSqliteAgentTeardownPersistence(t.ctx.db),
    }),
  };
}

/** Nothing this cascade could destroy has been destroyed. */
function expectIntact(f: Fixture): void {
  expect(new HostRepo(f.t.ctx.db).get(f.hostId)).not.toBeNull();
  expect(new WorkspaceRepo(f.t.ctx.db).get(f.workspaceId)).not.toBeNull();
  expect(new WorkspaceRepo(f.t.ctx.db).get(f.homeId)).not.toBeNull();
  expect(new AgentRepo(f.t.ctx.db).get(f.agentId)).not.toBeNull();
  expect(new ConversationRepo(f.t.ctx.db).get(f.channelId)).not.toBeNull();
  expect(new ConversationRepo(f.t.ctx.db).get(f.dmChannelId)).not.toBeNull();
  expect(existsSync(f.sharedBlobPath)).toBe(true);
  expect(existsSync(f.dmBlobPath)).toBe(true);
  expect(f.purgeCalls()).toBe(0);
  expect(f.t.fake.stops).toEqual([]);
}

/** Capture `agent_changed` ids published on the `app` scope from the moment of
 *  subscription. The cascade publishes this terminal identity-change signal
 *  (#task:1791) in its post-commit phase, once per actually-deleted agent, so
 *  every historical-author carrier reconciles to the `deleted` snapshot. */
function captureAgentChanged(t: TestApp): string[] {
  const ids: string[] = [];
  t.ctx.events.subscribeScope('app', e => {
    if (e.kind === 'agent_changed') ids.push((e.payload as any).agent_id);
  });
  return ids;
}

describe('deleteComputer destruction boundaries', () => {
  let t: TestApp | null = null;

  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('refuses without the cascade confirmation and destroys nothing, naming what it would delete', async () => {
    t = buildTestApp();
    const f = await setup(t);

    const result = await deleteComputer(f.deps(), {
      hostId: f.hostId,
      requesterUserId: t.viewerUserId,
      cascadeDependents: false,
    });

    // The guard for a caller that skipped the resources query. It still names
    // the objects, so an API/CLI caller learns what the flag would destroy —
    // and after relocation-v1 §7-4 that is AGENTS only. §6's atomic epoch cut
    // then removed the empty `workspaces` shell from the payload outright, so
    // the dimension is ABSENT rather than present-and-zero: a workspace is
    // rooted on no computer, so deleting one can never name workspaces.
    expect(result).toMatchObject({
      kind: 'hasDependents',
      payload: {
        dependents: { agents: 1 },
        agents: [{ id: f.agentId }],
      },
    });
    // `toMatchObject` is permissive about extra keys, so pin the removal
    // itself: neither the payload nor its count object may carry the
    // retired dimension back.
    const payload = (result as unknown as { payload: Record<string, unknown> })
      .payload;
    expect('workspaces' in payload).toBe(false);
    expect(
      'workspaces' in (payload.dependents as Record<string, unknown>),
    ).toBe(false);
    expectIntact(f);
  });

  it('refuses and destroys nothing while an agent is still materializing', async () => {
    t = buildTestApp();
    const f = await setup(t);
    t.ctx.db
      .prepare(
        `UPDATE agents SET materialization_status = 'pending_materialization' WHERE id = ?`,
      )
      .run(f.agentId);

    const result = await deleteComputer(f.deps(), {
      hostId: f.hostId,
      requesterUserId: t.viewerUserId,
      cascadeDependents: true,
    });

    // Transient and not a consent question: the reserve → flip transaction must
    // not be raced, so this answers "retry" rather than offering a cascade.
    expect(result).toEqual({ kind: 'pendingAgents', pendingAgents: 1 });
    expectIntact(f);
  });

  it('refuses and preserves the resumer anchor while an agent deletion is pending', async () => {
    t = buildTestApp();
    const f = await setup(t);
    const teardown = createSqliteAgentTeardownPersistence(t.ctx.db);
    expect(teardown.deletion.begin(f.agentId, 123).kind).toBe('started');

    const result = await deleteComputer(f.deps(), {
      hostId: f.hostId,
      requesterUserId: t.viewerUserId,
      cascadeDependents: true,
    });

    expect(result).toEqual({
      kind: 'deletionInProgress',
      deletingAgents: 1,
    });
    expectIntact(f);
    expect(new AgentRepo(t.ctx.db).get(f.agentId)?.deletion_started_at).toBe(123);
  });

  it('a shared workspace is outside the cascade — its rows AND its bytes survive, whatever the requesters role in it', async () => {
    t = buildTestApp();
    const f = await setup(t);
    t.ctx.db
      .prepare(
        `UPDATE workspace_users SET role = 'member'
          WHERE workspace_id = ? AND user_id = ?`,
      )
      .run(f.workspaceId, t.viewerUserId);

    const result = await deleteComputer(f.deps(), {
      hostId: f.hostId,
      requesterUserId: t.viewerUserId,
      cascadeDependents: true,
    });

    // Inverted pin (relocation-v1 §7-4): the retired `workspaceForbidden` arm
    // existed because the cascade used to DESTROY the computer's workspaces, so
    // a non-owner's consent was not enough. Nothing of the workspace is
    // destroyed now — not the row, not its channel, not its attachment bytes —
    // so there is no owner's authority to ask for and the role is irrelevant.
    // Bytes are the sharp end: this layer is the only one that can prove the
    // shared channel's blob was not swept along with the agent's DM.
    expect(result).toEqual({ kind: 'deleted' });
    expect(new WorkspaceRepo(t.ctx.db).get(f.workspaceId)).not.toBeNull();
    expect(new ConversationRepo(t.ctx.db).get(f.channelId)).not.toBeNull();
    expect(existsSync(f.sharedBlobPath)).toBe(true);
    expect(
      t.ctx.attachmentService.collectChannelBlobRefs([f.channelId]),
    ).toHaveLength(1);
  });

  it('deletes the captured attachment blobs and routes every stop once the cascade commits', async () => {
    t = buildTestApp();
    const f = await setup(t);

    const result = await deleteComputer(f.deps(), {
      hostId: f.hostId,
      requesterUserId: t.viewerUserId,
      cascadeDependents: true,
    });

    expect(result).toEqual({ kind: 'deleted' });
    expect(new HostRepo(t.ctx.db).get(f.hostId)).toBeNull();
    // The agent's own home dies with it; the shared regular workspace does not
    // (§7-4 — it is rooted on no computer).
    expect(new WorkspaceRepo(t.ctx.db).get(f.homeId)).toBeNull();
    expect(new WorkspaceRepo(t.ctx.db).get(f.workspaceId)).not.toBeNull();
    // The falsifier for the post-commit sweep: the DM rows are gone, so a sweep
    // that re-queried `attachments` by channel would silently find nothing and
    // leak this file forever. It is deleted only because the storage refs were
    // captured inside the transaction.
    expect(t.ctx.attachmentService.collectChannelBlobRefs([f.dmChannelId])).toEqual([]);
    expect(existsSync(f.dmBlobPath)).toBe(false);
    expect(existsSync(f.sharedBlobPath)).toBe(true);
    // And the purge names the agent whose whole home tree is removed — the
    // membership rows are also gone post-commit.
    const purge = (t.fakeHostWs?.calls ?? []).find(
      call => call.kind === 'agent_files_purge',
    );
    expect(purge?.params).toMatchObject({
      agent_id: f.agentId,
    });
    // Every post-commit stop names the computer it must be routed to. Identity
    // alone is not enough: the production dispatcher resolves routing from
    // `agents.host_id` → `hosts`, rows this cascade has just deleted, so a stop
    // without the captured `hostId` throws and the daemon's child survives the
    // delete (see the falsifier pair in tests/runtime/outbound-event-fanout.test.ts).
    // And EXACTLY ONE stop for this pair: `impact.running_conversation_agents`
    // is the ONLY teardown authority since relocation-v1 §7-4 removed the
    // workspace-cascade half, so an agent live in several conversations is
    // stopped once PER PAIR and never twice for the same one.
    expect(t.fake.stops).toEqual([
      {
        conversationId: f.channelId,
        agentId: f.agentId,
        hostId: f.hostId,
        runtimeGeneration: 1,
        runtimeScope: {
          kind: 'conversation',
          conversationId: f.channelId,
          agentId: f.agentId,
        },
      },
    ]);
  });

  it('surfaces a blob-sweep failure instead of swallowing it', async () => {
    t = buildTestApp();
    const f = await setup(t);
    const warnings: string[] = [];
    const baseWarn = t.ctx.logger.warn.bind(t.ctx.logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t.ctx.logger as any).warn = (obj: unknown, msg?: string) => {
      if (typeof msg === 'string') warnings.push(msg);
      return baseWarn(obj as never, msg as never);
    };
    const storage = (
      t.ctx.attachmentService as unknown as {
        storage: { delete: (ref: unknown) => Promise<void> };
      }
    ).storage;
    storage.delete = () => Promise.reject(new Error('disk gone'));

    const result = await deleteComputer(f.deps(), {
      hostId: f.hostId,
      requesterUserId: t.viewerUserId,
      cascadeDependents: true,
    });

    // Best-effort: the delete still succeeds — but the residue is REPORTED, not
    // silently dropped. Before `deleteBlobs` returned an outcome, the service
    // swallowed each failure and the caller's `.catch` could never observe it,
    // so leaked bytes with no row left to name them were invisible.
    expect(result).toEqual({ kind: 'deleted' });
    expect(existsSync(f.dmBlobPath)).toBe(true);
    expect(
      warnings.some(msg => msg.includes('attachment sweep left blobs behind')),
    ).toBe(true);
  });

  it('rolls the whole cascade back — and fails loud — when the host row refuses to delete', async () => {
    t = buildTestApp();
    const f = await setup(t);
    await expect(
      deleteComputer(
        { ctx: t.ctx, teardown: failingComputerRowDelete(t) },
        {
          hostId: f.hostId,
          requesterUserId: t.viewerUserId,
          cascadeDependents: true,
        },
      ),
      // NOT a `has_dependents` 409: that would hand the UI a dead end (blocked,
      // nothing left to remove, retry forever) and hide the invariant violation.
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    // Atomicity: the agent, its home and DM, the shared channel and every byte
    // are all still there, and nothing crossed a process boundary.
    expectIntact(f);
  });

  // #task:1791 — the cascade's post-commit identity-change fan-out. A committed
  // cascade publishes `agent_changed` exactly once per DELETED agent (active AND
  // failed-row alike), and a rolled-back cascade publishes NOTHING — the signal
  // is emitted only after the authority transaction lands, never for an agent
  // whose row the rollback kept alive.
  describe('post-commit identity-change publish (agent_changed)', () => {
    it('commit → publishes agent_changed once per deleted agent, covering a cascaded failed-row agent', async () => {
      t = buildTestApp();
      const f = await setup(t);
      // A second cascaded agent in the `failed` state: it is torn down row-only
      // (no purge), but its author carrier must still be told to reconcile — the
      // cascade covers failed ids too, exactly once.
      const failed = new AgentRepo(t.ctx.db).create(
        { name: 'faily', runtime: 'claude' },
        f.hostId,
        t.viewerUserId,
      );
      new WorkspaceRepo(t.ctx.db).insertMembership(f.workspaceId, failed.id);
      t.ctx.db
        .prepare(`UPDATE agents SET materialization_status = 'failed' WHERE id = ?`)
        .run(failed.id);
      const changed = captureAgentChanged(t);

      const result = await deleteComputer(f.deps(), {
        hostId: f.hostId,
        requesterUserId: t.viewerUserId,
        cascadeDependents: true,
      });

      expect(result).toEqual({ kind: 'deleted' });
      // Exactly once each, no duplicate, no omission of the failed id.
      expect([...changed].sort()).toEqual([f.agentId, failed.id].sort());
      expect(changed).toHaveLength(2);
    });

    it('rollback → publishes NO agent_changed (never signals a delete the transaction undid)', async () => {
      t = buildTestApp();
      const f = await setup(t);
      const changed = captureAgentChanged(t);

      await expect(
        deleteComputer(
          { ctx: t.ctx, teardown: failingComputerRowDelete(t) },
          {
            hostId: f.hostId,
            requesterUserId: t.viewerUserId,
            cascadeDependents: true,
          },
        ),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);

      // The agent row survived the rollback, so its identity must NOT have been
      // announced as changed — the publish loop is strictly post-commit.
      expect(changed).toEqual([]);
      expectIntact(f);
    });
  });
});
