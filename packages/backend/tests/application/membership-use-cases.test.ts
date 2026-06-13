import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CAPABILITIES } from '@silverhand/shared';
import type { Principal } from '../../src/auth/principal.js';
import { addConversationMember } from '../../src/application/conversation-member.js';
import { addWorkspaceAgentMember } from '../../src/application/add-workspace-agent-member.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { MembershipService } from '../../src/services/membership-service.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Application-level tests for the two membership use cases extracted in
 * #task:961 (`docs/use-case-layer-p0-spec.md`). The route suites
 * (`tests/routes/conversation-members.test.ts`,
 * `tests/routes/agent-capabilities.test.ts`) already pin the HTTP-mapped
 * behavior; these tests call the use cases DIRECTLY so the application
 * contract is pinned independent of Hono — typed result branches,
 * authorization living in the use case, the `created`-only capability seed
 * / no-silent-re-widen rule, pre-commit precondition failures leaving NO
 * persisted residue, and post-commit effect ordering (events drain only
 * after the DB commit, never as a phantom on a rolled-back insert).
 */

// ── shared fixture helpers (mirror the route-suite setup) ───────────────

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id;
}

async function createRegularWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.workspace.id;
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = (await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json()) as any;
  return created.channel.id;
}

function conversationDeps(t: TestApp) {
  const agents = new AgentRepo(t.ctx.db);
  const users = new UserRepo(t.ctx.db);
  const workspaces = new WorkspaceRepo(t.ctx.db, {
    workspacesRoot: t.ctx.workspacesRoot,
  });
  const conversations = new ConversationRepo(t.ctx.db);
  const messages = new MessageRepo(t.ctx.db);
  const membership = new MembershipService({ agents, users, conversations });
  return { ctx: t.ctx, agents, users, workspaces, conversations, messages, membership };
}

function workspaceAgentDeps(t: TestApp) {
  return {
    ctx: t.ctx,
    agents: new AgentRepo(t.ctx.db),
    workspaces: new WorkspaceRepo(t.ctx.db, {
      workspacesRoot: t.ctx.workspacesRoot,
    }),
  };
}

const LOCAL_USER: Principal = { kind: 'user', userId: 'local' };

/**
 * Subscribe to BOTH the conversation bus and the workspace scope, pushing
 * every event into a single ordered array. The bus is synchronous, so the
 * array records the exact relative order publishMemberAdded emits in —
 * which is what spec §7 ruling ⑥ pins.
 */
function captureOrderedEvents(
  t: TestApp,
  conversationId: string,
  workspaceId: string,
): { events: string[]; stop: () => void } {
  const events: string[] = [];
  const offConv = t.ctx.events.subscribe(conversationId, e => events.push(e.kind));
  const offWs = t.ctx.events.subscribeScope(`workspace:${workspaceId}`, e =>
    events.push(e.kind),
  );
  return {
    events,
    stop: () => {
      offConv();
      offWs();
    },
  };
}

