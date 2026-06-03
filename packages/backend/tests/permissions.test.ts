import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canDeleteAttachment,
  canEditAgent,
  canViewAgent,
  canManageMembers,
  canMutateWorkspace,
  canPostToConversation,
  canSubscribeScope,
  canViewAttachment,
  canViewConversation,
  canViewOwnedState,
  canViewWorkspace,
  parseWsScope,
} from '../src/permissions.js';
import type { AgentPrincipal, Principal, UserPrincipal } from '../src/auth/principal.js';
import { AgentRepo } from '../src/repos/agent-repo.js';
import { AttachmentRepo } from '../src/repos/attachment-repo.js';
import { ConversationRepo } from '../src/repos/conversation-repo.js';
import { HostRepo } from '../src/repos/host-repo.js';
import { WorkspaceRepo } from '../src/repos/workspace-repo.js';
import { buildTestApp, type TestApp } from './utils/app.js';

function seed(t: TestApp) {
  const agents = new AgentRepo(t.ctx.db);
  const conversations = new ConversationRepo(t.ctx.db);
  const workspaces = new WorkspaceRepo(t.ctx.db, {
    workspacesRoot: t.ctx.workspacesRoot,
  });
  const attachments = new AttachmentRepo(t.ctx.db);
  const host = new HostRepo(t.ctx.db).ensureLocal();
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, host.id, 'local');
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, host.id, 'local');
  const workspace = workspaces.insert({
    name: `ws-${randomUUID().slice(0, 8)}`,
    description: null,
    workspacePath: join(t.ctx.workspacesRoot, 'workspace'),
    workspaceHostId: host.id,
  });
  workspaces.addMember(workspace.id, alice.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath: workspace.workspace_path,
    title: 'Main',
  });
  conversations.addAgent(channel.id, alice.id);
  const thread = conversations.insertThread({
    channelId: channel.id,
    title: 'Thread',
  });
  conversations.addAgent(thread.id, alice.id);
  const sibling = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath: workspace.workspace_path,
    title: 'Sibling',
  });
  return {
    agents,
    attachments,
    conversations,
    workspaces,
    host,
    alice,
    bob,
    workspace,
    channel,
    thread,
    sibling,
  };
}

