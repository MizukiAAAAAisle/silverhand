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
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import type { MessageDto } from '@silverhand/shared';

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
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
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

async function runMentionCc(t: ReturnType<typeof bootstrap>, message: MessageDto) {
  await ccMentionsFromUserMessage({
    message,
    sourceConversation: t.sourceChannel,
    sourceWorkspace: t.sourceWorkspace,
    db: t.db,
    agents: t.agents,
    conversations: t.conversations,
    messages: t.messages,
    notifications: t.notifications,
    runtimeHost: t.fake as unknown as AgentRuntimeHost,
    logger: t.logger,
    events: t.events,
  });
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
        runtimeHost: t.fake as unknown as AgentRuntimeHost,
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

  it('falls back to the source conversation sole human member when message has no from_user_id', async () => {
    const t = bootstrap();
    try {
      t.conversations.addUser(t.sourceChannel.id, 'local');
      // Legacy null-author message — pre-v25 messages may carry
      // from_user_id = null. The fallback chain resolves to the sole
      // human member in the source conversation ('local').
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
        runtimeHost: t.fake as unknown as AgentRuntimeHost,
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
    // log+skip user membership, 不要写空 membership". With a legacy
    // null author and no source-conversation human member, the function
    // must NOT insert any conversation_users / workspace_users rows for
    // the lazily-created Mentions DM.
    const t = bootstrap();
    try {
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
        runtimeHost: t.fake as unknown as AgentRuntimeHost,
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

  it('logs and skips membership writes when a null-author source has multiple human members', async () => {
    const t = bootstrap();
    try {
      t.conversations.addUser(t.sourceChannel.id, 'local');
      t.conversations.addUser(t.sourceChannel.id, 'teammate');

      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: null,
        content: 'hey @alice ambiguous human',
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
        runtimeHost: t.fake as unknown as AgentRuntimeHost,
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
        .all(mentionsDm!.id);
      expect(dmMembers).toHaveLength(0);
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
        runtimeHost: t.fake as unknown as AgentRuntimeHost,
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
        runtimeHost: t.fake as unknown as AgentRuntimeHost,
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

describe('ccMentionsFromUserMessage — realtime events and skip logging', () => {
  it('publishes topology, message, unread, and notification events for a newly visible Mentions DM', async () => {
    const t = bootstrap();
    try {
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'please review this @alice',
      });

      await runMentionCc(t, userMsg);

      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();

      const workspaceEvents = t.events.replay(
        `workspace:${t.aliceHome.id}`,
        0,
        'test-epoch',
      );
      expect(workspaceEvents).toEqual([
        expect.objectContaining({
          kind: 'workspace_channels_changed',
          payload: {
            workspace_id: t.aliceHome.id,
            channel_id: mentionsDm!.id,
          },
        }),
      ]);

      const conversationEvents = t.events.replay(
        `conversation:${mentionsDm!.id}`,
        0,
        'test-epoch',
      );
      expect(conversationEvents).toHaveLength(1);
      expect(conversationEvents[0]).toEqual(
        expect.objectContaining({
          kind: 'message',
          payload: {
            message: expect.objectContaining({
              conversation_id: mentionsDm!.id,
              from_kind: 'system',
            }),
          },
        }),
      );

      const viewerEvents = t.events.replay('viewer:teammate', 0, 'test-epoch');
      expect(viewerEvents.map(e => e.kind)).toEqual([
        'unread_updated',
        'notification',
      ]);
      expect(viewerEvents[0]!.payload).toEqual({
        conversation_id: mentionsDm!.id,
      });
      expect(viewerEvents[1]!.payload).toEqual(
        expect.objectContaining({
          kind: 'mention_external',
          conversation_id: mentionsDm!.id,
        }),
      );
    } finally {
      t.cleanup();
    }
  });

  it('does not republish workspace_channels_changed when reusing the same Mentions DM membership', async () => {
    const t = bootstrap();
    try {
      const first = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'first @alice',
      });
      await runMentionCc(t, first);
      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();

      const second = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'second @alice',
      });
      await runMentionCc(t, second);

      expect(t.events.currentSeq(`workspace:${t.aliceHome.id}`)).toBe(1);
      expect(t.events.currentSeq(`conversation:${mentionsDm!.id}`)).toBe(2);
      expect(t.events.replay('viewer:teammate', 0, 'test-epoch').map(e => e.kind))
        .toEqual([
          'unread_updated',
          'notification',
          'unread_updated',
          'notification',
        ]);
    } finally {
      t.cleanup();
    }
  });

  it('skips unread_updated when the viewer read cursor already covers the wrapped message seq', async () => {
    const t = bootstrap();
    try {
      const first = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'first @alice',
      });
      await runMentionCc(t, first);
      const mentionsDm = t.conversations.findDmChannelForAgent(t.alice.id, {
        title: 'Mentions',
      });
      expect(mentionsDm).not.toBeNull();

      t.db
        .prepare(
          `INSERT INTO conversation_reads
             (user_id, conversation_id, last_read_seq, read_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('teammate', mentionsDm!.id, 99, Date.now());
      const viewerSeqBeforeSecond = t.events.currentSeq('viewer:teammate');

      const second = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'second @alice',
      });
      await runMentionCc(t, second);

      expect(
        t.events
          .replay('viewer:teammate', viewerSeqBeforeSecond, 'test-epoch')
          .map(e => e.kind),
      ).toEqual(['notification']);
    } finally {
      t.cleanup();
    }
  });

  it('logs unknown mention handles at info level', async () => {
    const t = bootstrap();
    try {
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'hey @ghost',
      });

      await runMentionCc(t, userMsg);

      expect(t.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'mention_cc.skip',
          reason: 'unknown_handle',
          handle: 'ghost',
        }),
        expect.any(String),
      );
      expect(t.fake.delivered).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it('logs source-member mentions at info level instead of duplicating into a DM', async () => {
    const t = bootstrap();
    try {
      t.conversations.addAgent(t.sourceChannel.id, t.alice.id);
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'hey @alice',
      });

      await runMentionCc(t, userMsg);

      expect(t.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'mention_cc.skip',
          reason: 'already_member',
          handle: 'alice',
          agentId: t.alice.id,
        }),
        expect.any(String),
      );
      expect(
        t.conversations.findDmChannelForAgent(t.alice.id, { title: 'Mentions' }),
      ).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('logs missing agent DM channels at warn level', async () => {
    const t = bootstrap();
    try {
      const bob = t.agents.create(
        { name: 'bob', runtime: 'claude' },
        t.alice.host_id,
        'local',
      );
      const userMsg = t.messages.insertForConversation({
        conversationId: t.sourceChannel.id,
        fromKind: 'user',
        fromUserId: 'teammate',
        content: 'hey @bob',
      });

      await runMentionCc(t, userMsg);

      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'mention_cc.skip',
          reason: 'missing_agent_dm',
          handle: 'bob',
          agentId: bob.id,
        }),
        expect.any(String),
      );
      expect(t.fake.delivered).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});