describe('AddConversationMemberUseCase (application layer)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('adds a workspace agent and drains post-commit events in spec order', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'team', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'agent', agent_id: bob },
    });
    cap.stop();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(
      result.members.filter(m => m.kind === 'agent').map(m => (m as any).agent_id),
    ).toEqual(expect.arrayContaining([alice, bob]));
    // Spec §7 ruling ⑥: message → conversation_members_changed →
    // workspace_channels_changed, all AFTER the DB commit.
    expect(cap.events).toEqual([
      'message',
      'conversation_members_changed',
      'workspace_channels_changed',
    ]);
  });

  it('lets a channel-member agent principal add another member (actor snapshot is the agent)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'agent-add', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    const events: Array<{ kind: string; payload: unknown }> = [];
    const off = t.ctx.events.subscribe(channelId, e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: { kind: 'agent', agentId: alice, conversationId: channelId },
      member: { kind: 'agent', agent_id: bob },
    });
    off();

    expect(result.ok).toBe(true);
    const message = events.find(e => e.kind === 'message');
    expect((message?.payload as any)?.message).toMatchObject({
      from_kind: 'system',
      metadata: { actor_kind: 'agent', actor_id: alice, member_id: bob },
    });
  });

  it('returns forbidden for a non-admin user WITHOUT writing a row or emitting an event', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'role-gate', [alice, bob]);
    const channelId = await createChannel(t, ws, 'governed', [alice]);
    // `local` is a channel member but only a workspace `member` — the
    // governance write requires the admin effective role.
    t.ctx.db
      .prepare(
        `UPDATE workspace_users SET role = 'member' WHERE workspace_id = ? AND user_id = 'local'`,
      )
      .run(ws);
    const deps = conversationDeps(t);
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'agent', agent_id: bob },
    });
    cap.stop();

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(deps.conversations.getAgent(channelId, bob)).toBeNull();
    expect(cap.events).toEqual([]);
  });

  it('returns forbidden for an agent principal that is not a member of the target conversation', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'agent-outsider', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);

    // bob is a workspace member but NOT a channel member → cannot self-add.
    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: { kind: 'agent', agentId: bob, conversationId: channelId },
      member: { kind: 'agent', agent_id: bob },
    });

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
  });

  it('maps not-found / unsupported / closed to typed errors', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'typed-errors', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);

    const missing = await addConversationMember(deps, {
      conversationId: 'nope',
      principal: LOCAL_USER,
      member: { kind: 'agent', agent_id: bob },
    });
    expect(missing).toEqual({
      ok: false,
      error: { code: 'conversation_not_found' },
    });

    // A DM channel is not a channel/thread → unsupported.
    const dm = (await (
      await http(t).get('/api/workspaces')
    ).json()) as any;
    const dmChannel = t.ctx.db
      .prepare<[], { id: string }>(
        `SELECT id FROM conversations WHERE kind = 'dm_channel' LIMIT 1`,
      )
      .get();
    expect(dm).toBeTruthy();
    if (dmChannel) {
      const unsupported = await addConversationMember(deps, {
        conversationId: dmChannel.id,
        principal: LOCAL_USER,
        member: { kind: 'agent', agent_id: bob },
      });
      expect(unsupported).toEqual({
        ok: false,
        error: { code: 'conversation_member_add_unsupported' },
      });
    }

    t.ctx.db
      .prepare(`UPDATE conversations SET closed_at = ? WHERE id = ?`)
      .run(1, channelId);
    const closed = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'agent', agent_id: bob },
    });
    expect(closed).toEqual({
      ok: false,
      error: { code: 'conversation_closed' },
    });
  });

  it('auto-adds a non-workspace agent to the workspace before adding them to the channel', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'agent-auto-workspace', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'agent', agent_id: bob },
    });
    cap.stop();

    expect(result.ok).toBe(true);
    expect(deps.workspaces.isMember(ws, bob)).toBe(true);
    expect(deps.conversations.getAgent(channelId, bob)).not.toBeNull();
    expect([...new AgentCapabilityRepo(t.ctx.db).list(ws, bob)].sort()).toEqual(
      [...AGENT_CAPABILITIES].sort(),
    );
    expect(cap.events).toEqual([
      'message',
      'conversation_members_changed',
      'workspace_channels_changed',
    ]);
  });

  it('auto-adds a non-workspace human to the workspace before adding them to the channel', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'human-auto-workspace', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(ws, 'teammate');
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    const cap = captureOrderedEvents(t, channelId, ws);
    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const offViewer = t.ctx.events.subscribeScope('viewer:teammate', e =>
      viewerEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'human', user_id: 'teammate' },
    });
    cap.stop();
    offViewer();

    expect(result.ok).toBe(true);
    expect(deps.workspaces.isUserMember(ws, 'teammate')).toBe(true);
    expect(deps.conversations.getUser(channelId, 'teammate')).not.toBeNull();
    expect(viewerEvents).toContainEqual({
      kind: 'viewer_workspaces_changed',
      payload: {
        change: 'added',
        workspace_id: ws,
        role: 'member',
      },
    });
    expect(cap.events).toEqual([
      'message',
      'conversation_members_changed',
      'workspace_channels_changed',
    ]);
  });

  it('lets workspace admins auto-provision non-workspace humans', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'human-auto-workspace-admin', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'admin' WHERE workspace_id = ? AND user_id = ?`)
      .run(ws, 'local');
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(ws, 'teammate');
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'human', user_id: 'teammate' },
    });

    expect(result.ok).toBe(true);
    expect(deps.workspaces.isUserMember(ws, 'teammate')).toBe(true);
    expect(deps.conversations.getUser(channelId, 'teammate')).not.toBeNull();
  });

  it('does not let an agent principal auto-add a non-workspace human', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'agent-no-human-auto-workspace', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(ws, 'teammate');
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: { kind: 'agent', agentId: alice, conversationId: channelId },
      member: { handle: '@teammate-test' },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'workspace_membership_required' },
    });
    expect(deps.workspaces.isUserMember(ws, 'teammate')).toBe(false);
    expect(deps.conversations.getUser(channelId, 'teammate')).toBeNull();
  });

  it('does not let an agent principal auto-add a non-workspace agent', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'agent-no-agent-auto-workspace', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: { kind: 'agent', agentId: alice, conversationId: channelId },
      member: { handle: '@bob' },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'workspace_membership_required' },
    });
    expect(deps.workspaces.isMember(ws, bob)).toBe(false);
    expect(deps.conversations.getAgent(channelId, bob)).toBeNull();
    expect(new AgentCapabilityRepo(t.ctx.db).list(ws, bob)).toEqual([]);
  });

  it('is a duplicate-safe no-op: re-adding an existing member emits no phantom event', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'idempotent', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    const cap = captureOrderedEvents(t, channelId, ws);

    // alice is already a channel member.
    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'agent', agent_id: alice },
    });
    cap.stop();

    expect(result.ok).toBe(true);
    expect(cap.events).toEqual([]);
    const auditRows = t.ctx.db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) AS count FROM messages
          WHERE conversation_id = ?
            AND json_extract(metadata, '$.subtype') = 'conversation_member_added'`,
      )
      .get(channelId);
    expect(auditRows?.count).toBe(0);
  });

  it('never emits a phantom event when the in-tx insert throws (rollback safety)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'rollback', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    // Force the message insert (inside the UoW, after addAgent) to throw so
    // the transaction rolls back. The throw happens inside db.transaction()()
    // — BEFORE the effect is ever collected — so no effect exists to drain
    // and no phantom event can reach the bus.
    vi.spyOn(deps.messages, 'insertForConversation').mockImplementation(() => {
      throw new Error('boom');
    });
    const cap = captureOrderedEvents(t, channelId, ws);

    await expect(
      addConversationMember(deps, {
        conversationId: channelId,
        principal: LOCAL_USER,
        member: { kind: 'agent', agent_id: bob },
      }),
    ).rejects.toThrow('boom');
    cap.stop();

    // The membership row was rolled back with the message insert, and no
    // event reached the bus.
    expect(deps.conversations.getAgent(channelId, bob)).toBeNull();
    expect(cap.events).toEqual([]);
  });
});

