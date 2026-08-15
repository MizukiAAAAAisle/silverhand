import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CAPABILITIES, conversationSideScope } from '@silverhand/shared';
import type { Principal } from '../../src/auth/principal.js';
import {
  addConversationMember,
  joinPublicChannel,
  leaveChannel,
  removeConversationHumanMember,
  removeConversationMember,
} from '../../src/application/conversation-member.js';
import { addWorkspaceAgentMember } from '../../src/application/add-workspace-agent-member.js';
import { addWorkspaceHumanMember } from '../../src/application/add-workspace-human-member.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createSqliteMembershipPersistence } from '../../src/repos/membership-persistence.js';
import type {
  MembershipPersistence,
  MembershipTxScope,
} from '../../src/application/membership-ports.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { ChannelAttentionPreferenceRepo } from '../../src/repos/channel-attention-preference-repo.js';
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

async function makeAgent(
  t: TestApp,
  name: string,
  sessionScope: 'agent' | 'conversation' = 'conversation',
): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', {
      name,
      runtime: 'claude',
      session_scope: sessionScope,
    })
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
  memberUserIds?: string[],
  visibility?: 'public' | 'private',
): Promise<string> {
  const created = (await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
      member_user_ids: memberUserIds,
      visibility,
    })
  ).json()) as any;
  return created.channel.id;
}

function conversationDeps(t: TestApp) {
  const agents = new AgentRepo(t.ctx.db);
  const users = new UserRepo(t.ctx.db);
  const workspaces = new WorkspaceRepo(t.ctx.db);
  const conversations = new ConversationRepo(t.ctx.db);
  const messages = new MessageRepo(t.ctx.db);
  const channelAttentionPrefs = new ChannelAttentionPreferenceRepo(t.ctx.db);
  const membership = new MembershipService({ agents, users, conversations });
  return {
    ctx: t.ctx,
    agents,
    users,
    workspaces,
    conversations,
    messages,
    channelAttentionPrefs,
    membershipPersistence: createSqliteMembershipPersistence(t.ctx.db),
    membership,
  };
}

/**
 * The real SQLite persistence with ONE face poisoned: the in-transaction audit
 * message insert throws. Wraps `atomically` rather than a repo because the
 * membership write core reaches persistence only through the scope, so this is
 * the sole injection point that can fail the commit half (#task:1987).
 */
function failingAuditPersistence(t: TestApp): MembershipPersistence {
  const real = createSqliteMembershipPersistence(t.ctx.db);
  return {
    read: real.read,
    uow: {
      ...real.uow,
      atomically: (key, fn) =>
        real.uow.atomically(key, (tx, anchor) =>
          fn(
            {
              authority: tx.authority,
              membership: {
                ...tx.membership,
                insertMembershipAuditMessage: () => {
                  throw new Error('boom');
                },
              },
              // One cast, at the seam where a synthetic scope meets the
              // kind-indexed scope type — the decorated port keeps the SAME
              // member kind, so no face is added or removed.
            } as MembershipTxScope as never,
            anchor,
          ),
        ),
    },
  };
}

/**
 * The real SQLite persistence with a WRITE injected into the one window the
 * design cannot close: after the use case's pre-lock reads, before the
 * coordinated transaction opens. Under this repo's single connection no other
 * writer can actually land there, so the seam is the only way to exhibit the
 * interleaving a pooled/PG adapter will allow — and it is a REAL committed write,
 * not a lie told to the callback: the anchor and the edge state the callback sees
 * are read from the DB under the lock, exactly as in production.
 *
 * It exists to pin WHERE the write decisions come from. A use case that carried
 * its pre-lock booleans into the callback passes every same-thread test and fails
 * these two.
 */
function interleavedPersistence(t: TestApp, interleave: () => void): MembershipPersistence {
  const real = createSqliteMembershipPersistence(t.ctx.db);
  return {
    read: real.read,
    uow: {
      ...real.uow,
      atomically: (key, fn) => {
        interleave();
        return real.uow.atomically(key, fn);
      },
    },
  };
}

