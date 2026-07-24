import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { HostWsCommandTransportError } from '../../src/ws/host-ws-server.js';

async function makeAgent(t: TestApp, name: string): Promise<{
  agentId: string;
  dmChannelId: string;
  agentHomeWorkspaceId: string;
}> {
  const created = await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json() as any;
  // Fetch the newly created agent_home so tests don't have to derive
  // the workspace id from the agent id directly.
  const workspaces = await (await http(t).get('/api/workspaces')).json() as any;
  const home = workspaces.workspaces.find(
    (w: any) =>
      w.workspace_kind === 'agent_home' && w.owner_agent_id === created.agent.id,
  );
  // Reset fan-out side-effects from provision so subsequent assertions
  // about ConversationManager are clean.
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    agentId: created.agent.id,
    dmChannelId: created.dm_channel_id,
    agentHomeWorkspaceId: home.id,
  };
}

async function createRegularWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; onboardingChannelId: string }> {
  const created = await (
    await http(t).post('/api/workspaces', {
      name,
      member_agent_ids: memberAgentIds,
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: created.workspace.id,
    onboardingChannelId: created.onboarding_channel_id,
  };
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json() as any;
  return created.channel.id;
}

function listWorkspacesPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/list-workspaces`;
}

function listChannelsPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/list-channels`;
}

describe('agent list_workspaces / list_channels(workspace_id?) routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns regular workspaces the agent is a member of plus its own agent_home, sorted regular-first', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId, bob.agentId]);
    const regSolo = await createRegularWorkspace(t, 'solo', [alice.agentId]);
    // Workspace alice is NOT a member of:
    await createRegularWorkspace(t, 'others-only', [bob.agentId]);

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ids = body.workspaces.map((w: any) => w.id);
    expect(ids).toContain(reg.workspaceId);
    expect(ids).toContain(regSolo.workspaceId);
    expect(ids).toContain(alice.agentHomeWorkspaceId);
    // bob's home / regular workspaces alice isn't in must NOT appear.
    expect(ids).not.toContain(bob.agentHomeWorkspaceId);
    const otherWorkspaces = await (await http(t).get('/api/workspaces')).json() as any;
    const othersOnly = otherWorkspaces.workspaces.find(
      (w: any) => w.name === 'others-only',
    );
    expect(ids).not.toContain(othersOnly.id);
    // sort: regular first (sort_group=0), then agent_home (sort_group=1).
    const homePos = ids.indexOf(alice.agentHomeWorkspaceId);
    expect(homePos).toBe(ids.length - 1);
  });

  it('agent_dir is daemon-stamped and kind-branched (regular = nested L2, agent_home = L1 home)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    const body = await res.json() as any;
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    const home = body.workspaces.find((w: any) => w.id === alice.agentHomeWorkspaceId);

    expect(regular.kind).toBe('regular');
    expect(home.kind).toBe('agent_home');

    // The value comes from the daemon (agent_workspace_index), NOT a backend
    // derivation from workspace_path. We assert the kind-branched SHAPE only,
    // without re-deriving from workspace_path (that would re-encode the I1
    // violation into the test). Verbatim daemon value is pinned separately.
    expect(regular.agent_dir).toMatch(
      new RegExp(`/\\.silverhand/agents/${alice.agentId}$`),
    );
    expect(home.agent_dir.endsWith(`/agents/${alice.agentId}`)).toBe(true);
    // agent_home resolves to the L1 home (no nested workspace `.silverhand`).
    expect(home.agent_dir).not.toContain('/.silverhand/');
  });

  // ── D4.e-1 3b-3: daemon-stamped agent_dir + fail-closed ───────────────
  // The value is now resolved by the daemon (`agent_workspace_index`), not
  // assembled by the backend from `workspace_path`. These pin that wiring.

  it('agent_dir is daemon-stamped: the response uses the daemon index value verbatim', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    // Force a sentinel agent_dir from the daemon — a value the backend could
    // never derive from workspace_path — and assert it survives to the DTO.
    t.fakeHostWs!.agentWorkspaceIndexAckOverride = params => ({
      ok: true as const,
      entries: params.workspace_ids.map(workspace_id => ({
        workspace_id,
        agent_dir: `/daemon/stamped/${workspace_id}`,
      })),
      unresolved: [],
    });

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    expect(regular.agent_dir).toBe(`/daemon/stamped/${reg.workspaceId}`);
  });

  it('runs the registry backfill before resolving: dispatches workspace_provision for legacy rows', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Drop create-time provision calls so we observe ONLY the list path.
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    expect(res.status).toBe(200);

    const provisionCalls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'workspace_provision',
    );
    // The backfill re-provisions the regular row with its stored path as
    // requested_path (idempotent re-bind), BEFORE the index dispatch.
    expect(provisionCalls.some(c => c.params.workspace_id === reg.workspaceId)).toBe(
      true,
    );
    const indexCalls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'agent_workspace_index',
    );
    expect(indexCalls).toHaveLength(1);
  });

  it('daemon offline → fail-closed (503), never falls back to a workspace_path agent_dir', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Daemon detaches AFTER setup: the next dispatch (backfill provision)
    // fails with a transport error → fail-closed, no fallback.
    t.fakeHostWs!.sendCommandError = new HostWsCommandTransportError(
      'transport_no_connection',
      'host runtime detached',
      { hostId: 'local', commandKind: 'workspace_provision', requestId: 'r' },
    );

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.code).toBe('host_attach_pending');
    // No fabricated workspace list / agent_dir leaked.
    expect(body.workspaces).toBeUndefined();
  });

  it('daemon reports unresolved → fail-closed (409 workspace_unresolved), no agent_dir in response', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Daemon cannot resolve the regular workspace (no registry binding).
    t.fakeHostWs!.agentWorkspaceIndexAckOverride = params => ({
      ok: true as const,
      entries: [],
      unresolved: params.workspace_ids,
    });

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.code).toBe('workspace_unresolved');
    expect(body.error).toContain(reg.workspaceId);
    expect(body.workspaces).toBeUndefined();
  });

  it("cross-host membership set resolves against the AGENT's host; unprovisioned guest rows degrade to agent_dir null; home path never legacy-bound (#task:1600)", async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    // Cross-computer membership: a second host + a regular workspace on it
    // that alice is a member of. Since #task:1600 this is a LEGAL state
    // (the old 409 workspace_host_ambiguous defended the retired I4
    // same-host invariant). Resolution now targets alice's OWN daemon.
    const db = t.ctx.db;
    const now = Date.now();
    db.prepare(
      `INSERT INTO hosts (id, name, kind, created_at) VALUES (?, ?, 'remote', ?)`,
    ).run('host-other', 'other-host', now);
    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path,
         workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
    ).run('ws-other-host', 'other-ws', '/tmp/other', 'host-other', now, now);
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run('ws-other-host', alice.agentId, now);
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));

    // #task:1600 piece ②: the unprovisioned guest row degrades PER-ENTRY
    // to `agent_dir: null` ("unavailable on this computer") — the response
    // succeeds, same-host rows still resolve, and no path is fabricated.
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const guest = body.workspaces.find((w: any) => w.id === 'ws-other-host');
    expect(guest).toBeDefined();
    expect(guest.agent_dir).toBeNull();
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    expect(typeof regular.agent_dir).toBe('string');

    // Load-bearing #task:1600 pin: the guest workspace's HOME-computer
    // `workspace_path` must never be dispatched as a legacy re-bind
    // (`workspace_provision` requested_path) onto ALICE's daemon.
    const provisioned = t.fakeHostWs!.calls
      .filter(c => c.kind === 'workspace_provision')
      .map(c => c.params.workspace_id);
    expect(provisioned).not.toContain('ws-other-host');
    expect(provisioned).toContain(reg.workspaceId);
  });

  it('exposes archived flag and immutable identity fields on each entry', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    await http(t).patch(`/api/workspaces/${reg.workspaceId}/archive`, {
      archived: true,
    });

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    const body = await res.json() as any;
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    expect(regular).toMatchObject({
      id: reg.workspaceId,
      name: 'team-x',
      kind: 'regular',
      archived: true,
    });
    expect(typeof regular.updated_at).toBe('number');
    expect(typeof regular.agent_dir).toBe('string');

    const home = body.workspaces.find((w: any) => w.id === alice.agentHomeWorkspaceId);
    expect(home.archived).toBe(false);
  });

  it('backfill binds ARCHIVED legacy regular rows too → list returns daemon-stamped agent_dir, not 409 unresolved', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    // Drop create-time fan-out so we observe only the list path below.
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    // Forge a LEGACY archived regular workspace: a row that exists with a
    // cached workspace_path but has NO registry binding (never provisioned),
    // and is already archived. It must be on the SAME host as alice's other
    // workspaces (else the single-host invariant fires first). The backfill
    // must enumerate archived rows too and bind them, so the list resolves
    // a daemon-stamped agent_dir rather than failing closed on `unresolved`.
    const db = t.ctx.db;
    const hostId = (
      db
        .prepare('SELECT workspace_host_id AS h FROM workspaces WHERE id = ?')
        .get(reg.workspaceId) as { h: string }
    ).h;
    const legacyDir = mkdtempSync(join(tmpdir(), 'sh-legacy-arch-'));
    const now = Date.now();
    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path,
         workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', ?, ?, NULL, ?, ?, ?)`,
    ).run('ws-legacy-arch', 'legacy-arch', legacyDir, hostId, now, now, now);
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run('ws-legacy-arch', alice.agentId, now);

    try {
      const res = await http(t).get(
        listWorkspacesPath(alice.dmChannelId, alice.agentId),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      const arch = body.workspaces.find((w: any) => w.id === 'ws-legacy-arch');
      expect(arch).toBeDefined();
      expect(arch.archived).toBe(true);
      // Resolved (not unresolved) and daemon-stamped from the bound path.
      expect(arch.agent_dir).toBe(
        join(legacyDir, '.silverhand', 'agents', alice.agentId),
      );
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('a same-host NON-MEMBER legacy regular row never enters the current agent backfill (P1-2 scope)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Drop create-time fan-out so we observe only the list path.
    t.fakeHostWs!.calls.length = 0;

    // Insert a same-host regular workspace alice is NOT a member of, with NO
    // registry binding. Pre-fix the backfill enumerated EVERY regular row on
    // the host, so this unbound stranger row would dispatch (and a bad path
    // could fail-close alice's whole list). Now backfill is scoped to alice's
    // VISIBLE regular rows, so the stranger is never touched.
    const db = t.ctx.db;
    const hostId = (
      db
        .prepare('SELECT workspace_host_id AS h FROM workspaces WHERE id = ?')
        .get(reg.workspaceId) as { h: string }
    ).h;
    const now = Date.now();
    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind, workspace_path,
         workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
    ).run('ws-stranger', 'stranger', '/nonexistent/stranger/path', hostId, now, now);

    const res = await http(t).get(
      listWorkspacesPath(alice.dmChannelId, alice.agentId),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ids = body.workspaces.map((w: any) => w.id);
    expect(ids).toContain(reg.workspaceId);
    expect(ids).not.toContain('ws-stranger');
    // The stranger row was never provisioned during alice's list.
    const provisioned = t.fakeHostWs!.calls
      .filter(c => c.kind === 'workspace_provision')
      .map(c => c.params.workspace_id);
    expect(provisioned).not.toContain('ws-stranger');
  });

  it('list_channels defaults to source workspace, returns workspace_id in payload', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const extra = await createChannel(t, reg.workspaceId, 'extra', [alice.agentId]);

    // Source conversation = alice's own DM (agent_home), so default
    // list_channels should return the agent_home channels (the DM),
    // NOT the regular workspace channels.
    const fromHome = await http(t).get(
      listChannelsPath(alice.dmChannelId, alice.agentId),
    );
    expect(fromHome.status).toBe(200);
    const homeBody = await fromHome.json() as any;
    expect(homeBody.workspace_id).toBe(alice.agentHomeWorkspaceId);
    expect(homeBody.channels.map((c: any) => c.id)).toContain(alice.dmChannelId);
    expect(homeBody.channels.map((c: any) => c.id)).not.toContain(extra);
  });

  it('list_channels(workspace_id) lets agent_home source reach a regular workspace it is a member of', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const extra = await createChannel(t, reg.workspaceId, 'extra', [alice.agentId]);

    const res = await http(t).get(
      `${listChannelsPath(alice.dmChannelId, alice.agentId)}?workspace_id=${reg.workspaceId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workspace_id).toBe(reg.workspaceId);
    const ids = body.channels.map((c: any) => c.id);
    expect(ids).toContain(reg.onboardingChannelId);
    expect(ids).toContain(extra);
    // Should NOT include alice's DM (different workspace).
    expect(ids).not.toContain(alice.dmChannelId);
  });

  it('list_channels(workspace_id) rejects workspaces the agent is not a member of with 403', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const bobOnly = await createRegularWorkspace(t, 'bob-only', [bob.agentId]);

    const res = await http(t).get(
      `${listChannelsPath(alice.dmChannelId, alice.agentId)}?workspace_id=${bobOnly.workspaceId}`,
    );
    expect(res.status).toBe(403);
  });

  it('list_channels(workspace_id) rejects another agent\'s agent_home with 403', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');

    const res = await http(t).get(
      `${listChannelsPath(alice.dmChannelId, alice.agentId)}?workspace_id=${bob.agentHomeWorkspaceId}`,
    );
    expect(res.status).toBe(403);
  });

  it('list_channels(workspace_id) accepts the source workspace explicitly (no membership check needed)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const onboardingDmConv = reg.onboardingChannelId;

    // Source = the regular workspace's onboarding channel; explicit
    // workspace_id matching the source must succeed even though the
    // canAgentAccessWorkspace fast-path is skipped.
    const res = await http(t).get(
      `${listChannelsPath(onboardingDmConv, alice.agentId)}?workspace_id=${reg.workspaceId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workspace_id).toBe(reg.workspaceId);
    expect(body.channels.map((c: any) => c.id)).toContain(onboardingDmConv);
  });
});
