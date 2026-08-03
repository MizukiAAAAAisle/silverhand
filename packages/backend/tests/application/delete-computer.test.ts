import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import {
  deleteComputer,
  type DeleteComputerDeps,
} from '../../src/application/delete-computer.js';
import { buildTestApp, type TestApp } from '../utils/app.js';
import { testWorkspacePath } from '../utils/db.js';

/**
 * Destruction boundaries for the computer-delete cascade (#task:1616).
 *
 * Two things are worth proving at this layer, and the route suite
 * (`tests/routes/hosts.test.ts`) cannot prove either: (a) every refusal destroys
 * NOTHING — no DB row, no attachment blob, no daemon `agent_files_purge`; and
 * (b) the destructive half is atomic, so a failure that lands after the
 * workspace/agent rows are already deleted inside the transaction rolls all of
 * them back. (b) is the original bug this use case exists for: the old flow
 * deleted agents one at a time outside any transaction, so a late refusal left
 * some of them irreversibly gone while the computer stayed.
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
  agentId: string;
  blobPath: string;
  purgeCalls: () => number;
  deps: () => DeleteComputerDeps;
}

async function setup(t: TestApp): Promise<Fixture> {
  const hosts = new HostRepo(t.ctx.db);
  const host = hosts.createUserInvite({ userId: t.viewerUserId });
  hosts.markActivated(host.id);
  hosts.markFinalized(host.id);

  const workspaces = new WorkspaceRepo(t.ctx.db);
  const workspacePath = testWorkspacePath('cascade-ws');
  const workspace = workspaces.insert({
    name: 'Cascade Workspace',
    description: null,
    workspacePath,
    workspaceHostId: host.id,
  });
  const agent = new AgentRepo(t.ctx.db).create(
    { name: 'racer', runtime: 'claude' },
    host.id,
    t.viewerUserId,
  );
  workspaces.insertMembership(workspace.id, agent.id);
  const conversations = new ConversationRepo(t.ctx.db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 'cascade channel',
  });
  conversations.addAgent(channel.id, agent.id);
  // A LIVE run, so the post-commit runtime stop has something to dispatch:
  // `computeDeleteImpact` only reports `starting` / `active` pairs.
  conversations.updateAgentRuntime(channel.id, agent.id, { status: 'active' });

  // A real blob, so "the bytes survived a refusal" is a filesystem fact.
  const uploaded = await t.ctx.attachmentService.upload({
    sourceConversationId: channel.id,
    filename: 'evidence.bin',
    contentType: 'application/octet-stream',
    buffer: Buffer.from('evidence'),
    createdByKind: 'user',
    createdById: t.viewerUserId,
  });
  const refs = t.ctx.attachmentService.collectChannelBlobRefs([channel.id]);
  expect(refs).toHaveLength(1);
  const blobPath = join(t.silverhandDir, 'blobs', refs[0]!.storageKey);
  expect(existsSync(blobPath)).toBe(true);
  expect(uploaded.channel_id).toBe(channel.id);

  return {
    t,
    hostId: host.id,
    workspaceId: workspace.id,
    channelId: channel.id,
    agentId: agent.id,
    blobPath,
    purgeCalls: () =>
      (t.fakeHostWs?.calls ?? []).filter(
        call => call.kind === 'agent_files_purge',
      ).length,
    deps: () => ({
      ctx: t.ctx,
      hosts,
      agents: new AgentRepo(t.ctx.db),
      workspaces,
      conversations,
      conversationInboxes: new ConversationInboxRepo(t.ctx.db),
    }),
  };
}

/** Nothing this cascade could destroy has been destroyed. */
function expectIntact(f: Fixture): void {
  expect(new HostRepo(f.t.ctx.db).get(f.hostId)).not.toBeNull();
  expect(new WorkspaceRepo(f.t.ctx.db).get(f.workspaceId)).not.toBeNull();
  expect(new AgentRepo(f.t.ctx.db).get(f.agentId)).not.toBeNull();
  expect(new ConversationRepo(f.t.ctx.db).get(f.channelId)).not.toBeNull();
  expect(existsSync(f.blobPath)).toBe(true);
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
    // the objects, so an API/CLI caller learns what the flag would destroy.
    expect(result).toMatchObject({
      kind: 'hasDependents',
      payload: {
        dependents: { agents: 1, workspaces: 1 },
        agents: [{ id: f.agentId }],
        workspaces: [{ id: f.workspaceId, viewer_role: 'owner' }],
      },
    });
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

  it('refuses and destroys nothing when the requester does not own a workspace on the computer', async () => {
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

    // Consent does not grant authority: the owner gate is re-evaluated against
    // current state inside the transaction, and it names the workspaces that
    // need their owner (`viewer_role` is the resource fact, not a verdict).
    expect(result).toMatchObject({
      kind: 'workspaceForbidden',
      workspaces: [{ id: f.workspaceId, viewer_role: 'member' }],
    });
    expectIntact(f);
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
    expect(new WorkspaceRepo(t.ctx.db).get(f.workspaceId)).toBeNull();
    // The falsifier for the post-commit sweep: the rows are gone, so a sweep
    // that re-queried `attachments` by channel would silently find nothing and
    // leak this file forever. It is deleted only because the storage refs were
    // captured inside the transaction.
    expect(t.ctx.attachmentService.collectChannelBlobRefs([f.channelId])).toEqual([]);
    expect(existsSync(f.blobPath)).toBe(false);
    // And the purge still names the workspaces the agent belonged to — those
    // membership rows are also gone post-commit.
    const purge = (t.fakeHostWs?.calls ?? []).find(
      call => call.kind === 'agent_files_purge',
    );
    expect(purge?.params).toMatchObject({
      agent_id: f.agentId,
      scope: 'all',
      workspace_ids: [f.workspaceId],
    });
    // Every post-commit stop names the computer it must be routed to. Identity
    // alone is not enough: the production dispatcher resolves routing from
    // `agents.host_id` → `hosts`, rows this cascade has just deleted, so a stop
    // without the captured `hostId` throws and the daemon's child survives the
    // delete (see the falsifier pair in tests/runtime/outbound-event-fanout.test.ts).
    // And EXACTLY ONE stop for this pair: the workspace plan's captured members
    // and the agent teardown's live runs both name it, so the union must be
    // deduped rather than dispatched twice across the process boundary.
    expect(t.fake.stops).toEqual([
      { conversationId: f.channelId, agentId: f.agentId, hostId: f.hostId },
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
    expect(existsSync(f.blobPath)).toBe(true);
    expect(
      warnings.some(msg => msg.includes('attachment sweep left blobs behind')),
    ).toBe(true);
  });

  it('rolls the whole cascade back — and fails loud — when the host row refuses to delete', async () => {
    t = buildTestApp();
    const f = await setup(t);
    class RestrictingHostRepo extends HostRepo {
      override deleteOwnedUserInvite(): boolean {
        // An unmodeled RESTRICT reference, i.e. schema drift or a bug. It fires
        // AFTER the workspace and agent rows have been deleted inside the
        // transaction, which is exactly the half-delete the old agent-by-agent
        // loop produced.
        throw new Error('FOREIGN KEY constraint failed');
      }
    }

    await expect(
      deleteComputer(
        { ...f.deps(), hosts: new RestrictingHostRepo(t.ctx.db) },
        {
          hostId: f.hostId,
          requesterUserId: t.viewerUserId,
          cascadeDependents: true,
        },
      ),
      // NOT a `has_dependents` 409: that would hand the UI a dead end (blocked,
      // nothing left to remove, retry forever) and hide the invariant violation.
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    // Atomicity: the workspace, its channel, the agent and the bytes are all
    // still there, and nothing crossed a process boundary.
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
      class RestrictingHostRepo extends HostRepo {
        override deleteOwnedUserInvite(): boolean {
          throw new Error('FOREIGN KEY constraint failed');
        }
      }
      const changed = captureAgentChanged(t);

      await expect(
        deleteComputer(
          { ...f.deps(), hosts: new RestrictingHostRepo(t.ctx.db) },
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