function workspaceAgentDeps(t: TestApp) {
  return {
    ctx: t.ctx,
    agents: new AgentRepo(t.ctx.db),
    workspaces: new WorkspaceRepo(t.ctx.db),
    membershipPersistence: createSqliteMembershipPersistence(t.ctx.db),
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
  // Stage-2 P2: `message` rides the message-stream (compat) conversation
  // emitter; `conversation_members_changed` moved to the side-channel scope.
  // Subscribe both plus the workspace scope — post-commit emits are synchronous
  // in source order, so the merged array still captures the spec §7 sequence.
  const offConv = t.ctx.events.subscribe(conversationId, e => events.push(e.kind));
  const offSide = t.ctx.events.subscribeScope(
    conversationSideScope(conversationId),
    e => events.push(e.kind),
  );
  const offWs = t.ctx.events.subscribeScope(`workspace:${workspaceId}`, e =>
    events.push(e.kind),
  );
  return {
    events,
    stop: () => {
      offConv();
      offSide();
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

  it('returns forbidden for a non-admin user adding a HUMAN, WITHOUT writing a row or emitting an event', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'role-gate', [alice, bob]);
    const channelId = await createChannel(t, ws, 'governed', [alice]);
    // `local` is a channel member but only a workspace `member`. The TARGET is a
    // human on purpose: since #task:1683 a plain channel member may add their
    // OWN agents, so an agent target no longer isolates the ROLE axis (`bob`
    // here was created by `local`). The people roster carries no ownership
    // factor, so it is the clean probe for "role insufficient".
    t.ctx.db
      .prepare(
        `UPDATE workspace_users SET role = 'member' WHERE workspace_id = ? AND user_id = 'local'`,
      )
      .run(ws);
    // This fixture seeds every fixture user into every workspace/conversation, so
    // clear the target's rows first — otherwise "no row was written" would be
    // pre-satisfied and prove nothing.
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'carol'`)
      .run(channelId);
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = 'carol'`)
      .run(ws);
    const deps = conversationDeps(t);
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'human', user_id: 'carol' },
    });
    cap.stop();

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(deps.conversations.getUser(channelId, 'carol')).toBeNull();
    expect(deps.workspaces.isUserMember(ws, 'carol')).toBe(false);
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
        `SELECT id FROM conversations WHERE roster_policy = 'fixed' LIMIT 1`,
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
    expect(deps.channelAttentionPrefs.get('teammate', channelId)?.mode).toBe(
      'mentions',
    );
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

  it('defaults later-added human channel members to mention-only attention', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'human-mention-default', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(ws, 'teammate');
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    // Channel creation / initial membership keeps absence-as-default (`all`);
    // only a later explicit add writes the mention-only preference.
    expect(deps.channelAttentionPrefs.get('local', channelId)).toBeUndefined();
    expect(
      deps.channelAttentionPrefs.getStoredMode('local', channelId),
    ).toBe('all');

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'human', user_id: 'teammate' },
    });

    expect(result.ok).toBe(true);
    expect(deps.conversations.getUser(channelId, 'teammate')).not.toBeNull();
    expect(
      deps.channelAttentionPrefs.getStoredMode('teammate', channelId),
    ).toBe('mentions');
  });

  it('does not rewrite attention preference when re-adding an existing human member', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'human-duplicate-pref', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    deps.conversations.addUser(channelId, 'teammate');
    deps.channelAttentionPrefs.upsert({
      viewerUserId: 'teammate',
      conversationId: channelId,
      mode: 'all',
    });

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'human', user_id: 'teammate' },
    });

    expect(result.ok).toBe(true);
    expect(
      deps.channelAttentionPrefs.getStoredMode('teammate', channelId),
    ).toBe('all');
  });

  it('does not overwrite an existing preference when a human is re-added after removal', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'human-readd-pref', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = conversationDeps(t);
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(ws, 'teammate');
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');
    deps.channelAttentionPrefs.upsert({
      viewerUserId: 'teammate',
      conversationId: channelId,
      mode: 'all',
    });

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'human', user_id: 'teammate' },
    });

    expect(result.ok).toBe(true);
    expect(deps.conversations.getUser(channelId, 'teammate')).not.toBeNull();
    expect(
      deps.channelAttentionPrefs.getStoredMode('teammate', channelId),
    ).toBe('all');
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
    // Force the audit-message insert (inside the UoW, after the conversation
    // edge) to throw so the transaction rolls back. The injection point is the
    // TX SCOPE, not a repo: since #task:1987 the use case holds no MessageRepo,
    // so the only way to fail the write half is to decorate the face the
    // callback actually calls. The throw happens inside `atomically` — BEFORE
    // the effect is ever collected — so no effect exists to drain and no
    // phantom event can reach the bus.
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: failingAuditPersistence(t),
    };
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

  it('auto-provision is ONE commit with the channel placement: a failed add leaves NO workspace enrollment', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const outsider = await makeAgent(t, 'outsider');
    // `outsider` is deliberately NOT an initial member, so this add must
    // auto-provision workspace membership on the way in.
    const ws = await createRegularWorkspace(t, 'atomic-enroll', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: failingAuditPersistence(t),
    };
    expect(deps.workspaces.isMember(ws, outsider)).toBe(false);

    await expect(
      addConversationMember(deps, {
        conversationId: channelId,
        principal: LOCAL_USER,
        member: { kind: 'agent', agent_id: outsider },
      }),
    ).rejects.toThrow('boom');

    // The invariant #task:1987 bought: before this, workspace enrollment
    // committed in its OWN transaction and only the channel placement rolled
    // back, leaving the agent enrolled in a workspace it had joined no channel
    // of — plus a capability set seeded for a membership nobody asked for.
    expect(deps.workspaces.isMember(ws, outsider)).toBe(false);
    expect(new AgentCapabilityRepo(t.ctx.db).list(ws, outsider)).toEqual([]);
    expect(deps.conversations.getAgent(channelId, outsider)).toBeNull();
  });

  it('re-enrolls when the workspace row disappears between the pre-lock read and the transaction', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    // bob IS a workspace member, so the use case's pre-lock read says "no
    // enrollment needed" — and then loses the race.
    const ws = await createRegularWorkspace(t, 'interleave-ws', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new WorkspaceRepo(t!.ctx.db).removeMember(ws, bob);
      }),
    };
    expect(deps.workspaces.isMember(ws, bob)).toBe(true);

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'agent', agent_id: bob },
    });

    expect(result.ok).toBe(true);
    // The state a stale `workspaceWasMember` produced: the conversation edge
    // written for an agent the workspace no longer holds — a dangling member no
    // serial order of add/remove can reach. The anchor is read under the lock, so
    // the callback sees the removal and enrolls (with its capability set) in the
    // same commit as the placement.
    expect(deps.workspaces.isMember(ws, bob)).toBe(true);
    expect([...new AgentCapabilityRepo(t.ctx.db).list(ws, bob)].sort()).toEqual(
      [...AGENT_CAPABILITIES].sort(),
    );
    expect(deps.conversations.getAgent(channelId, bob)).not.toBeNull();
  });

  it('emits no second audit message or event when the edge appears between the pre-lock read and the transaction', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'interleave-edge', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const messages = new MessageRepo(t.ctx.db);
    const before = messages.listForConversation(channelId).length;
    const deps = {
      ...conversationDeps(t),
      // The reverse direction: the pre-lock read finds no edge, but the member is
      // placed before the transaction opens.
      membershipPersistence: interleavedPersistence(t, () => {
        new ConversationRepo(t!.ctx.db).addAgent(channelId, bob);
      }),
    };
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'agent', agent_id: bob },
    });
    cap.stop();

    expect(result.ok).toBe(true);
    // Driven by the port's in-lock `created`, not by the stale read: a duplicate
    // "X added Y" system message and a duplicate member-added fan-out are exactly
    // what the old `alreadyMember` guard could not prevent.
    expect(messages.listForConversation(channelId).length).toBe(before);
    expect(cap.events).toEqual([]);
  });

  it('does not re-announce a human workspace add whose row appears before the transaction', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'interleave-human', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    // Through the repos, not native SQL: the neighbouring tests predate the
    // db-boundary ledger, and this one has no reason to add to it.
    new WorkspaceRepo(t.ctx.db).removeUserMember(ws, 'teammate');
    new ConversationRepo(t.ctx.db).removeUser(channelId, 'teammate');
    const deps = {
      ...conversationDeps(t),
      // teammate joins the workspace by another door between the pre-lock read
      // and the lock, so the anchor exists after the use case decided it did not.
      membershipPersistence: interleavedPersistence(t, () => {
        new WorkspaceRepo(t!.ctx.db).addUserMember(ws, 'teammate');
      }),
    };
    const viewerEvents: string[] = [];
    const offViewer = t.ctx.events.subscribeScope('viewer:teammate', e =>
      viewerEvents.push(e.kind),
    );

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: LOCAL_USER,
      member: { kind: 'human', user_id: 'teammate' },
    });
    offViewer();

    expect(result.ok).toBe(true);
    expect(deps.conversations.getUser(channelId, 'teammate')).not.toBeNull();
    // `viewer_workspaces_changed` announces a workspace membership THIS write
    // created. Driven by the stale pre-lock `false` it would fire for a row
    // somebody else already announced.
    expect(viewerEvents).toEqual([]);
  });
});