describe('permission helpers', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('keeps v1 user access permissive behind workspace and conversation ACL functions', () => {
    t = buildTestApp();
    const f = seed(t);
    const user: UserPrincipal = { kind: 'user', userId: 'local' };

    expect(canViewWorkspace(t.ctx, user, f.workspace.id)).toBe(true);
    expect(canMutateWorkspace(t.ctx, user, f.workspace.id)).toBe(true);
    expect(canManageMembers(t.ctx, user, f.workspace.id)).toBe(true);
    expect(canViewConversation(t.ctx, user, f.channel.id)).toBe(true);
    expect(canViewConversation(t.ctx, user, f.thread.id)).toBe(true);
    expect(canPostToConversation(t.ctx, user, f.channel.id)).toBe(true);
    expect(canPostToConversation(t.ctx, { kind: 'system' }, f.channel.id)).toBe(true);

    expect(canViewWorkspace(t.ctx, user, 'missing-workspace')).toBe(false);
    expect(canViewConversation(t.ctx, user, 'missing-conversation')).toBe(false);
  });

  it('keeps agent access bound to its resolved conversation membership', () => {
    t = buildTestApp();
    const f = seed(t);
    const alice: AgentPrincipal = {
      kind: 'agent',
      agentId: f.alice.id,
      conversationId: f.channel.id,
    };
    const bob: AgentPrincipal = {
      kind: 'agent',
      agentId: f.bob.id,
      conversationId: f.channel.id,
    };

    expect(canViewWorkspace(t.ctx, alice, f.workspace.id)).toBe(true);
    expect(canViewConversation(t.ctx, alice, f.channel.id)).toBe(true);
    expect(canPostToConversation(t.ctx, alice, f.channel.id)).toBe(true);
    expect(canMutateWorkspace(t.ctx, alice, f.workspace.id)).toBe(false);
    expect(canManageMembers(t.ctx, alice, f.workspace.id)).toBe(false);

    expect(canViewConversation(t.ctx, alice, f.sibling.id)).toBe(false);
    expect(canViewWorkspace(t.ctx, bob, f.workspace.id)).toBe(false);
    expect(canViewConversation(t.ctx, bob, f.channel.id)).toBe(false);
  });

  it('models agent_home as owner-agent plus v1 local human viewable', () => {
    t = buildTestApp();
    const f = seed(t);
    const home = f.workspaces.insertAgentHome({
      agent: f.alice,
      workspacePath: join(t.ctx.silverhandDir, 'agents', f.alice.id),
    });
    const dm = f.conversations.insertDmChannel({
      workspaceId: home.id,
      workspacePath: home.workspace_path,
      title: 'Onboarding',
      agentId: f.alice.id,
    });
    f.conversations.addAgent(dm.id, f.alice.id);
    const owner: AgentPrincipal = {
      kind: 'agent',
      agentId: f.alice.id,
      conversationId: dm.id,
    };
    const nonOwner: AgentPrincipal = {
      kind: 'agent',
      agentId: f.bob.id,
      conversationId: f.channel.id,
    };
    const user: UserPrincipal = { kind: 'user', userId: 'local' };

    expect(canViewWorkspace(t.ctx, owner, home.id)).toBe(true);
    expect(canMutateWorkspace(t.ctx, owner, home.id)).toBe(false);
    expect(canViewWorkspace(t.ctx, nonOwner, home.id)).toBe(false);
    expect(canViewWorkspace(t.ctx, user, home.id)).toBe(true);
  });

  it('keeps attachment view/delete rules scoped by channel and creator', () => {
    t = buildTestApp();
    const f = seed(t);
    const user: UserPrincipal = { kind: 'user', userId: 'local' };
    const otherUser: UserPrincipal = { kind: 'user', userId: 'other' };
    const channelAgent: AgentPrincipal = {
      kind: 'agent',
      agentId: f.alice.id,
      conversationId: f.channel.id,
    };
    const threadAgent: AgentPrincipal = {
      kind: 'agent',
      agentId: f.alice.id,
      conversationId: f.thread.id,
    };
    const siblingAgent: AgentPrincipal = {
      kind: 'agent',
      agentId: f.alice.id,
      conversationId: f.sibling.id,
    };

    const userAttachment = f.attachments.insert({
      channelId: f.channel.id,
      sourceConversationId: f.channel.id,
      filename: 'u.txt',
      size: 1,
      contentType: 'text/plain',
      storage: 'local',
      storageKey: 'u',
      createdByKind: 'user',
      createdById: 'local',
    });
    const agentAttachment = f.attachments.insert({
      channelId: f.channel.id,
      sourceConversationId: f.channel.id,
      filename: 'a.txt',
      size: 1,
      contentType: 'text/plain',
      storage: 'local',
      storageKey: 'a',
      createdByKind: 'agent',
      createdById: f.alice.id,
    });

    expect(canViewAttachment(t.ctx, user, userAttachment)).toBe(true);
    expect(canDeleteAttachment(t.ctx, user, userAttachment)).toBe(true);
    expect(canDeleteAttachment(t.ctx, otherUser, userAttachment)).toBe(false);

    expect(canViewAttachment(t.ctx, channelAgent, agentAttachment)).toBe(true);
    expect(canViewAttachment(t.ctx, threadAgent, agentAttachment)).toBe(true);
    expect(canViewAttachment(t.ctx, siblingAgent, agentAttachment)).toBe(false);
    expect(canDeleteAttachment(t.ctx, channelAgent, agentAttachment)).toBe(true);
    expect(canDeleteAttachment(t.ctx, channelAgent, userAttachment)).toBe(false);
  });

  it('limits viewer-owned state to the matching user principal', () => {
    t = buildTestApp();
    const user: UserPrincipal = { kind: 'user', userId: 'local' };
    const other: UserPrincipal = { kind: 'user', userId: 'other' };
    const agent: AgentPrincipal = {
      kind: 'agent',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
    };
    const system: Principal = { kind: 'system' };

    expect(canViewOwnedState(t.ctx, user, 'local')).toBe(true);
    expect(canViewOwnedState(t.ctx, user, 'other')).toBe(false);
    expect(canViewOwnedState(t.ctx, other, 'local')).toBe(false);
    expect(canViewOwnedState(t.ctx, agent, 'local')).toBe(false);
    expect(canViewOwnedState(t.ctx, system, 'local')).toBe(true);
  });

  it('preserves WebSocket scope parsing and subscription checks', () => {
    t = buildTestApp();
    const f = seed(t);

    expect(parseWsScope('viewer:self', 'local')).toEqual({
      type: 'viewer',
      scope: 'viewer:local',
      viewerUserId: 'local',
    });
    expect(canSubscribeScope(t.ctx, 'local', {
      type: 'workspace',
      scope: `workspace:${f.workspace.id}`,
      workspaceId: f.workspace.id,
    })).toBe(true);
    expect(canSubscribeScope(t.ctx, 'local', {
      type: 'conversation',
      scope: `conversation:${f.channel.id}`,
      conversationId: f.channel.id,
    })).toBe(true);
    expect(canSubscribeScope(t.ctx, 'local', {
      type: 'viewer',
      scope: 'viewer:someone-else',
      viewerUserId: 'someone-else',
    })).toBe(false);
  });

  it('denies user access without explicit workspace_users / conversation_users membership (v25 tightening)', () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const f = seed(t);
    // Strict fixture mode disables the legacy auto-membership triggers,
    // matching the production requirement that route/service code writes
    // explicit workspace_users / conversation_users rows.

    const user: UserPrincipal = { kind: 'user', userId: 'local' };
    expect(canViewWorkspace(t.ctx, user, f.workspace.id)).toBe(false);
    expect(canViewConversation(t.ctx, user, f.channel.id)).toBe(false);

    // Re-adding only workspace membership (not conversation) reopens
    // workspace access but not conversation access — the gate is
    // parallel, not hierarchical fallback.
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, joined_at) VALUES (?, 'local', ?)`,
      )
      .run(f.workspace.id, Date.now());
    expect(canViewWorkspace(t.ctx, user, f.workspace.id)).toBe(true);
    expect(canViewConversation(t.ctx, user, f.channel.id)).toBe(false);

    // Adding conversation membership too completes the gate.
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_users (conversation_id, user_id, joined_at) VALUES (?, 'local', ?)`,
      )
      .run(f.channel.id, Date.now());
    expect(canViewConversation(t.ctx, user, f.channel.id)).toBe(true);
  });

  describe('canEditAgent (v26 creator-or-self gate)', () => {
    it('allows the creator user, denies non-creator users', () => {
      t = buildTestApp();
      const f = seed(t);
      // Fixture seeds 'local' as the creator of every agent created via
      // the AgentRepo helper.
      const localUser: UserPrincipal = { kind: 'user', userId: 'local' };
      expect(canEditAgent(t.ctx, localUser, f.alice.id)).toBe(true);
      expect(canEditAgent(t.ctx, localUser, f.bob.id)).toBe(true);

      // A second user that didn't create alice can't edit alice.
      const now = Date.now();
      t.ctx.db
        .prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES ('u-other', 'other', 'Other', ?, ?)`,
        )
        .run(now, now);
      const otherUser: UserPrincipal = { kind: 'user', userId: 'u-other' };
      expect(canEditAgent(t.ctx, otherUser, f.alice.id)).toBe(false);
    });

    it('allows the agent acting as itself, denies cross-agent', () => {
      t = buildTestApp();
      const f = seed(t);
      const aliceSelf: AgentPrincipal = {
        kind: 'agent',
        agentId: f.alice.id,
        conversationId: f.channel.id,
      };
      const bobAsAlice: AgentPrincipal = {
        kind: 'agent',
        agentId: f.bob.id,
        conversationId: f.channel.id,
      };
      expect(canEditAgent(t.ctx, aliceSelf, f.alice.id)).toBe(true);
      expect(canEditAgent(t.ctx, bobAsAlice, f.alice.id)).toBe(false);
    });

    it('allows system unconditionally; user-principal returns false for missing agents', () => {
      t = buildTestApp();
      const f = seed(t);
      // system is the unconditional-bypass branch (mirrors every other
      // canX predicate). It does not consult the agent row.
      expect(canEditAgent(t.ctx, { kind: 'system' }, f.alice.id)).toBe(true);
      expect(canEditAgent(t.ctx, { kind: 'system' }, 'missing')).toBe(true);

      // User principal must consult the row, and missing → deny.
      const localUser: UserPrincipal = { kind: 'user', userId: 'local' };
      expect(canEditAgent(t.ctx, localUser, 'missing')).toBe(false);
    });
  });

  describe('canViewAgent', () => {
    it('allows owner and same-workspace users while keeping edits owner-only', () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const f = seed(t);
      const localUser: UserPrincipal = { kind: 'user', userId: 'local' };
      const teammate: UserPrincipal = { kind: 'user', userId: 'teammate' };
      const outsider: UserPrincipal = { kind: 'user', userId: 'other' };

      f.workspaces.addUserMember(f.workspace.id, 'local');
      f.workspaces.addUserMember(f.workspace.id, 'teammate');

      expect(canViewAgent(t.ctx, localUser, f.alice.id)).toBe(true);
      expect(canViewAgent(t.ctx, teammate, f.alice.id)).toBe(true);
      expect(canViewAgent(t.ctx, outsider, f.alice.id)).toBe(false);

      expect(canEditAgent(t.ctx, localUser, f.alice.id)).toBe(true);
      expect(canEditAgent(t.ctx, teammate, f.alice.id)).toBe(false);
    });

    it('allows agent self and system, denies missing rows', () => {
      t = buildTestApp();
      const f = seed(t);
      const aliceSelf: AgentPrincipal = {
        kind: 'agent',
        agentId: f.alice.id,
        conversationId: f.channel.id,
      };
      const bob: AgentPrincipal = {
        kind: 'agent',
        agentId: f.bob.id,
        conversationId: f.channel.id,
      };

      expect(canViewAgent(t.ctx, aliceSelf, f.alice.id)).toBe(true);
      expect(canViewAgent(t.ctx, bob, f.alice.id)).toBe(false);
      expect(canViewAgent(t.ctx, { kind: 'system' }, f.alice.id)).toBe(true);
      expect(canViewAgent(t.ctx, { kind: 'system' }, 'missing')).toBe(true);
      expect(canViewAgent(t.ctx, { kind: 'user', userId: 'local' }, 'missing')).toBe(false);
    });
  });
});
