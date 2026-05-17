import { describe, expect, it, vi } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { ccMentionsFromUserMessage } from '../../src/mention-cc.js';
import type { BackendLogger } from '../../src/context.js';
import type { ConversationManager } from '../../src/conversation-manager.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

class FakeConversationManager {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];

  async start(conversationId: string, agentId: string): Promise<void> {
    this.starts.push({ conversationId, agentId });
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    this.delivered.push({ conversationId, agentId, messageId });
  }
}

function bootstrap() {
  const { db, localHostId } = openTestDb();
  // Drop the test fixture autoseed triggers — we want to observe the
  // exact membership rows mention-cc writes, not the bulk fixture seed.
  db.exec(
    `DROP TRIGGER IF EXISTS test_seed_workspace_users;
     DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
  );

  const tmp = makeTempSilverhandDir();
  const hosts = new HostRepo(db);
  hosts.ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const notifications = new NotificationRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  // Source workspace + channel — created via the repo, autoseed-trigger
  // is gone so no membership rows get written automatically.
  const sourceWorkspace = workspaces.insert({
    name: 'eng',
    description: null,
    workspacePath: tmp.workspacesRoot,
    workspaceHostId: localHostId,
  });
  const sourceChannel = conversations.insertChannel({
    workspaceId: sourceWorkspace.id,
    workspacePath: sourceWorkspace.workspace_path,
    title: 'general',
  });

  // Recipient agent ("alice") with their agent_home + Onboarding DM.
  // mention-cc looks up the agent's primary DM and uses its workspace
  // as the home for the new Mentions DM.
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId);
  const aliceHome = workspaces.insertAgentHome({
    agent: { id: alice.id, name: alice.name, host_id: alice.host_id },
    workspacePath: tmp.workspacesRoot,
  });
  const aliceDm = conversations.insertDmChannel({
    workspaceId: aliceHome.id,
    workspacePath: aliceHome.workspace_path,
    title: 'Onboarding',
    agentId: alice.id,
  });
  conversations.addAgent(aliceDm.id, alice.id);

  return {
    db,
    tmp,
    agents,
    workspaces,
    conversations,
    messages,
    notifications,
    events,
    fake,
    logger,
    sourceWorkspace,
    sourceChannel,
    alice,
    aliceHome,
    aliceDm,
    cleanup: tmp.cleanup,
  };
}

describe('ccMentionsFromUserMessage — human membership writes (v25 PR-A blocker fix)', () => {
  it('writes message-author user_id into Mentions conversation_users + workspace_users', async () => {
    const t = bootstrap();
    try {
      // Source message authored by 'teammate' (a fixture user that is
      // NOT the registered viewer 'local'). The CC path must add the
      // *author*, not the viewer, to the lazy Mentions DM.
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'hey @alice take a look',
      });

      await ccMentionsFromUserMessage({
        message: userMsg,
        sourceConversation: t.sourceChannel,
        sourceWorkspace: t.sourceWorkspace,
        db: t.db,
        agents: t.agents,
        conversations: t.conversations,
        messages: t.messages,
        notifications: t.notifications,
        conversationManager: t.fake as unknown as ConversationManager,
        logger: t.logger,
        events: t.events,
      });

      // The Mentions DM must now exist under alice's home workspace.
      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();
      expect(mentionsDm!.workspace_id).toBe(t.aliceHome.id);

      // conversation_users for that DM must contain the *author*.
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id)
        .map(r => r.user_id);
      expect(dmMembers).toEqual(['teammate']);

      // workspace_users for alice's home must also contain the author.
      const homeMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM workspace_users WHERE workspace_id = ?`,
        )
        .all(t.aliceHome.id)
        .map(r => r.user_id);
      expect(homeMembers).toContain('teammate');
    } finally {
      t.cleanup();
    }
  });

  it('falls back to registered viewer when message has no from_user_id', async () => {
    const t = bootstrap();
    try {
      // Legacy null-author message — pre-v25 messages may carry
      // from_user_id = null. The fallback chain resolves to the
      // registered viewer ('local').
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: null,
        content: 'hey @alice legacy null author',
      });

      await ccMentionsFromUserMessage({
        message: userMsg,
        sourceConversation: t.sourceChannel,
        sourceWorkspace: t.sourceWorkspace,
        db: t.db,
        agents: t.agents,
        conversations: t.conversations,
        messages: t.messages,
        notifications: t.notifications,
        conversationManager: t.fake as unknown as ConversationManager,
        logger: t.logger,
        events: t.events,
      });

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id)
        .map(r => r.user_id);
      expect(dmMembers).toEqual(['local']);
    } finally {
      t.cleanup();
    }
  });

  it('logs and skips membership writes when no user id is resolvable', async () => {
    // Per Cindy's instruction: "如果最终仍拿不到 user id, 宁可
    // log+skip user membership, 不要写空 membership". We wipe both the
    // message author and the registered viewer pointer; the function
    // must NOT insert any conversation_users / workspace_users rows
    // for the lazily-created Mentions DM.
    const t = bootstrap();
    try {
      // Wipe viewer pointer so SettingsRepo.getViewerUserId() → null.
      t.db.prepare(`DELETE FROM app_settings WHERE key = 'viewer_user_id'`).run();

      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: null,
        content: 'hey @alice no resolvable human',
      });

      await ccMentionsFromUserMessage({
        message: userMsg,
        sourceConversation: t.sourceChannel,
        sourceWorkspace: t.sourceWorkspace,
        db: t.db,
        agents: t.agents,
        conversations: t.conversations,
        messages: t.messages,
        notifications: t.notifications,
        conversationManager: t.fake as unknown as ConversationManager,
        logger: t.logger,
        events: t.events,
      });

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();
      // No conversation_users rows for the new Mentions DM.
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id);
      expect(dmMembers).toHaveLength(0);
      // No workspace_users rows added either.
      const homeMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM workspace_users WHERE workspace_id = ?`,
        )
        .all(t.aliceHome.id);
      expect(homeMembers).toHaveLength(0);
      // The skip path must log a warning so this isn't silent.
      expect(t.logger.warn).toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  it('does not write a duplicate user_id row when the same author is mentioned twice', async () => {
    const t = bootstrap();
    try {
      // First mention seeds the Mentions DM + adds 'teammate'.
      const m1 = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'first @alice',
      });
      await ccMentionsFromUserMessage({
        message: m1,
        sourceConversation: t.sourceChannel,
        sourceWorkspace: t.sourceWorkspace,
        db: t.db,
        agents: t.agents,
        conversations: t.conversations,
        messages: t.messages,
        notifications: t.notifications,
        conversationManager: t.fake as unknown as ConversationManager,
        logger: t.logger,
        events: t.events,
      });
      // Second mention — addUser must be idempotent.
      const m2 = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'second @alice',
      });
      await ccMentionsFromUserMessage({
        message: m2,
        sourceConversation: t.sourceChannel,
        sourceWorkspace: t.sourceWorkspace,
        db: t.db,
        agents: t.agents,
        conversations: t.conversations,
        messages: t.messages,
        notifications: t.notifications,
        conversationManager: t.fake as unknown as ConversationManager,
        logger: t.logger,
        events: t.events,
      });

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      const dmMembers = t.db
        .prepare<[string], { user_id: string }>(
          `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
        )
        .all(mentionsDm!.id)
        .map(r => r.user_id);
      expect(dmMembers).toEqual(['teammate']);
    } finally {
      t.cleanup();
    }
  });
});
