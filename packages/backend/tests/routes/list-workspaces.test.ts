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

  it('agent_dir is kind-branched: agent_home resolves to its L1 home, an unprovisioned regular workspace degrades to null (§3.4)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    const body = await res.json() as any;
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    const home = body.workspaces.find((w: any) => w.id === alice.agentHomeWorkspaceId);

    expect(regular.kind).toBe('regular');
    expect(home.kind).toBe('agent_home');

    // relocation-v1 §3.4 — a regular workspace is no longer provisioned at
    // create, so the daemon index leaves it unresolved and the list degrades
    // it to `agent_dir: null` ("not materialized on this computer yet"). Its
    // stamped value once materialized is pinned via the daemon override in the
    // "daemon-stamped ... verbatim" test below.
    expect(regular.agent_dir).toBeNull();
    // agent_home still resolves to the agent's L1 home (no nested workspace
    // `.silverhand`): only regular rows can degrade now.
    expect(home.agent_dir.endsWith(`/agents/${alice.agentId}`)).toBe(true);
    expect(home.agent_dir).not.toContain('/.silverhand/');
  });

  // ── D4.e-1 3b-3: daemon-stamped agent_dir + fail-closed ───────────────
  // The value is resolved by the daemon (`agent_workspace_index`); the backend
  // never assembles a host path of its own (the DB column it once assembled
  // from is gone entirely). These pin that wiring.

  it('agent_dir is daemon-stamped: the response uses the daemon index value verbatim', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    // Force a sentinel agent_dir from the daemon — a value the backend could
    // never derive on its own — and assert it survives to the DTO.
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

  it('#task:1612 — list dispatches ONLY agent_workspace_index on the read path', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Drop create-time fan-out so we observe ONLY the list path.
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    expect(res.status).toBe(200);

    const indexCalls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'agent_workspace_index',
    );
    expect(indexCalls).toHaveLength(1);
  });

  it('daemon offline → fail-closed (503), never falls back to a backend-fabricated agent_dir', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Daemon detaches AFTER setup: the next dispatch (the index) fails
    // with a transport error → fail-closed, no fallback.
    t.fakeHostWs!.sendCommandError = new HostWsCommandTransportError(
      'transport_no_connection',
      'host runtime detached',
      { hostId: 'local', commandKind: 'agent_workspace_index', requestId: 'r' },
    );

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.code).toBe('host_attach_pending');
    // No fabricated workspace list / agent_dir leaked.
    expect(body.workspaces).toBeUndefined();
  });

  it('daemon reports unresolved → degrades that entry to agent_dir null (no fail-closed 409) (§3.4)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Daemon cannot resolve the regular workspace (never provisioned / not
    // materialized on this computer yet).
    t.fakeHostWs!.agentWorkspaceIndexAckOverride = params => ({
      ok: true as const,
      entries: params.workspace_ids
        .filter(id => id !== reg.workspaceId)
        .map(workspace_id => ({
          workspace_id,
          agent_dir: `/resolved/${workspace_id}`,
        })),
      unresolved: [reg.workspaceId],
    });

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    // relocation-v1 §3.4 — a regular workspace has no home computer, so an
    // unresolved id is the EXPECTED "not materialized here yet" state, not a
    // registry inconsistency: the entry degrades to `agent_dir: null` and the
    // response still succeeds (the old same-home 409 fail-closed is retired).
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    expect(regular.agent_dir).toBeNull();
  });

  it("a membership set resolves against the AGENT's own daemon; unmaterialized guest rows degrade to agent_dir null; home path never legacy-bound (#task:1600)", async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    // A second regular workspace alice is a member of, inserted directly (no
    // create-time fan-out). relocation-v1 §7-4 (#task:1808): the "workspace on
    // ANOTHER host" framing this fixture used is unstateable now — a workspace
    // has no home computer at all, so there is no host axis to diverge on. The
    // surviving axis (an AGENT on another computer) is pinned in
    // `tests/application/cross-computer-membership.test.ts`. What this test
    // still pins is the resolution target: alice's OWN daemon, per visible row.
    const db = t.ctx.db;
    const now = Date.now();
    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind,
         owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', NULL, NULL, ?, ?)`,
    ).run('ws-other-host', 'other-ws', now, now);
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run('ws-other-host', alice.agentId, now);
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));

    // #task:1600 / §3.4: a guest membership row is a LEGAL 200 (the old 409
    // workspace_host_ambiguous defended the retired I4 same-host invariant).
    // Neither row is provisioned at create any more, so both degrade PER-ENTRY
    // to `agent_dir: null` ("not materialized on this computer yet") — the
    // response succeeds and no path is ever fabricated.
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const guest = body.workspaces.find((w: any) => w.id === 'ws-other-host');
    expect(guest).toBeDefined();
    expect(guest.agent_dir).toBeNull();
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    expect(regular.agent_dir).toBeNull();
    void reg;
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
    // Unprovisioned at create → agent_dir degrades to null (§3.4).
    expect(regular.agent_dir).toBeNull();

    const home = body.workspaces.find((w: any) => w.id === alice.agentHomeWorkspaceId);
    expect(home.archived).toBe(false);
  });

  it('#task:1612 / §3.4 — an unmaterialized row degrades to agent_dir null (no fail-closed, no healing, no provision)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    // Drop create-time fan-out so we observe only the list path below.
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    // relocation-v1 §3.4 — a regular workspace has no home computer, so a row
    // the daemon cannot resolve is the EXPECTED "not materialized here yet"
    // state, NOT a data inconsistency. The list degrades it to `agent_dir: null`
    // (no 409 fail-closed) and never heals it from a DB path nor mints a fresh
    // root. §7-4 (#task:1808): the row no longer carries a host at all, so the
    // fixture inserts it without one — the "same-host" qualifier this test used
    // to make is unstateable.
    const db = t.ctx.db;
    const now = Date.now();
    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind,
         owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', NULL, ?, ?, ?)`,
    ).run('ws-legacy-arch', 'legacy-arch', now, now, now);
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
        VALUES (?, ?, ?)`,
    ).run('ws-legacy-arch', alice.agentId, now);

    t.fakeHostWs!.calls.length = 0;
    const res = await http(t).get(
      listWorkspacesPath(alice.dmChannelId, alice.agentId),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const legacy = body.workspaces.find((w: any) => w.id === 'ws-legacy-arch');
    expect(legacy).toBeDefined();
    expect(legacy.agent_dir).toBeNull();
    void reg;
  });

  it('a NON-MEMBER unmaterialized regular row never affects the current agent list (per-visible-row scope)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Drop create-time fan-out so we observe only the list path.
    t.fakeHostWs!.calls.length = 0;

    // Insert a regular workspace alice is NOT a member of and that is not
    // materialized anywhere. The list resolves only alice's VISIBLE rows, so
    // this stranger row is never dispatched and can never fail-close alice's
    // list (#task:1612: it is never provisioned either).
    const db = t.ctx.db;
    const now = Date.now();
    db.prepare(
      `INSERT INTO workspaces
        (id, name, description, workspace_kind,
         owner_agent_id, archived_at, created_at, updated_at)
        VALUES (?, ?, NULL, 'regular', NULL, NULL, ?, ?)`,
    ).run('ws-stranger', 'stranger', now, now);

    const res = await http(t).get(
      listWorkspacesPath(alice.dmChannelId, alice.agentId),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ids = body.workspaces.map((w: any) => w.id);
    expect(ids).toContain(reg.workspaceId);
    expect(ids).not.toContain('ws-stranger');
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
