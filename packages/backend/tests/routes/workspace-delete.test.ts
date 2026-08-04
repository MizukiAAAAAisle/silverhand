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
    // relocation-v1 §7-4 — a workspace has no owning computer, so the agent is
    // simply placed on this installation's own local computer.
    const hostId = t.ctx.coLocatedHostId!;

    // Seed an agent, make it a
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
    const hostId = t.ctx.coLocatedHostId!;

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

  // ── relocation-v1 §3.4 / §7-4 — registry demotion: NO workspace_unbind ──
  //
  // A regular workspace no longer holds a daemon-side registry identity
  // binding, so delete dispatches NO `workspace_unbind` fan-out (the whole
  // #task:1719 mechanism is retired). The delete still removes NO daemon-side
  // directories (#1594) and still returns 204. This is the inverse of the old
  // fan-out pins: even a guest member on another computer draws zero unbind
  // traffic.
  it('delete with a guest member host present → still 204 (no daemon fan-out, relocation-v1 §7-4)', async () => {
    t = buildTestApp();
    const ws = (await (
      await http(t).post('/api/workspaces', { name: 'no-unbind', member_agent_ids: [] })
    ).json()) as any;
    const wsId = ws.workspace.id as string;
    const channelId = ws.onboarding_channel_id as string;

    // Seed a GUEST computer + an agent living on it that is a member of a
    // conversation in the workspace (cross-computer membership, #task:1600).
    // In the old model its daemon could hold a guest registry binding; now
    // there is nothing to unbind.
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

    const res = await http(t).del(`/api/workspaces/${wsId}`);
    expect(res.status).toBe(204);

    const wsRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(wsId);
    expect(wsRow).toBeUndefined();
  });
});
