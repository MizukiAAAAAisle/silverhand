import { join } from 'node:path';
import { testWorkspacePath } from './utils/db.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canDeleteAttachment,
  canEditAgent,
  canViewAgent,
  canGovernWorkspace,
  canPostToConversation,
  canReadConversation,
  canSubscribeScope,
  canViewAttachment,
  canViewConversation,
  canViewOwnedState,
  canViewWorkspace,
  parseWsScope,
  workspaceRole,
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
  const workspaces = new WorkspaceRepo(t.ctx.db);
  const attachments = new AttachmentRepo(t.ctx.db);
  const host = new HostRepo(t.ctx.db).ensureLocal();
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, host.id, 'local');
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, host.id, 'local');
  const workspace = workspaces.insert({
    name: `ws-${randomUUID().slice(0, 8)}`,
    description: null,
    workspacePath: testWorkspacePath('permissions-ws'),
    workspaceHostId: host.id,
  });
  workspaces.insertMembership(workspace.id, alice.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath: workspace.workspace_path,
    title: 'Main',
  });
  conversations.addAgent(channel.id, alice.id);
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
    // v40: the fixture viewer ('local') is the workspace owner, so it
    // governs at every level — preserving the pre-v40 permissive behavior
    // for the single-human install.
    expect(canGovernWorkspace(t.ctx, user, f.workspace.id, 'owner')).toBe(true);
    expect(canGovernWorkspace(t.ctx, user, f.workspace.id, 'admin')).toBe(true);
    expect(canGovernWorkspace(t.ctx, user, f.workspace.id, 'member')).toBe(true);
    expect(canViewConversation(t.ctx, user, f.channel.id)).toBe(true);
    expect(canPostToConversation(t.ctx, user, f.channel.id)).toBe(true);
    expect(canPostToConversation(t.ctx, { kind: 'system' }, f.channel.id)).toBe(true);

    expect(canViewWorkspace(t.ctx, user, 'missing-workspace')).toBe(false);
    expect(canViewConversation(t.ctx, user, 'missing-conversation')).toBe(false);
  });

  describe('canReadConversation (public read widening)', () => {
    // A workspace member who is NOT a conversation member. This is the ONLY
    // principal the public branch may newly admit — everything else must stay
    // exactly as `canViewConversation` decides (fail-closed by default).
    function seedNonMember(): {
      f: ReturnType<typeof seed>;
      user: UserPrincipal;
      publicChannel: ReturnType<ConversationRepo['insertChannel']>;
    } {
      const app = buildTestApp({ seedAllFixtureMemberships: false });
      t = app;
      const f = seed(app);
      // workspace member, but joined to NO conversation.
      app.ctx.db
        .prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, joined_at) VALUES (?, 'local', ?)`,
        )
        .run(f.workspace.id, Date.now());
      const publicChannel = f.conversations.insertChannel({
        workspaceId: f.workspace.id,
        workspacePath: f.workspace.workspace_path,
        title: 'Public',
        visibility: 'public',
      });
      return { f, user: { kind: 'user', userId: 'local' }, publicChannel };
    }

    it('lets a workspace member READ a public channel without membership, but not VIEW/interact', () => {
      const { f, user, publicChannel } = seedNonMember();
      // Non-member on a PUBLIC channel: read yes, interaction gate no.
      expect(canReadConversation(t!.ctx, user, publicChannel.id)).toBe(true);
      expect(canViewConversation(t!.ctx, user, publicChannel.id)).toBe(false);
      expect(canPostToConversation(t!.ctx, user, publicChannel.id)).toBe(false);
      // Non-member on a PRIVATE channel: read is denied too.
      expect(canReadConversation(t!.ctx, user, f.channel.id)).toBe(false);
    });

    it('denies the public read path to agents (agents never get public access)', () => {
      const { f, publicChannel } = seedNonMember();
      // bob is not an agent-member of the public channel.
      const bob: AgentPrincipal = {
        kind: 'agent',
        agentId: f.bob.id,
        conversationId: publicChannel.id,
      };
      expect(canReadConversation(t!.ctx, bob, publicChannel.id)).toBe(false);
    });

    it('denies public read to a non-workspace-member', () => {
      const { publicChannel } = seedNonMember();
      // 'stranger' is not in workspace_users at all.
      const stranger: UserPrincipal = { kind: 'user', userId: 'stranger' };
      expect(canReadConversation(t!.ctx, stranger, publicChannel.id)).toBe(false);
    });

    it('denies public read of an ARCHIVED public channel to a non-member (archive ≠ delete)', () => {
      const { user, publicChannel } = seedNonMember();
      t!.ctx.db
        .prepare(`UPDATE conversations SET archived_at = ? WHERE id = ?`)
        .run(Date.now(), publicChannel.id);
      expect(canReadConversation(t!.ctx, user, publicChannel.id)).toBe(false);
    });

    it('splits the WS scope: message stream widens, side plane stays member-only', () => {
      const { user: _user, publicChannel } = seedNonMember();
      const convScope = parseWsScope(`conversation:${publicChannel.id}`, 'local');
      const sideScope = parseWsScope(
        `conversation-side:${publicChannel.id}`,
        'local',
      );
      expect(convScope).not.toBeNull();
      expect(sideScope).not.toBeNull();
      // Message content stream: readable by the non-member.
      expect(canSubscribeScope(t!.ctx, 'local', convScope!)).toBe(true);
      // Agent activity/run-state side plane: member-only.
      expect(canSubscribeScope(t!.ctx, 'local', sideScope!)).toBe(false);
    });

    // Raw message insert so we can control the exact metadata bytes — including
    // MALFORMED JSON, which the service layer would never persist.
    function insertMessage(
      convId: string,
      seq: number,
      metadata: string | null,
    ): void {
      t!.ctx.db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, from_kind, from_user_id, content, seq, created_at, metadata)
           VALUES (?, ?, 'user', 'local', 'hi', ?, ?, ?)`,
        )
        .run(`m-${convId}-${seq}`, convId, seq, Date.now(), metadata);
    }

    function insertAttachment(
      f: ReturnType<typeof seed>,
      channelId: string,
      key: string,
    ): { id: string; channel_id: string; created_by_kind: 'user'; created_by_id: string } {
      const dto = f.attachments.insert({
        channelId,
        sourceConversationId: channelId,
        filename: `${key}.txt`,
        size: 1,
        contentType: 'text/plain',
        storage: 'local',
        storageKey: key,
        createdByKind: 'user',
        createdById: 'local',
      });
      return {
        id: dto.id,
        channel_id: dto.channel_id,
        created_by_kind: 'user',
        created_by_id: 'local',
      };
    }

    it('lets a non-member read bytes of an attachment REFERENCED by a persisted channel message', () => {
      const { f, user, publicChannel } = seedNonMember();
      const att = insertAttachment(f, publicChannel.id, 'ref');
      insertMessage(publicChannel.id, 1, JSON.stringify({ attachments: [{ id: att.id }] }));
      // In-message preview: the byte read the renderer needs is allowed.
      expect(canViewAttachment(t!.ctx, user, att)).toBe(true);
    });

    it('denies a non-member the bytes of an UNREFERENCED (orphan/draft) attachment', () => {
      const { f, user, publicChannel } = seedNonMember();
      // Uploaded to the public channel but never sent in a message.
      const orphan = insertAttachment(f, publicChannel.id, 'orphan');
      expect(canViewAttachment(t!.ctx, user, orphan)).toBe(false);
    });

    it('denies a non-member when the only reference is a forged CROSS-CHANNEL snapshot', () => {
      const { f, user, publicChannel } = seedNonMember();
      const att = insertAttachment(f, publicChannel.id, 'xchan');
      // A message in a DIFFERENT (private) channel carries this attachment id in
      // its metadata — untrusted content must not reach across the channel bound.
      insertMessage(f.channel.id, 1, JSON.stringify({ attachments: [{ id: att.id }] }));
      expect(canViewAttachment(t!.ctx, user, att)).toBe(false);
    });

    it('fails closed (no fault) when a channel message has MALFORMED metadata JSON', () => {
      const { f, user, publicChannel } = seedNonMember();
      const orphan = insertAttachment(f, publicChannel.id, 'malformed');
      // A malformed-metadata row in the SAME channel must not fault the
      // reference query; the orphan simply stays unreadable.
      insertMessage(publicChannel.id, 1, '{ this is not json');
      expect(() => canViewAttachment(t!.ctx, user, orphan)).not.toThrow();
      expect(canViewAttachment(t!.ctx, user, orphan)).toBe(false);
    });

    it('handles a VALID array holding scalar/misshaped elements without faulting', () => {
      const { f, user, publicChannel } = seedNonMember();
      const att = insertAttachment(f, publicChannel.id, 'mixed');
      const orphan = insertAttachment(f, publicChannel.id, 'mixedorphan');
      // Valid JSON, but the array mixes scalars with a real object ref. Bare
      // `json_extract(scalar, '$.id')` would raise "malformed JSON" if it ran on
      // 'oops' — the item-level CASE guard must prevent that regardless of
      // predicate order, while the healthy `{id: att.id}` ref still matches.
      insertMessage(
        publicChannel.id,
        1,
        JSON.stringify({ attachments: ['oops', 42, { id: att.id }] }),
      );
      // A second message whose array is ALL scalars references nothing.
      insertMessage(
        publicChannel.id,
        2,
        JSON.stringify({ attachments: ['oops', 42] }),
      );
      expect(() => canViewAttachment(t!.ctx, user, att)).not.toThrow();
      expect(canViewAttachment(t!.ctx, user, att)).toBe(true);
      expect(() => canViewAttachment(t!.ctx, user, orphan)).not.toThrow();
      expect(canViewAttachment(t!.ctx, user, orphan)).toBe(false);
    });

    it('denies a non-member DELETE even of a referenced attachment they created', () => {
      const { f, user, publicChannel } = seedNonMember();
      const att = insertAttachment(f, publicChannel.id, 'del');
      insertMessage(publicChannel.id, 1, JSON.stringify({ attachments: [{ id: att.id }] }));
      // Read is allowed (referenced), but delete is a member mutation — denied
      // even though 'local' is the creator, because delete gates on membership,
      // not the widened read helper.
      expect(canViewAttachment(t!.ctx, user, att)).toBe(true);
      expect(canDeleteAttachment(t!.ctx, user, att)).toBe(false);
    });
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
    // Agents are never governance actors (doc §1.4) — any minRole fails.
    expect(canGovernWorkspace(t.ctx, alice, f.workspace.id, 'admin')).toBe(false);
    expect(canGovernWorkspace(t.ctx, alice, f.workspace.id, 'member')).toBe(false);

    expect(canViewConversation(t.ctx, alice, f.sibling.id)).toBe(false);
    expect(canViewWorkspace(t.ctx, bob, f.workspace.id)).toBe(false);
    expect(canViewConversation(t.ctx, bob, f.channel.id)).toBe(false);
  });

  it('models agent_home as owner-agent plus v1 local human viewable', () => {
    t = buildTestApp();
    const f = seed(t);
    const home = f.workspaces.insertAgentHome({
      agent: f.alice,
      workspacePath: join(t.silverhandDir, 'agents', f.alice.id),
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
    expect(canGovernWorkspace(t.ctx, owner, home.id, 'admin')).toBe(false);
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

  describe('canGovernWorkspace / workspaceRole (v40 human role spine)', () => {
    // Helper: add a human to the workspace with an explicit role,
    // bypassing the route layer (these are helper-level unit tests).
    function addHuman(t: TestApp, workspaceId: string, userId: string, role: string) {
      const now = Date.now();
      t.ctx.db
        .prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(userId, userId, userId, now, now);
      t.ctx.db
        .prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, joined_at, role)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
        )
        .run(workspaceId, userId, now, role);
    }

    it('grades owner ⊇ admin ⊇ member', () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const f = seed(t);
      addHuman(t, f.workspace.id, 'owner-u', 'owner');
      addHuman(t, f.workspace.id, 'admin-u', 'admin');
      addHuman(t, f.workspace.id, 'member-u', 'member');
      const owner: UserPrincipal = { kind: 'user', userId: 'owner-u' };
      const admin: UserPrincipal = { kind: 'user', userId: 'admin-u' };
      const member: UserPrincipal = { kind: 'user', userId: 'member-u' };

      // owner: every level
      expect(canGovernWorkspace(t.ctx, owner, f.workspace.id, 'owner')).toBe(true);
      expect(canGovernWorkspace(t.ctx, owner, f.workspace.id, 'admin')).toBe(true);
      expect(canGovernWorkspace(t.ctx, owner, f.workspace.id, 'member')).toBe(true);
      // admin: admin and below, not owner
      expect(canGovernWorkspace(t.ctx, admin, f.workspace.id, 'owner')).toBe(false);
      expect(canGovernWorkspace(t.ctx, admin, f.workspace.id, 'admin')).toBe(true);
      expect(canGovernWorkspace(t.ctx, admin, f.workspace.id, 'member')).toBe(true);
      // member: member only
      expect(canGovernWorkspace(t.ctx, member, f.workspace.id, 'owner')).toBe(false);
      expect(canGovernWorkspace(t.ctx, member, f.workspace.id, 'admin')).toBe(false);
      expect(canGovernWorkspace(t.ctx, member, f.workspace.id, 'member')).toBe(true);
    });

    it('returns the role via workspaceRole, null for non-members and agents', () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const f = seed(t);
      addHuman(t, f.workspace.id, 'admin-u', 'admin');
      expect(workspaceRole(t.ctx, { kind: 'user', userId: 'admin-u' }, f.workspace.id)).toBe('admin');
      // not a member → null
      expect(workspaceRole(t.ctx, { kind: 'user', userId: 'ghost' }, f.workspace.id)).toBe(null);
      // agents carry no workspace role
      const agent: AgentPrincipal = {
        kind: 'agent',
        agentId: f.alice.id,
        conversationId: f.channel.id,
      };
      expect(workspaceRole(t.ctx, agent, f.workspace.id)).toBe(null);
      // missing workspace → null
      expect(workspaceRole(t.ctx, { kind: 'user', userId: 'admin-u' }, 'missing')).toBe(null);
    });

    it('passes system unconditionally and denies non-members', () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const f = seed(t);
      expect(canGovernWorkspace(t.ctx, { kind: 'system' }, f.workspace.id, 'owner')).toBe(true);
      // a registered user who is not a workspace member cannot govern
      addHuman(t, f.workspace.id, 'member-u', 'member'); // ensure user row exists elsewhere
      expect(
        canGovernWorkspace(t.ctx, { kind: 'user', userId: 'ghost' }, f.workspace.id, 'member'),
      ).toBe(false);
    });
  });

  describe('cross-axis orthogonality (v40 — doc §6.3 cases 1-3)', () => {
    // The agent capability axis lands in Layer A cut 2; case 4
    // (capability change vs role change) is deferred until then. Cut 1
    // proves the human role axis does not collapse into the agent-edit
    // (creator) axis: governing a workspace ≠ editing an agent profile.
    function addHuman(t: TestApp, workspaceId: string, userId: string, role: string) {
      const now = Date.now();
      t.ctx.db
        .prepare(
          `INSERT INTO users (id, name, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .run(userId, userId, userId, now, now);
      t.ctx.db
        .prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, joined_at, role)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
        )
        .run(workspaceId, userId, now, role);
    }

    it('case 1: workspace owner who is not the agent creator governs but cannot edit the agent', () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const f = seed(t);
      // alice was created by 'local'. Make 'owner-u' the workspace owner.
      addHuman(t, f.workspace.id, 'owner-u', 'owner');
      const owner: UserPrincipal = { kind: 'user', userId: 'owner-u' };
      expect(canGovernWorkspace(t.ctx, owner, f.workspace.id, 'owner')).toBe(true);
      // …but owner-u did not create alice, so cannot edit her profile.
      expect(canEditAgent(t.ctx, owner, f.alice.id)).toBe(false);
    });

    it('case 2: agent creator who is an ordinary member edits the agent but cannot govern', () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const f = seed(t);
      // 'local' created alice (fixture). Make 'local' only a member.
      addHuman(t, f.workspace.id, 'local', 'member');
      const creator: UserPrincipal = { kind: 'user', userId: 'local' };
      expect(canEditAgent(t.ctx, creator, f.alice.id)).toBe(true);
      expect(canGovernWorkspace(t.ctx, creator, f.workspace.id, 'admin')).toBe(false);
      expect(canGovernWorkspace(t.ctx, creator, f.workspace.id, 'owner')).toBe(false);
    });

    it('case 3: plain member can view/post but holds no admin/owner governance', () => {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      const f = seed(t);
      addHuman(t, f.workspace.id, 'member-u', 'member');
      t.ctx.db
        .prepare(
          `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
           VALUES (?, 'member-u', ?)`,
        )
        .run(f.channel.id, Date.now());
      const member: UserPrincipal = { kind: 'user', userId: 'member-u' };
      expect(canViewWorkspace(t.ctx, member, f.workspace.id)).toBe(true);
      expect(canPostToConversation(t.ctx, member, f.channel.id)).toBe(true);
      expect(canGovernWorkspace(t.ctx, member, f.workspace.id, 'admin')).toBe(false);
      expect(canEditAgent(t.ctx, member, f.alice.id)).toBe(false);
    });
  });
});