describe('AddWorkspaceAgentMemberUseCase (application layer)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /** relocation-v1 §7-4 — the use case takes the workspace's IDENTITY only: a
   *  workspace carries no host binding, so there is nothing else to pass. Still
   *  read through the repo so the ref is a real row, not a forged id. */
  function workspaceRow(t: TestApp, workspaceId: string) {
    const ws = new WorkspaceRepo(t.ctx.db).get(workspaceId)!;
    return { id: ws.id };
  }

  it('seeds the full default capability set in the same transaction on first add', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'seed', [alice]);
    const deps = workspaceAgentDeps(t);

    const result = await addWorkspaceAgentMember(deps, {
      principal: LOCAL_USER,
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
      principal: LOCAL_USER,
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
      principal: LOCAL_USER,
      workspace: workspaceRow(t, ws),
      agentId: 'nope',
    });
    expect(result).toEqual({ ok: false, error: { code: 'agent_not_found' } });
  });

  /**
   * relocation-v1 §7-4 (#task:1808) — the 'host-divergent workspace ref' guest
   * add that lived here is GONE, not silently dropped: a workspace no longer
   * has a `workspace_host_id`, so "the workspace claims another home computer"
   * is unstateable — there is no divergence left to construct. The surviving
   * cross-computer axis is the AGENT's computer, and that a guest add on
   * another computer is a pure DB write with zero daemon dispatch is pinned in
   * `tests/application/cross-computer-membership.test.ts`.
   */
});