describe('AddWorkspaceAgentMemberUseCase (application layer)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  function workspaceRow(t: TestApp, workspaceId: string) {
    const ws = new WorkspaceRepo(t.ctx.db, {
      workspacesRoot: t.ctx.workspacesRoot,
    }).get(workspaceId)!;
    return {
      id: ws.id,
      workspace_path: ws.workspace_path,
      workspace_host_id: ws.workspace_host_id,
    };
  }

  it('seeds the full default capability set in the same transaction on first add', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'seed', [alice]);
    const deps = workspaceAgentDeps(t);

    const result = await addWorkspaceAgentMember(deps, {
      workspace: workspaceRow(t, ws),
      agentId: bob,
    });

    expect(result.ok).toBe(true);
    expect(deps.workspaces.isMember(ws, bob)).toBe(true);
    const caps = new AgentCapabilityRepo(t.ctx.db).list(ws, bob);
    expect([...caps].sort()).toEqual([...AGENT_CAPABILITIES].sort());
  });

  it('does not re-widen a narrowed cap set when re-adding an existing member', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'no-rewiden', [alice]);
    const deps = workspaceAgentDeps(t);
    const caps = new AgentCapabilityRepo(t.ctx.db);
    // alice is seeded full at create; narrow her, then re-run the use case.
    caps.replaceSet(ws, alice, ['read_messages']);

    const result = await addWorkspaceAgentMember(deps, {
      workspace: workspaceRow(t, ws),
      agentId: alice,
    });

    expect(result.ok).toBe(true);
    expect(caps.list(ws, alice)).toEqual(['read_messages']);
  });

  it('returns agent_not_found for an unknown agent', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'missing-agent', [alice]);
    const deps = workspaceAgentDeps(t);

    const result = await addWorkspaceAgentMember(deps, {
      workspace: workspaceRow(t, ws),
      agentId: 'nope',
    });
    expect(result).toEqual({ ok: false, error: { code: 'agent_not_found' } });
  });

  it('fails closed on a placement mismatch, persisting NO membership or caps', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'placement', [alice]);
    const deps = workspaceAgentDeps(t);
    // Pre-commit precondition: bob's host does not match this (wrong) host.
    const result = await addWorkspaceAgentMember(deps, {
      workspace: {
        ...workspaceRow(t, ws),
        workspace_host_id: 'some-other-host',
      },
      agentId: bob,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('placement');
    // Nothing was written: placement is asserted BEFORE the UoW.
    expect(deps.workspaces.isMember(ws, bob)).toBe(false);
    expect(new AgentCapabilityRepo(t.ctx.db).list(ws, bob)).toEqual([]);
  });
});
