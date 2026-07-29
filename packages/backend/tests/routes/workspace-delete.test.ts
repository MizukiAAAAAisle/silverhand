/**
 * DELETE /api/workspaces/:id cascade characterization (P13a).
 *
 * Pins the destructive-cascade behavior BEFORE the `deleteWorkspace` use-case
 * extraction so the lift is provably behavior-preserving. The fail-closed
 * placement preflight + blob sweep + happy-204 are covered elsewhere
 * (workspace-placement-preflight.test.ts, attachments.test.ts); this file nails
 * the three gaps Cindy flagged: idempotent 204, owner-gate 403, and the runtime
 * stop fan-out ORDERING + DB cascade.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  X_SILVERHAND_PRINCIPAL_HEADER,
  encodeUserPrincipalHeader,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';

describe('DELETE /api/workspaces/:id — cascade characterization (P13a)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    vi.restoreAllMocks();
    t?.cleanup();
    t = null;
  });

  it('unknown workspace id → 204 (idempotent no-op)', async () => {
    t = buildTestApp();
    const res = await http(t).del('/api/workspaces/does-not-exist');
    expect(res.status).toBe(204);
  });

  it('emits viewer_workspaces_changed(removed) to each viewer member so their UI drops the workspace + its unread (#task:1404)', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'notify-on-delete', member_agent_ids: [] })
    ).json()) as { workspace: { id: string } };
    const wsId = ws.workspace.id;

    const frames: Array<{ change?: string; workspace_id?: string }> = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e => {
      if (e.kind === 'viewer_workspaces_changed') {
        frames.push(e.payload as { change?: string; workspace_id?: string });
      }
    });

    const res = await http(t).del(`/api/workspaces/${wsId}`);
    unsub();
    expect(res.status).toBe(204);

    // 'local' is the owner/user-member; deletion must tell them the workspace is
    // gone so the sidebar row AND its unread contribution drop (renderer half of
    // #task:1404). Previously delete-workspace emitted nothing → phantom badge.
    expect(frames).toContainEqual({ change: 'removed', workspace_id: wsId });
  });

  it('agent_home / DM workspace → 409, row NOT deleted (delete the owning agent instead)', async () => {
    t = buildTestApp();
    // Creating an agent auto-provisions its agent_home (DM) workspace.
    await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' });
    const home = t.ctx.db
      .prepare<[], { id: string }>(
        `SELECT id FROM workspaces WHERE workspace_kind = 'agent_home' LIMIT 1`,
      )
      .get();
    expect(home).toBeDefined();

    const res = await http(t).del(`/api/workspaces/${home!.id}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'workspace_not_deletable',
    });

    // agent_home workspaces are deleted through DELETE /api/agents/:id, not
    // the generic workspace endpoint — the row survives.
    const still = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(home!.id);
    expect(still).toBeDefined();
  });

  it('non-owner principal → 403, workspace intact', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'owned', member_agent_ids: [] })
    ).json()) as any;

    const res = await http(t).del(`/api/workspaces/${ws.workspace.id}`, {
      headers: {
        [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
      },
    });
    expect(res.status).toBe(403);

    const still = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(ws.workspace.id);
    expect(still).toBeDefined();
  });

  it('runtime stop fan-out (conversation_closed + per-agent hard stop) fires BEFORE workspaces.delete; DB cascade removes conversations/messages/members', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'cascade', member_agent_ids: [] })
    ).json()) as any;
    const channelId = ws.onboarding_channel_id as string;
    const hostId = ws.workspace.workspace_host_id as string;

    // Seed an agent on the SAME host (so the preflight passes), make it a
    // member of the onboarding channel, and post a message so there is a
    // message row to observe the DB cascade on.
    const agentId = `cascade-agent-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, 'local', ?, ?)`,
      )
      .run(agentId, 'cascade-agent', hostId, now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_agents (conversation_id, agent_id, status, joined_at)
         VALUES (?, ?, 'idle', ?)`,
      )
      .run(channelId, agentId, now);
    const msg = (await (
      await http(t).post(`/api/channels/${channelId}/messages`, { content: 'hi' })
    ).json()) as any;
    const messageId = msg.message.id as string;

    // Unified timeline: record resolve / stop / delete in call order so we can
    // prove ORDERING (not just call counts — a delete moved before the stops
    // would still satisfy a count assertion).
    const timeline: string[] = [];
    const realResolve = t.fake.resolveConversationRuns.bind(t.fake);
    vi.spyOn(t.fake, 'resolveConversationRuns').mockImplementation(
      (cid: string, reason: any) => {
        timeline.push(`resolve:${cid}:${reason}`);
        return realResolve(cid, reason);
      },
    );
    const realStop = t.fake.stop.bind(t.fake);
    vi.spyOn(t.fake, 'stop').mockImplementation(
      async (cid: string, aid: string) => {
        timeline.push(`stop:${cid}:${aid}`);
        return realStop(cid, aid);
      },
    );
    const realDelete = WorkspaceRepo.prototype.delete;
    vi.spyOn(WorkspaceRepo.prototype, 'delete').mockImplementation(function (
      this: WorkspaceRepo,
      id: string,
    ) {
      timeline.push('delete');
      return realDelete.call(this, id);
    });

    const res = await http(t).del(`/api/workspaces/${ws.workspace.id}`);
    expect(res.status).toBe(204);

    // The fan-out actually fired with the expected reason / mode.
    expect(timeline).toContain(`resolve:${channelId}:conversation_closed`);
    expect(timeline).toContain(`stop:${channelId}:${agentId}`);

    // ORDERING: every resolve/stop precedes the repo delete.
    const deleteIdx = timeline.indexOf('delete');
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    timeline.forEach((entry, i) => {
      if (entry.startsWith('resolve:') || entry.startsWith('stop:')) {
        expect(i).toBeLessThan(deleteIdx);
      }
    });

    // DB cascade: workspace + conversation + message + membership rows gone.
    const wsRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(ws.workspace.id);
    expect(wsRow).toBeUndefined();
    const convRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM conversations WHERE id = ?')
      .get(channelId);
    expect(convRow).toBeUndefined();
    const msgRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM messages WHERE id = ?')
      .get(messageId);
    expect(msgRow).toBeUndefined();
    const caRow = t.ctx.db
      .prepare<[string, string], { agent_id: string }>(
        'SELECT agent_id FROM conversation_agents WHERE conversation_id = ? AND agent_id = ?',
      )
      .get(channelId, agentId);
    expect(caRow).toBeUndefined();
    const wuRow = t.ctx.db
      .prepare<[string], { user_id: string }>(
        'SELECT user_id FROM workspace_users WHERE workspace_id = ?',
      )
      .get(ws.workspace.id);
    expect(wuRow).toBeUndefined();
  });

  it('runtime stop failure is best-effort and does not block workspace delete', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'stop-failure', member_agent_ids: [] })
    ).json()) as any;
    const channelId = ws.onboarding_channel_id as string;
    const hostId = ws.workspace.workspace_host_id as string;

    const agentId = `stop-failure-agent-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, 'local', ?, ?)`,
      )
      .run(agentId, 'stop-failure-agent', hostId, now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_agents (conversation_id, agent_id, status, joined_at)
         VALUES (?, ?, 'idle', ?)`,
      )
      .run(channelId, agentId, now);

    const stopErr = new Error('daemon offline');
    t.fake.stopError = stopErr;
    const warnSpy = vi.spyOn(t.ctx.logger, 'warn');

    const res = await http(t).del(`/api/workspaces/${ws.workspace.id}`);
    expect(res.status).toBe(204);

    await Promise.resolve();
    expect(t.fake.stops).toContainEqual({
      conversationId: channelId,
      agentId,
      // The captured routing authority (#task:1616): the teardown runs after the
      // rows are gone, so the stop must name the computer itself.
      hostId,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: ws.workspace.id,
        conversationId: channelId,
        agentId,
        err: stopErr,
      }),
      'delete workspace: runtime stop failed (continuing)',
    );

    const wsRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(ws.workspace.id);
    expect(wsRow).toBeUndefined();
  });

  // ── #task:1719 — workspace_unbind fan-out after the row delete ──────
  //
  // The delete removes NO daemon-side directories (#1594), but it must
  // best-effort remove each relevant daemon's registry IDENTITY BINDING so
  // the deleted id stops participating in path-overlap validation as a
  // ghost. Home computer + every member agent's computer; offline hosts and
  // dispatch failures are logged and never block the 204.

  it('dispatches workspace_unbind to the home host AND each guest member host with the deleted workspace id (#task:1719)', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'unbind-fanout', member_agent_ids: [] })
    ).json()) as any;
    const wsId = ws.workspace.id as string;
    const channelId = ws.onboarding_channel_id as string;
    const homeHostId = ws.workspace.workspace_host_id as string;

    // Seed a GUEST computer + an agent living on it that is a member of a
    // conversation in the workspace (cross-computer membership, #task:1600):
    // its daemon may hold a guest registry binding for this workspace.
    const guestHostId = `guest-host-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(`INSERT INTO hosts (id, name, kind, created_at) VALUES (?, ?, 'remote', ?)`)
      .run(guestHostId, guestHostId, now);
    const guestAgentId = `guest-agent-${Date.now()}`;
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, 'local', ?, ?)`,
      )
      .run(guestAgentId, 'guest-agent', guestHostId, now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_agents (conversation_id, agent_id, status, joined_at)
         VALUES (?, ?, 'idle', ?)`,
      )
      .run(channelId, guestAgentId, now);

    const infoSpy = vi.spyOn(t.ctx.logger, 'info');
    const res = await http(t).del(`/api/workspaces/${wsId}`);
    expect(res.status).toBe(204);

    const unbindCalls = t.fakeHostWs!.calls.filter(
      call => call.kind === 'workspace_unbind',
    );
    // Distinct hosts: home + guest, each with the single deleted id.
    expect(unbindCalls.map(call => call.hostId).sort()).toEqual(
      [homeHostId, guestHostId].sort(),
    );
    for (const call of unbindCalls) {
      expect(call.params).toEqual({ workspace_ids: [wsId] });
    }
    // Success is logged with removed/absent (structured, observable residue).
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workspace_unbind',
        host_id: homeHostId,
        workspace_id: wsId,
        // POST /api/workspaces provisioned the home bind in the fake
        // registry, so the home unbind actually removes it.
        removed: [wsId],
        absent: [],
      }),
      'delete workspace: daemon registry binding unbound',
    );
  });

  it('an offline host (outbound resolve fails) is logged and skipped — deletion still returns 204 (#task:1719)', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'unbind-offline', member_agent_ids: [] })
    ).json()) as any;
    const wsId = ws.workspace.id as string;
    const homeHostId = ws.workspace.workspace_host_id as string;

    // Simulate the home daemon detached AFTER creation: resolveOutboundForHost
    // fails with host_attach_pending, and the unbind must degrade to a warn.
    t.fakeHostWs!.connectionIdForHostOverride = () => null;
    const warnSpy = vi.spyOn(t.ctx.logger, 'warn');

    const res = await http(t).del(`/api/workspaces/${wsId}`);
    expect(res.status).toBe(204);

    // Nothing dispatched (no connection), but the residue is observable.
    expect(
      t.fakeHostWs!.calls.filter(call => call.kind === 'workspace_unbind'),
    ).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workspace_unbind_failed',
        host_id: homeHostId,
        workspace_id: wsId,
        code: 'host_attach_pending',
      }),
      'delete workspace: host offline, registry entry stays orphaned (continuing)',
    );
    // The delete itself is never blocked or reversed.
    const wsRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(wsId);
    expect(wsRow).toBeUndefined();
  });

  it('a failed workspace_unbind dispatch is logged, never thrown — deletion still returns 204 (#task:1719)', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'unbind-dispatch-fail', member_agent_ids: [] })
    ).json()) as any;
    const wsId = ws.workspace.id as string;
    const homeHostId = ws.workspace.workspace_host_id as string;

    // Make the dispatch itself fail (daemon errored mid-command). Set AFTER
    // creation so workspace_provision already succeeded.
    t.fakeHostWs!.sendCommandError = new Error('daemon exploded');
    const warnSpy = vi.spyOn(t.ctx.logger, 'warn');

    const res = await http(t).del(`/api/workspaces/${wsId}`);
    expect(res.status).toBe(204);

    // The command was attempted against the home host...
    expect(
      t.fakeHostWs!.calls.filter(call => call.kind === 'workspace_unbind'),
    ).toContainEqual({
      hostId: homeHostId,
      kind: 'workspace_unbind',
      params: { workspace_ids: [wsId] },
    });
    // ...and the failure surfaced as a structured warn, not a 5xx.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workspace_unbind_failed',
        host_id: homeHostId,
        workspace_id: wsId,
        code: 'daemon_internal_error',
      }),
      'delete workspace: registry unbind failed, entry stays orphaned (continuing)',
    );
    const wsRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(wsId);
    expect(wsRow).toBeUndefined();
  });

  it('a workspace_members-only member (NO conversation membership) still puts its host in the unbind fan-out — workspace_members is the authoritative guest source, not runtimeStops (#task:1719)', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'unbind-members-only', member_agent_ids: [] })
    ).json()) as any;
    const wsId = ws.workspace.id as string;
    const homeHostId = ws.workspace.workspace_host_id as string;

    // Seed a GUEST computer + an agent living on it that is a WORKSPACE
    // member but joins NO conversation in the workspace. Its daemon
    // provisioned a local realization at membership establishment
    // (#1594/#1600), so its registry binding must still be torn down —
    // a runtimeStops-derived capture would silently miss it.
    const guestHostId = `members-only-host-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(`INSERT INTO hosts (id, name, kind, created_at) VALUES (?, ?, 'remote', ?)`)
      .run(guestHostId, guestHostId, now);
    const guestAgentId = `members-only-agent-${Date.now()}`;
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, 'local', ?, ?)`,
      )
      .run(guestAgentId, 'members-only-agent', guestHostId, now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(wsId, guestAgentId, now);

    const res = await http(t).del(`/api/workspaces/${wsId}`);
    expect(res.status).toBe(204);

    const unbindCalls = t.fakeHostWs!.calls.filter(
      call => call.kind === 'workspace_unbind',
    );
    expect(unbindCalls.map(call => call.hostId).sort()).toEqual(
      [homeHostId, guestHostId].sort(),
    );
    for (const call of unbindCalls) {
      expect(call.params).toEqual({ workspace_ids: [wsId] });
    }
  });

  it('P0-2: a daemon WITHOUT workspace.registry_reconcile.v1 gets ZERO unbind traffic — skipped with a structured log, deletion still 204 (#task:1719)', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'unbind-no-capability', member_agent_ids: [] })
    ).json()) as any;
    const wsId = ws.workspace.id as string;
    const homeHostId = ws.workspace.workspace_host_id as string;

    // Simulate an OLD daemon generation: connected, but its ready frame did
    // not advertise the reconcile capability. Dispatching workspace_unbind
    // at it would make it strict-reject the unknown command and DROP the
    // connection — the gate must withhold the command entirely.
    t.fakeHostWs!.attachmentCapabilities =
      t.fakeHostWs!.attachmentCapabilities.filter(
        c => c !== 'workspace.registry_reconcile.v1',
      );
    const infoSpy = vi.spyOn(t.ctx.logger, 'info');

    const res = await http(t).del(`/api/workspaces/${wsId}`);
    expect(res.status).toBe(204);

    // Zero new traffic to that daemon.
    expect(
      t.fakeHostWs!.calls.filter(call => call.kind === 'workspace_unbind'),
    ).toEqual([]);
    // The withheld cleanup is observable, not silent.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workspace_unbind_skipped_no_capability',
        host_id: homeHostId,
        workspace_id: wsId,
      }),
      'delete workspace: daemon lacks workspace.registry_reconcile.v1; unbind withheld (converges on first post-upgrade reconcile)',
    );
    const wsRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(wsId);
    expect(wsRow).toBeUndefined();
  });
});