/**
 * The removal / authority half of #task:1987, in the ONE window the design
 * cannot close: after a use case's pre-lock gate, before its coordinated
 * transaction opens.
 *
 * Every test here refuses or no-ops on a decision the pre-lock gate had already
 * ANSWERED THE OTHER WAY, so each one fails against an implementation that carries
 * its pre-lock booleans into the callback. The states they exclude are the ones NO
 * serial order of two legal requests produces:
 *  - a private channel with zero humans in it (`last_human_member`);
 *  - a roster write nobody currently authorizes (the actor was demoted, or removed
 *    from the channel, in the seam);
 *  - a second removal audit row / member-changed fan-out for an edge another
 *    request already deleted.
 * A merely STALE decision is not in scope: last-writer-wins is a legal outcome and
 * is deliberately left alone.
 */
describe('membership removal + authority revalidation inside the lock (#task:1987)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('removing one conversation target does not stop an AgentSlot shared by other targets', async () => {
    t = buildTestApp();
    const agent = await makeAgent(t, 'agent-slot-member', 'agent');
    const ws = await createRegularWorkspace(t, 'agent-slot-removal-ws', [agent]);
    const channelId = await createChannel(t, ws, 'room', [agent]);
    const deps = conversationDeps(t);
    t.fake.stops = [];

    const result = await removeConversationMember(deps, {
      conversationId: channelId,
      agentId: agent,
      principal: LOCAL_USER,
    });

    expect(result.ok).toBe(true);
    expect(deps.conversations.getAgent(channelId, agent)).toBeNull();
    expect(t.fake.stops).toEqual([]);
  });

  it('refuses a leave that strands a private channel: the other human leaves in the seam', async () => {
    // Seeding off: the permissive fixture triggers would put all eight fixture
    // users in the channel, and "the target is now the last human" needs a roster
    // small enough to become one.
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'strand-ws', [alice]);
    new WorkspaceRepo(t.ctx.db).addUserMember(ws, 'teammate');
    const channelId = await createChannel(t, ws, 'room', [alice], ['teammate']);
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new ConversationRepo(t!.ctx.db).removeUser(channelId, 'local');
      }),
    };
    // Pre-lock there are TWO humans, so the early gate lets teammate out.
    expect(deps.conversations.listUsers(channelId).map(u => u.user_id).sort()).toEqual([
      'local',
      'teammate',
    ]);
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await leaveChannel(deps, {
      conversationId: channelId,
      principal: { kind: 'user', userId: 'teammate' },
    });
    cap.stop();

    // Two humans both leaving is legal in either serial order — the SECOND is
    // refused. Only the in-lock evaluation can be that second one.
    expect(result).toEqual({ ok: false, error: { code: 'last_human_member' } });
    expect(deps.conversations.getUser(channelId, 'teammate')).not.toBeNull();
    expect(cap.events).toEqual([]);
  });

  it('refuses a third-party human removal whose actor is demoted in the seam', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'demote-ws', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const workspaces = new WorkspaceRepo(t.ctx.db);
    workspaces.setUserRole(ws, 'carol', 'admin');
    const messages = new MessageRepo(t.ctx.db);
    const before = messages.listForConversation(channelId).length;
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new WorkspaceRepo(t!.ctx.db).setUserRole(ws, 'carol', 'member');
      }),
    };
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await removeConversationHumanMember(deps, {
      conversationId: channelId,
      userId: 'teammate',
      principal: { kind: 'user', userId: 'carol' },
    });
    cap.stop();

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(deps.conversations.getUser(channelId, 'teammate')).not.toBeNull();
    expect(messages.listForConversation(channelId).length).toBe(before);
    expect(cap.events).toEqual([]);
  });

  it('refuses a third-party human removal whose target is promoted above the actor in the seam', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'rank-ws', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const workspaces = new WorkspaceRepo(t.ctx.db);
    workspaces.setUserRole(ws, 'carol', 'admin');
    const messages = new MessageRepo(t.ctx.db);
    const before = messages.listForConversation(channelId).length;
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        // A promotion, through the only repo face that can grant `owner`. It does
        // not demote the creating owner, so the workspace briefly holds two owner
        // ROWS — irrelevant here: the rank guard compares role rows, and this is
        // the cheapest way to exhibit a promotion landing in the seam.
        new WorkspaceRepo(t!.ctx.db).setOwnerUserId(ws, 'teammate');
      }),
    };
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await removeConversationHumanMember(deps, {
      conversationId: channelId,
      userId: 'teammate',
      principal: { kind: 'user', userId: 'carol' },
    });
    cap.stop();

    // The target's role comes from the ANCHOR, read under the mechanism — an admin
    // evicting an owner from a channel is exactly what the rank guard exists to stop.
    expect(result).toEqual({ ok: false, error: { code: 'target_outranks_actor' } });
    expect(deps.conversations.getUser(channelId, 'teammate')).not.toBeNull();
    expect(messages.listForConversation(channelId).length).toBe(before);
    expect(cap.events).toEqual([]);
  });

  it('writes no second audit or fan-out when a human edge is deleted in the seam', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'human-edge-ws', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const messages = new MessageRepo(t.ctx.db);
    const before = messages.listForConversation(channelId).length;
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new ConversationRepo(t!.ctx.db).removeUser(channelId, 'teammate');
      }),
    };
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await removeConversationHumanMember(deps, {
      conversationId: channelId,
      userId: 'teammate',
      principal: LOCAL_USER,
    });
    cap.stop();

    // The post-state the caller asked for already holds → success, but driven by
    // the port's in-lock `removed`: a second "X removed Y" audit row and a second
    // roster fan-out are a state no serial order of two removals produces.
    expect(result.ok).toBe(true);
    expect(deps.conversations.getUser(channelId, 'teammate')).toBeNull();
    expect(messages.listForConversation(channelId).length).toBe(before);
    expect(cap.events).toEqual([]);
  });

  it('refuses an agent removal whose actor loses their channel edge in the seam', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'agent-floor-ws', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice, bob]);
    const messages = new MessageRepo(t.ctx.db);
    const before = messages.listForConversation(channelId).length;
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new ConversationRepo(t!.ctx.db).removeUser(channelId, 'local');
      }),
    };
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await removeConversationMember(deps, {
      conversationId: channelId,
      agentId: bob,
      principal: LOCAL_USER,
    });
    cap.stop();

    // The visibility FLOOR is re-derived in-lock too, not just the governance half:
    // an actor who is no longer in the channel may not write its roster, however
    // senior they are in the workspace.
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(deps.conversations.getAgent(channelId, bob)).not.toBeNull();
    expect(messages.listForConversation(channelId).length).toBe(before);
    expect(cap.events).toEqual([]);
  });

  it('writes no second audit or fan-out when an agent edge is deleted in the seam', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'agent-edge-ws', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice, bob]);
    const messages = new MessageRepo(t.ctx.db);
    const before = messages.listForConversation(channelId).length;
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new ConversationRepo(t!.ctx.db).removeAgent(channelId, bob);
      }),
    };
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await removeConversationMember(deps, {
      conversationId: channelId,
      agentId: bob,
      principal: LOCAL_USER,
    });
    cap.stop();

    expect(result.ok).toBe(true);
    expect(deps.conversations.getAgent(channelId, bob)).toBeNull();
    expect(messages.listForConversation(channelId).length).toBe(before);
    expect(cap.events).toEqual([]);
  });

  it('refuses an ADD whose actor loses their channel edge in the seam', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await createRegularWorkspace(t, 'add-floor-ws', [alice, bob]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new ConversationRepo(t!.ctx.db).removeUser(channelId, 'local');
      }),
    };
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

  it('refuses a self-join whose workspace membership is removed in the seam, writing nothing', async () => {
    // Seeding off: the permissive fixture triggers would make `teammate` a member
    // of every conversation, so there would be no fresh join left to make.
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'join-ws', [alice]);
    new WorkspaceRepo(t.ctx.db).addUserMember(ws, 'teammate');
    const channelId = await createChannel(t, ws, 'lobby', [alice], undefined, 'public');
    const messages = new MessageRepo(t.ctx.db);
    // One message, so the join's read-cursor baseline has something to advance:
    // without a stream head `markStreamRead` is never called and the cursor
    // assertion below would hold for the wrong reason.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'system',
      content: 'welcome',
      metadata: {},
    });
    expect(messages.listStreamHeads(channelId).length).toBeGreaterThan(0);
    const reads = new ConversationReadRepo(t.ctx.db);
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new WorkspaceRepo(t!.ctx.db).removeUserMember(ws, 'teammate');
      }),
    };
    // Pre-lock the joiner IS a workspace member, so `canJoinPublicChannel` admits.
    expect(deps.workspaces.isUserMember(ws, 'teammate')).toBe(true);
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await joinPublicChannel(deps, {
      conversationId: channelId,
      principal: { kind: 'user', userId: 'teammate' },
    });
    cap.stop();

    // On a self-join the actor IS the member being written, so the ANCHOR is the
    // very authority fact the pre-lock gate read. Joining on an absent anchor
    // would leave a channel edge — plus an attention preference and read cursors —
    // for a non-member of the workspace: a state neither serial order reaches.
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(deps.conversations.getUser(channelId, 'teammate')).toBeNull();
    expect(deps.channelAttentionPrefs.get('teammate', channelId)).toBeUndefined();
    expect(reads.getLastReadSeq('teammate', channelId, null)).toBe(0);
    expect(cap.events).toEqual([]);
  });

  it('refuses a human auto-provision whose actor is demoted in the seam, enrolling nobody', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'provision-ws', [alice]);
    const workspaces = new WorkspaceRepo(t.ctx.db);
    workspaces.addUserMember(ws, 'carol', 'admin');
    const channelId = await createChannel(t, ws, 'room', [alice], ['carol']);
    const deps = {
      ...conversationDeps(t),
      membershipPersistence: interleavedPersistence(t, () => {
        new WorkspaceRepo(t!.ctx.db).setUserRole(ws, 'carol', 'member');
      }),
    };
    expect(deps.workspaces.isUserMember(ws, 'other')).toBe(false);
    const cap = captureOrderedEvents(t, channelId, ws);

    const result = await addConversationMember(deps, {
      conversationId: channelId,
      principal: { kind: 'user', userId: 'carol' },
      member: { kind: 'human', user_id: 'other' },
    });
    cap.stop();

    // Auto-provision is the widest thing a roster write does — it creates workspace
    // membership. Re-deriving `governs` in-lock is what keeps a demoted admin from
    // enrolling a person into a workspace they no longer govern.
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(deps.workspaces.isUserMember(ws, 'other')).toBe(false);
    expect(deps.conversations.getUser(channelId, 'other')).toBeNull();
    expect(cap.events).toEqual([]);
  });

  it('refuses a workspace human ADD whose actor is demoted in the seam, enrolling nobody', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'human-add-ws', [alice]);
    const workspaces = new WorkspaceRepo(t.ctx.db);
    workspaces.addUserMember(ws, 'carol', 'admin');
    const target = t.ctx.userService.getDto('other');
    if (!target) throw new Error('fixture user missing');
    const deps = {
      ctx: t.ctx,
      membershipPersistence: interleavedPersistence(t, () => {
        new WorkspaceRepo(t!.ctx.db).setUserRole(ws, 'carol', 'member');
      }),
    };
    // Pre-lock carol IS an admin, so the ROUTE's `canGovernWorkspace` gate admits.
    expect(workspaces.getUserRole(ws, 'carol')).toBe('admin');
    expect(workspaces.isUserMember(ws, target.id)).toBe(false);
    const viewerEvents: string[] = [];
    const offViewer = t.ctx.events.subscribeScope(`viewer:${target.id}`, e =>
      viewerEvents.push(e.kind),
    );

    const result = await addWorkspaceHumanMember(deps, {
      principal: { kind: 'user', userId: 'carol' },
      workspaceId: ws,
      user: target,
    });
    offViewer();

    // The route's gate is a snapshot; the write's authority is the role row read
    // inside the lock. Without that re-derivation a demoted admin still enrolls a
    // person — and the enrollment is announced — in a workspace they no longer
    // govern, which no serial order of demote-then-add reaches.
    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(workspaces.isUserMember(ws, target.id)).toBe(false);
    expect(viewerEvents).toEqual([]);
  });

  it('announces a workspace human ADD once when a racing add commits in the seam', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const alice = await makeAgent(t, 'alice');
    const ws = await createRegularWorkspace(t, 'human-add-race-ws', [alice]);
    const workspaces = new WorkspaceRepo(t.ctx.db);
    const target = t.ctx.userService.getDto('other');
    if (!target) throw new Error('fixture user missing');
    const deps = {
      ctx: t.ctx,
      membershipPersistence: interleavedPersistence(t, () => {
        // The OTHER request wins the race and enrolls them first.
        new WorkspaceRepo(t!.ctx.db).addUserMember(ws, target.id);
      }),
    };
    // Pre-lock they are NOT a member — the boolean the old route body would have
    // carried into the write.
    expect(workspaces.isUserMember(ws, target.id)).toBe(false);
    const viewerEvents: string[] = [];
    const offViewer = t.ctx.events.subscribeScope(`viewer:${target.id}`, e =>
      viewerEvents.push(e.kind),
    );

    const result = await addWorkspaceHumanMember(deps, {
      principal: LOCAL_USER,
      workspaceId: ws,
      user: target,
    });
    offViewer();

    // The add stays successful and idempotent, but `created` comes from the ANCHOR,
    // so the second request announces nothing: exactly one of two racing adds emits
    // `viewer_workspaces_changed`.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.member.role).toBe('member');
    expect(workspaces.isUserMember(ws, target.id)).toBe(true);
    expect(viewerEvents).toEqual([]);
  });
});
