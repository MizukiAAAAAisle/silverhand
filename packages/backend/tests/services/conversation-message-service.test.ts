import { describe, expect, it, vi } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { ThreadFollowerRepo } from '../../src/repos/thread-follower-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AttachmentService } from '../../src/services/attachment-service.js';
import {
  ActorError,
  AttachmentError,
  ConversationError,
  ConversationMessageService,
  MessageFreshnessError,
  PolicyError,
  TargetError,
} from '../../src/services/conversation-message-service.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { createLocalBlobFileStorage } from '../../src/storage/blob-file-storage.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { ccMentionsFromUserMessage } from '../../src/mention-cc.js';
import { PrincipalConversationMismatchError } from '../../src/auth/principal.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

vi.mock('../../src/mention-cc.js', () => ({
  ccMentionsFromUserMessage: vi.fn(async () => {}),
}));

type TerminalReason = Parameters<AgentRuntimeHost['resolveRun']>[2];

class FakeConversationManager {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];
  resolvedRuns: Array<{ conversationId: string; agentId: string; reason: TerminalReason }> = [];
  deliverError: Error | null = null;
  startError: Error | null = null;
  hangDeliver = false;
  onDeliver: (() => void) | null = null;

  async start(conversationId: string, agentId: string): Promise<void> {
    this.starts.push({ conversationId, agentId });
    if (this.startError) throw this.startError;
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    this.onDeliver?.();
    this.delivered.push({ conversationId, agentId, messageId });
    if (this.deliverError) throw this.deliverError;
    if (this.hangDeliver) return new Promise<void>(() => {});
  }

  resolveRun(conversationId: string, agentId: string, reason: TerminalReason): void {
    this.resolvedRuns.push({ conversationId, agentId, reason });
  }
  resolveConversationRuns(): void {}
  getAgentRunStates(): never[] {
    return [];
  }
  async stop(): Promise<void> {}
  async stopAll(): Promise<void> {}
  reconcileOnBoot(): void {}
  isRunning(): boolean {
    return false;
  }
  closeActivityLog(): Promise<void> {
    return Promise.resolve();
  }
}

function bootstrap() {
  vi.mocked(ccMentionsFromUserMessage).mockClear();
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const hosts = new HostRepo(db);
  hosts.ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const conversations = new ConversationRepo(db);
  const conversationInboxes = new ConversationInboxRepo(db);
  const messages = new MessageRepo(db);
  const threadFollowers = new ThreadFollowerRepo(db);
  const notifications = new NotificationRepo(db);
  const users = new UserRepo(db);
  const attachments = new AttachmentRepo(db);
  const attachmentService = new AttachmentService({
    storage: createLocalBlobFileStorage({ silverhandDir: tmp.silverhandDir }),
    attachments,
    conversations,
  });
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = new ConversationMessageService({
    db,
    conversations,
    conversationInboxes,
    messages,
    threadFollowers,
    agents,
    users,
    notifications,
    workspaces,
    attachmentService,
    runtimeHost: fake as unknown as AgentRuntimeHost,
    events,
    logger,
  });
  const workspace = workspaces.insert({
    name: 'eng',
    description: null,
    workspacePath: tmp.workspacesRoot,
    workspaceHostId: localHostId,
  });
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, alice.id);
  workspaces.insertMembership(workspace.id, bob.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath: workspace.workspace_path,
    title: 'source',
  });
  conversations.addAgent(channel.id, alice.id);
  conversations.addAgent(channel.id, bob.id);

  return {
    db,
    tmp,
    localHostId,
    attachments,
    agents,
    workspaces,
    conversations,
    conversationInboxes,
    messages,
    threadFollowers,
    notifications,
    users,
    events,
    fake,
    logger,
    service,
    workspace,
    channel,
    alice,
    bob,
    cleanup: tmp.cleanup,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('ConversationMessageService.sendMessage', () => {
  it('sends a user message to a channel, publishes unread, CCs, delivers, and auto-starts', async () => {
    const t = bootstrap();
    try {
      const conversationEvents: Array<{ kind: string; payload: any }> = [];
      const viewerEvents: Array<{ kind: string; payload: any }> = [];
      const unsubConversation = t.events.subscribe(t.channel.id, e => {
        conversationEvents.push({ kind: e.kind, payload: e.payload });
      });
      const unsubViewer = t.events.subscribeScope('viewer:local', e => {
        viewerEvents.push({ kind: e.kind, payload: e.payload });
      });

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'hello @alice',
      });
      unsubConversation();
      unsubViewer();

      expect(result.targetConversationId).toBe(t.channel.id);
      expect(result.message.from_kind).toBe('user');
      expect(t.fake.delivered.map(d => d.agentId).sort()).toEqual(
        [t.alice.id, t.bob.id].sort(),
      );
      expect(t.fake.starts.map(s => s.agentId).sort()).toEqual(
        [t.alice.id, t.bob.id].sort(),
      );
      expect(vi.mocked(ccMentionsFromUserMessage)).toHaveBeenCalledTimes(1);
      expect(conversationEvents[0]).toMatchObject({
        kind: 'message',
        payload: { message: { id: result.message.id } },
      });
      expect(viewerEvents).toContainEqual({
        kind: 'unread_updated',
        payload: { conversation_id: t.channel.id },
      });
    } finally {
      t.cleanup();
    }
  });

  it('sends a user message to a thread and refreshes the parent', async () => {
    const t = bootstrap();
    try {
      const thread = t.conversations.insertThread({
        channelId: t.channel.id,
        title: 'thread',
      });
      t.conversations.addAgent(thread.id, t.alice.id);
      const parentEvents: Array<{ kind: string; payload: any }> = [];
      const unsub = t.events.subscribe(t.channel.id, e => {
        parentEvents.push({ kind: e.kind, payload: e.payload });
      });

      await t.service.sendMessage({
        conversationId: thread.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'thread reply',
      });
      unsub();

      expect(parentEvents).toContainEqual({
        kind: 'thread_updated',
        payload: {
          parent_conversation_id: t.channel.id,
          thread_id: thread.id,
        },
      });
    } finally {
      t.cleanup();
    }
  });

  it('notifies the viewer when another sender mentions their user handle', async () => {
    const t = bootstrap();
    try {
      const viewerEvents: Array<{ kind: string; payload: any }> = [];
      const unsubViewer = t.events.subscribeScope('viewer:local', e => {
        viewerEvents.push({ kind: e.kind, payload: e.payload });
      });

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'can you check this, @local-test?',
      });
      unsubViewer();

      expect(t.notifications.list({ userId: 'local', unread: true })).toEqual([
        expect.objectContaining({
          kind: 'mention_self',
          user_id: 'local',
          conversation_id: t.channel.id,
          message_id: result.message.id,
          source_conversation_id: t.channel.id,
          source_message_id: result.message.id,
          payload: expect.objectContaining({
            conversation_title: 'source',
            trigger_name: 'alice',
            mentioned_name: 'local-test',
          }),
        }),
      ]);
      expect(viewerEvents).toContainEqual({
        kind: 'notification',
        payload: {
          kind: 'mention_self',
          conversation_id: t.channel.id,
          message_id: result.message.id,
        },
      });
    } finally {
      t.cleanup();
    }
  });

  it('does not notify when the viewer mentions their own user handle', async () => {
    const t = bootstrap();
    try {
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'note to @local-test',
      });

      expect(t.notifications.list({ userId: 'local', unread: true })).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('sends agent_start_failed notification only to the user who triggered delivery failure', async () => {
    const t = bootstrap();
    try {
      t.conversations.removeAgent(t.channel.id, t.bob.id);
      t.fake.deliverError = new Error(
        'runtime_start: binary "claude" for runtime "claude" not found on PATH',
      );
      const viewerEvents: Array<{ kind: string; payload: any }> = [];
      const teammateEvents: Array<{ kind: string; payload: any }> = [];
      const unsubViewer = t.events.subscribeScope('viewer:local', e => {
        viewerEvents.push({ kind: e.kind, payload: e.payload });
      });
      const unsubTeammate = t.events.subscribeScope('viewer:teammate', e => {
        teammateEvents.push({ kind: e.kind, payload: e.payload });
      });

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'please respond',
      });
      await waitFor(() =>
        t.notifications.list({ userId: 'local' }).some(n => n.kind === 'agent_start_failed'),
      );
      unsubViewer();
      unsubTeammate();

      expect(t.notifications.list({ userId: 'local', unread: true })).toEqual([
        expect.objectContaining({
          kind: 'agent_start_failed',
          user_id: 'local',
          agent_id: t.alice.id,
          workspace_id: t.workspace.id,
          conversation_id: t.channel.id,
          message_id: null,
          source_conversation_id: t.channel.id,
          source_message_id: result.message.id,
          payload: expect.objectContaining({
            reason: 'runtime_start_failed',
            agent_name: 'alice',
            runtime: 'claude',
            host_id: t.alice.host_id,
            error: 'runtime_start: binary "claude" for runtime "claude" not found on PATH',
          }),
        }),
      ]);
      expect(t.notifications.list({ userId: 'teammate', unread: true })).toEqual([]);
      expect(viewerEvents).toContainEqual({
        kind: 'notification',
        payload: expect.objectContaining({
          kind: 'agent_start_failed',
          conversation_id: t.channel.id,
          agent_id: t.alice.id,
        }),
      });
      expect(teammateEvents.filter(e => e.kind === 'notification')).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('keeps every repeated agent_start_failed notification in v1', async () => {
    const t = bootstrap();
    try {
      t.conversations.removeAgent(t.channel.id, t.bob.id);
      t.fake.deliverError = new Error('runtime_start failed');

      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'first',
      });
      await waitFor(
        () =>
          t.notifications
            .list({ userId: 'local' })
            .filter(n => n.kind === 'agent_start_failed').length === 1,
      );

      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'second',
      });
      await waitFor(
        () =>
          t.notifications
            .list({ userId: 'local' })
            .filter(n => n.kind === 'agent_start_failed').length === 2,
      );

      expect(
        t.notifications.list({ userId: 'local', unread: true })
          .filter(n => n.kind === 'agent_start_failed'),
      ).toHaveLength(2);
    } finally {
      t.cleanup();
    }
  });

  it('sends agent_start_failed notification when user-triggered auto-start fails', async () => {
    const t = bootstrap();
    try {
      t.conversations.removeAgent(t.channel.id, t.bob.id);
      t.fake.startError = new Error('manual start failed');

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'wake up',
      });
      await waitFor(() =>
        t.notifications.list({ userId: 'local' }).some(n => n.kind === 'agent_start_failed'),
      );

      expect(t.notifications.list({ userId: 'local', unread: true })).toEqual([
        expect.objectContaining({
          kind: 'agent_start_failed',
          user_id: 'local',
          agent_id: t.alice.id,
          source_message_id: result.message.id,
          payload: expect.objectContaining({
            reason: 'runtime_start_failed',
            error: 'manual start failed',
          }),
        }),
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('rejects closed source conversations', async () => {
    const t = bootstrap();
    try {
      t.db.prepare(`UPDATE conversations SET closed_at = ? WHERE id = ?`)
        .run(Date.now(), t.channel.id);
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'user', userId: 'local' },
          content: 'closed',
        }),
      ).rejects.toMatchObject({ code: 'conversation_closed' });
    } finally {
      t.cleanup();
    }
  });

  it('checks source existence before agent membership', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.sendMessage({
          conversationId: 'missing-conversation',
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: 'missing-conversation' },
          content: 'missing',
        }),
      ).rejects.toBeInstanceOf(ConversationError);
    } finally {
      t.cleanup();
    }
  });

  it('rejects agent principal conversation mismatch before inserting', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: other.id },
          content: 'mismatch',
        }),
      ).rejects.toBeInstanceOf(PrincipalConversationMismatchError);
      expect(t.messages.listForConversation(t.channel.id)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('validates attachment ownership before inserting', async () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'other',
      });
      const foreign = t.attachments.insert({
        channelId: other.id,
        sourceConversationId: other.id,
        filename: 'x.png',
        size: 10,
        contentType: 'image/png',
        storage: 'local',
        storageKey: 'attachments/other/x',
        createdByKind: 'user',
        createdById: 'local',
      });

      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'user', userId: 'local' },
          content: 'file',
          attachmentIds: [foreign.id],
        }),
      ).rejects.toMatchObject({
        code: 'attachment_outside_channel',
        attachmentId: foreign.id,
      });
      expect(t.messages.listForConversation(t.channel.id)).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it('embeds valid attachment snapshots and does not auto-start active recipients', async () => {
    const t = bootstrap();
    try {
      t.db.prepare(`UPDATE conversation_agents SET status = 'active' WHERE conversation_id = ?`)
        .run(t.channel.id);
      const attachment = t.attachments.insert({
        channelId: t.channel.id,
        sourceConversationId: t.channel.id,
        filename: 'ok.png',
        size: 12,
        contentType: 'image/png',
        storage: 'local',
        storageKey: 'attachments/source/ok',
        createdByKind: 'user',
        createdById: 'local',
      });

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'file',
        attachmentIds: [attachment.id],
      });

      expect(result.message.attachments).toEqual([
        {
          id: attachment.id,
          filename: 'ok.png',
          size: 12,
          content_type: 'image/png',
        },
      ]);
      expect(t.fake.delivered.map(d => d.agentId).sort()).toEqual(
        [t.alice.id, t.bob.id].sort(),
      );
      expect(t.fake.starts).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('rejects user targets before resolving target existence', async () => {
    const t = bootstrap();
    try {
      const spy = vi.spyOn(t.conversations, 'get');
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'user', userId: 'local' },
          content: 'up',
          target: 'parent',
        }),
      ).rejects.toBeInstanceOf(PolicyError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  it('sends an agent message to self, excludes sender, resolves source run, and does not CC or start', async () => {
    const t = bootstrap();
    try {
      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'agent reply',
      });

      expect(result.message.from_kind).toBe('agent');
      expect(result.message.from_agent_id).toBe(t.alice.id);
      expect(t.fake.delivered.map(d => d.agentId)).toEqual([t.bob.id]);
      expect(t.fake.starts).toEqual([]);
      expect(t.fake.resolvedRuns).toEqual([
        { conversationId: t.channel.id, agentId: t.alice.id, reason: 'replied' },
      ]);
      expect(vi.mocked(ccMentionsFromUserMessage)).not.toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  it('holds stale same-conversation agent sends before inserting side effects', async () => {
    const t = bootstrap();
    try {
      const observed = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'observed',
      });
      const newer = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'conflicting update',
      });
      const conversationEvents: Array<{ kind: string; payload: any }> = [];
      const unsub = t.events.subscribe(t.channel.id, e => {
        conversationEvents.push({ kind: e.kind, payload: e.payload });
      });

      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          content: 'stale draft',
          seenUpToSeq: observed.seq,
        }),
      ).rejects.toMatchObject({
        code: 'message_stale',
        staleEventId: expect.any(String),
        seenUpToSeq: observed.seq,
        currentSeq: newer.seq,
        newerMessages: [expect.objectContaining({ content: 'conflicting update' })],
      });
      unsub();

      expect(t.messages.listForConversation(t.channel.id).map(m => m.content))
        .toEqual(['observed', 'conflicting update']);
      expect(conversationEvents).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
      expect(t.fake.resolvedRuns).toEqual([]);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          staleEventId: expect.any(String),
          conversationId: t.channel.id,
          actorKind: 'agent',
          actorId: t.alice.id,
          seenUpToSeq: observed.seq,
          currentSeq: newer.seq,
          newerMessageCount: 1,
        }),
        'conversation-message-service: freshness CAS rejected',
      );
    } finally {
      t.cleanup();
    }
  });

  it('falls back without hard CAS when an agent send has no delivered seq', async () => {
    const t = bootstrap();
    try {
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'no seen seq',
      });

      expect(t.messages.listForConversation(t.channel.id).map(m => m.content))
        .toEqual(['no seen seq']);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'missing_seen_up_to_seq' }),
        'conversation-message-service: freshness CAS skipped',
      );
    } finally {
      t.cleanup();
    }
  });

  it('explicit freshness bypass inserts stale agent sends and logs an auditable reason', async () => {
    const t = bootstrap();
    try {
      const observed = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'observed',
      });
      t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'newer context',
      });

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'send anyway',
        seenUpToSeq: observed.seq,
        staleEventId: 'evt-force',
        freshnessBypass: true,
      });

      expect(result.message.content).toBe('send anyway');
      expect(t.messages.listForConversation(t.channel.id).map(m => m.content))
        .toEqual(['observed', 'newer context', 'send anyway']);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'freshness_bypass_explicit' }),
        'conversation-message-service: freshness CAS skipped',
      );
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          staleEventId: 'evt-force',
          resolutionReason: 'force_send',
          outcome: 'message_sent',
          messageId: result.message.id,
          messageSeq: result.message.seq,
        }),
        'conversation-message-service: stale send resolution observed',
      );
    } finally {
      t.cleanup();
    }
  });

  it('routes a reply into the thread stream rooted at the target message', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'root question',
      });
      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'threaded answer',
        replyToMessageId: root.id,
      });
      expect(result.message.thread_root_id).toBe(root.id);
      // a reply to that reply joins the SAME root (no nested threads)
      const nested = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: 'follow-up',
        replyToMessageId: result.message.id,
      });
      expect(nested.message.thread_root_id).toBe(root.id);
    } finally {
      t.cleanup();
    }
  });

  it('rejects a reply whose target is not in the conversation', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          content: 'orphan reply',
          replyToMessageId: 'does-not-exist',
        }),
      ).rejects.toMatchObject({ code: 'reply_target_not_found' });
    } finally {
      t.cleanup();
    }
  });

  it('scopes freshness per stream: a thread reply does not stale a main-line send', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'observed on main',
      });
      // a reply lands in the thread stream, advancing the global seq but NOT
      // the main head — an agent that observed the main line up to `root`
      // must still be able to post on the main line without a false stale.
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: 'thread reply',
        replyToMessageId: root.id,
        seenUpToSeq: 0,
      });
      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'main-line answer',
        seenUpToSeq: root.seq,
      });
      expect(result.message.content).toBe('main-line answer');
      expect(result.message.thread_root_id).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('stale reply reports newer_messages from the same thread stream only', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'root',
      });
      // first reply establishes the thread head (seen=0)
      const firstReply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: 'first thread reply',
        replyToMessageId: root.id,
        seenUpToSeq: 0,
      });
      // a concurrent main-line message advances the conversation-global seq
      // but is in a DIFFERENT stream — it must NOT appear in the thread's
      // stale newer_messages.
      t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'unrelated main message',
      });
      // a second thread reply advances the thread head past `firstReply`
      const secondReply = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'newer thread reply',
        threadRootId: root.id,
      });
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          content: 'stale thread draft',
          replyToMessageId: root.id,
          seenUpToSeq: firstReply.message.seq,
        }),
      ).rejects.toMatchObject({
        code: 'message_stale',
        currentSeq: secondReply.seq,
        newerMessages: [
          expect.objectContaining({ content: 'newer thread reply' }),
        ],
      });
    } finally {
      t.cleanup();
    }
  });

  it('logs explicit stale retry reasons without making telemetry a send gate', async () => {
    const t = bootstrap();
    try {
      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'revised reply',
        staleEventId: 'evt-revised',
        staleResolutionReason: 'revised',
      });

      expect(result.message.content).toBe('revised reply');
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          staleEventId: 'evt-revised',
          resolutionReason: 'revised',
          outcome: 'message_sent',
          messageId: result.message.id,
          messageSeq: result.message.seq,
        }),
        'conversation-message-service: stale send resolution observed',
      );
    } finally {
      t.cleanup();
    }
  });

  it('logs unattributed stale retry sends when the agent omits a reason', async () => {
    const t = bootstrap();
    try {
      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'retry without reason',
        staleEventId: 'evt-unattributed',
      });

      expect(result.message.content).toBe('retry without reason');
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          staleEventId: 'evt-unattributed',
          resolutionReason: 'unattributed',
          outcome: 'message_sent',
          messageId: result.message.id,
          messageSeq: result.message.seq,
        }),
        'conversation-message-service: stale send resolution observed',
      );
    } finally {
      t.cleanup();
    }
  });

  it('logs obsolete stale resolutions without sending a message', async () => {
    const t = bootstrap();
    try {
      t.service.resolveStaleMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        staleEventId: 'evt-obsolete',
        resolutionReason: 'obsolete',
      });

      expect(t.messages.listForConversation(t.channel.id)).toEqual([]);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          staleEventId: 'evt-obsolete',
          resolutionReason: 'obsolete',
          outcome: 'obsolete',
          messageId: null,
          messageSeq: null,
        }),
        'conversation-message-service: stale send resolution observed',
      );
    } finally {
      t.cleanup();
    }
  });

  it('sends an agent message to parent and resolves the source run, not the target', async () => {
    const t = bootstrap();
    try {
      const thread = t.conversations.insertThread({
        channelId: t.channel.id,
        title: 'thread',
      });
      t.conversations.addAgent(thread.id, t.alice.id);

      const result = await t.service.sendMessage({
        conversationId: thread.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: thread.id },
        content: 'parent update',
        target: 'parent',
      });

      expect(result.targetConversationId).toBe(t.channel.id);
      expect(t.messages.listForConversation(t.channel.id).map(m => m.content))
        .toContain('parent update');
      expect(t.fake.resolvedRuns).toEqual([
        { conversationId: thread.id, agentId: t.alice.id, reason: 'replied' },
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('agent cross-target send to parent auto-starts target idle members including the sender session in the target', async () => {
    // Regression for the "thread → parent forward did not wake parent
    // members" bug. The (thread, alice) process is the sender. The
    // target is the parent channel where another (channel, alice)
    // session exists alongside (channel, bob). Both must be woken AND
    // both must receive the message in their inbox; sender exclusion
    // is a same-conversation echo guard and does not apply here. The
    // (channel, alice) session is a *different* process from the
    // (thread, alice) sender and only it will see the inbox arriving
    // in the channel.
    const t = bootstrap();
    try {
      const thread = t.conversations.insertThread({
        channelId: t.channel.id,
        title: 'thread',
      });
      t.conversations.addAgent(thread.id, t.alice.id);

      await t.service.sendMessage({
        conversationId: thread.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: thread.id },
        content: 'forward to parent',
        target: 'parent',
      });

      expect(t.fake.starts.map(s => ({ c: s.conversationId, a: s.agentId })).sort(
        (x, y) => (x.c + x.a).localeCompare(y.c + y.a),
      )).toEqual(
        [
          { c: t.channel.id, a: t.alice.id },
          { c: t.channel.id, a: t.bob.id },
        ].sort((x, y) => (x.c + x.a).localeCompare(y.c + y.a)),
      );
      expect(t.fake.delivered.map(d => ({ c: d.conversationId, a: d.agentId })).sort(
        (x, y) => (x.c + x.a).localeCompare(y.c + y.a),
      )).toEqual(
        [
          { c: t.channel.id, a: t.alice.id },
          { c: t.channel.id, a: t.bob.id },
        ].sort((x, y) => (x.c + x.a).localeCompare(y.c + y.a)),
      );
    } finally {
      t.cleanup();
    }
  });

  it('sends an agent message to a direct child thread', async () => {
    const t = bootstrap();
    try {
      const thread = t.conversations.insertThread({
        channelId: t.channel.id,
        title: 'thread',
      });
      t.conversations.addAgent(thread.id, t.alice.id);
      t.conversations.addAgent(thread.id, t.bob.id);

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'down',
        target: { thread_id: thread.id },
      });

      expect(result.targetConversationId).toBe(thread.id);
      expect(t.messages.listForConversation(thread.id).map(m => m.content))
        .toContain('down');
      // Cross-target send: delivery does NOT exclude the sender's agent id.
      // (channel, alice) and (thread, alice) are different processes;
      // (thread, alice) must receive the message in its inbox or it
      // wakes without anything to process. See @Cindy review of `f28ed08`.
      expect(t.fake.delivered.map(d => d.agentId).sort()).toEqual(
        [t.alice.id, t.bob.id].sort(),
      );
    } finally {
      t.cleanup();
    }
  });

  it('agent cross-target send to a child thread auto-starts the thread members including the sender session in the thread', async () => {
    // Mirror of the parent-direction test, for the more common case:
    // channel agent forwards work into a thread. The (thread, alice)
    // session and the (thread, bob) session both must wake AND receive
    // the message — sender exclusion is a same-conversation echo
    // guard and must not apply here.
    const t = bootstrap();
    try {
      const thread = t.conversations.insertThread({
        channelId: t.channel.id,
        title: 'thread',
      });
      t.conversations.addAgent(thread.id, t.alice.id);
      t.conversations.addAgent(thread.id, t.bob.id);

      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'down to thread',
        target: { thread_id: thread.id },
      });

      expect(t.fake.starts.map(s => ({ c: s.conversationId, a: s.agentId })).sort(
        (x, y) => (x.c + x.a).localeCompare(y.c + y.a),
      )).toEqual(
        [
          { c: thread.id, a: t.alice.id },
          { c: thread.id, a: t.bob.id },
        ].sort((x, y) => (x.c + x.a).localeCompare(y.c + y.a)),
      );
      expect(t.fake.delivered.map(d => ({ c: d.conversationId, a: d.agentId })).sort(
        (x, y) => (x.c + x.a).localeCompare(y.c + y.a),
      )).toEqual(
        [
          { c: thread.id, a: t.alice.id },
          { c: thread.id, a: t.bob.id },
        ].sort((x, y) => (x.c + x.a).localeCompare(y.c + y.a)),
      );
    } finally {
      t.cleanup();
    }
  });

  it('rejects invalid agent targets', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          content: 'up',
          target: 'parent',
        }),
      ).rejects.toMatchObject({ code: 'no_parent' });

      const siblingParent = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'sibling parent',
      });
      t.conversations.addAgent(siblingParent.id, t.alice.id);
      const siblingThread = t.conversations.insertThread({
        channelId: siblingParent.id,
        title: 'sibling',
      });
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          content: 'sideways',
          target: { thread_id: siblingThread.id },
        }),
      ).rejects.toMatchObject({ code: 'thread_not_child' });

      t.db.prepare(`UPDATE conversations SET closed_at = ? WHERE id = ?`)
        .run(Date.now(), siblingThread.id);
      await expect(
        t.service.sendMessage({
          conversationId: siblingParent.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: siblingParent.id },
          content: 'closed',
          target: { thread_id: siblingThread.id },
        }),
      ).rejects.toBeInstanceOf(TargetError);
    } finally {
      t.cleanup();
    }
  });

  it('rejects missing or forged agent actors', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: 'missing-agent', conversationId: t.channel.id },
          content: 'x',
        }),
      ).rejects.toMatchObject({ code: 'agent_not_found' });

      const outsider = t.agents.create(
        { name: 'outsider', runtime: 'claude' },
        t.alice.host_id,
        'local',
      );
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: outsider.id, conversationId: t.channel.id },
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(ActorError);
    } finally {
      t.cleanup();
    }
  });

  it('publishes before best-effort delivery and returns even when delivery hangs', async () => {
    const t = bootstrap();
    try {
      const order: string[] = [];
      t.fake.hangDeliver = true;
      t.fake.onDeliver = () => order.push('deliver');
      const unsub = t.events.subscribe(t.channel.id, e => {
        if (e.kind === 'message') order.push('publish');
      });

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'still returns',
      });
      unsub();

      expect(result.message.content).toBe('still returns');
      expect(order[0]).toBe('publish');
      expect(order).toContain('deliver');
    } finally {
      t.cleanup();
    }
  });

  it('swallows delivery errors after publish', async () => {
    const t = bootstrap();
    try {
      t.fake.deliverError = new Error('deliver failed');
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          content: 'deliver fail',
        }),
      ).resolves.toMatchObject({ message: { content: 'deliver fail' } });
      expect(t.logger.warn).toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  // ── Thread reply-cluster durable semantics (cut2 段1) ──────────────────
  // Red lines (Cindy): (1) non-follower thread reply writes no inbox / no
  // wake, and a follower that lost channel membership is filtered out;
  // (2) a mentioned member is followed + backfilled in the same tx before the
  // current reply, and `source` is immutable; (3) a member pulled in mid-thread
  // catches up prior replies by seq, idempotent, with no duplicate of the
  // current delivery. Stream-isolation of stale `newer_messages` (5) is
  // covered by the freshness tests above.

  it('delivers a thread reply only to followers — observe writes inbox without waking; non-followers get nothing', async () => {
    const t = bootstrap();
    try {
      const carol = t.agents.create(
        { name: 'carol', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      t.workspaces.insertMembership(t.workspace.id, carol.id);
      t.conversations.addAgent(t.channel.id, carol.id);

      // Root authored by bob (agent), inserted directly so its own send does
      // not pollute the fake's delivered/starts records.
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'bob root',
      });

      // alice replies → alice follows (reply), bob follows (target_author).
      // carol is a member but follows nothing.
      const reply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'alice reply',
        replyToMessageId: root.id,
      });
      expect(reply.message.thread_root_id).toBe(root.id);

      // bob is a follower but NOT mentioned → observe: a durable inbox row,
      // never a deliverMessage (no wake) and never an auto-start.
      await waitFor(() =>
        t.conversationInboxes
          .listPending(t.channel.id, t.bob.id)
          .some(i => i.message.id === reply.message.id),
      );
      expect(
        t.fake.delivered.some(
          d => d.agentId === t.bob.id && d.messageId === reply.message.id,
        ),
      ).toBe(false);
      expect(t.fake.starts.some(s => s.agentId === t.bob.id)).toBe(false);

      // carol is not a follower → no inbox row, no delivery, no follow record.
      expect(t.conversationInboxes.listPending(t.channel.id, carol.id)).toEqual([]);
      expect(
        t.fake.delivered.some(d => d.agentId === carol.id),
      ).toBe(false);
      expect(t.threadFollowers.isFollower(root.id, 'agent', carol.id)).toBe(false);

      // followers recorded: alice (reply), bob (target_author).
      const followers = t.threadFollowers.listFollowers(root.id);
      expect(
        followers
          .filter(f => f.principal_kind === 'agent')
          .map(f => [f.principal_id, f.source])
          .sort(),
      ).toEqual(
        [
          [t.alice.id, 'reply'],
          [t.bob.id, 'target_author'],
        ].sort(),
      );
    } finally {
      t.cleanup();
    }
  });

  it('does not deliver a thread reply to a follower that lost channel membership', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'bob root',
      });
      // alice replies → alice + bob become followers.
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'alice reply',
        replyToMessageId: root.id,
      });
      // bob leaves the channel; his follower row lingers but is not authoritative.
      t.conversations.removeAgent(t.channel.id, t.bob.id);
      expect(t.threadFollowers.isFollower(root.id, 'agent', t.bob.id)).toBe(true);

      // alice posts another thread reply. bob is a follower-of-record but no
      // longer a channel member → must be filtered out of delivery entirely.
      const second = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'second reply',
        replyToMessageId: root.id,
      });
      // give any post-commit delivery a chance to run, then assert bob got none.
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(
        t.conversationInboxes
          .listPending(t.channel.id, t.bob.id)
          .some(i => i.message.id === second.message.id),
      ).toBe(false);
      expect(
        t.fake.delivered.some(
          d => d.agentId === t.bob.id && d.messageId === second.message.id,
        ),
      ).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('follows + backfills a mentioned member in the same tx, then delivers the current reply as a turn', async () => {
    const t = bootstrap();
    try {
      const carol = t.agents.create(
        { name: 'carol', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      t.workspaces.insertMembership(t.workspace.id, carol.id);
      t.conversations.addAgent(t.channel.id, carol.id);

      // Build a thread: root (bob) + reply1 (alice), before carol is involved.
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'root',
      });
      const reply1 = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'reply one',
        replyToMessageId: root.id,
      });

      // bob mentions @carol in a thread reply: carol is followed (mention) and
      // backfilled with prior thread history (root + reply1) inside the tx,
      // THEN the current reply is delivered to her as a turn.
      const mentionReply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: '@carol please look',
        replyToMessageId: reply1.message.id,
      });

      // follower with source 'mention'.
      const carolFollow = t.threadFollowers
        .listFollowers(root.id)
        .find(f => f.principal_id === carol.id);
      expect(carolFollow?.source).toBe('mention');

      // Backfill is synchronous (in-tx): root + reply1 are already in carol's
      // inbox by the time send resolves, ordered by seq, excluding the current
      // reply (delivered as a turn, never double-enqueued).
      const backfilled = t.conversationInboxes
        .listPending(t.channel.id, carol.id)
        .map(i => i.message.id);
      expect(backfilled).toEqual([root.id, reply1.message.id]);
      expect(backfilled).not.toContain(mentionReply.message.id);

      // current reply reaches carol as a turn (deliverMessage → wake).
      await waitFor(() =>
        t.fake.delivered.some(
          d => d.agentId === carol.id && d.messageId === mentionReply.message.id,
        ),
      );
    } finally {
      t.cleanup();
    }
  });

  it('keeps follower source immutable and does not re-backfill on a repeat follow', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'root',
      });
      // alice follows via reply.
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'alice reply',
        replyToMessageId: root.id,
      });
      const before = t.conversationInboxes
        .listPending(t.channel.id, t.alice.id)
        .map(i => i.message.id);

      // bob now mentions @alice in a thread reply. alice is already a follower
      // → ON CONFLICT DO NOTHING: source stays 'reply', no re-backfill.
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: '@alice ping',
        replyToMessageId: root.id,
      });

      const aliceFollow = t.threadFollowers
        .listFollowers(root.id)
        .find(f => f.principal_id === t.alice.id);
      expect(aliceFollow?.source).toBe('reply');

      // The repeat follow must not have re-enqueued the historical backfill
      // (root). alice's pending set grew only by the current mention turn —
      // which is delivered via deliverMessage, not the inbox — so the inbox
      // backfill set is unchanged.
      const after = t.conversationInboxes
        .listPending(t.channel.id, t.alice.id)
        .map(i => i.message.id);
      expect(after.filter(id => id === root.id)).toEqual(
        before.filter(id => id === root.id),
      );
    } finally {
      t.cleanup();
    }
  });

  it('backfills a mid-thread follower by seq, idempotently, excluding own + current messages', async () => {
    const t = bootstrap();
    try {
      const carol = t.agents.create(
        { name: 'carol', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      t.workspaces.insertMembership(t.workspace.id, carol.id);
      t.conversations.addAgent(t.channel.id, carol.id);

      // root (bob) + reply1 (alice) + reply2 (carol's OWN) + reply3 (bob).
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'root',
      });
      const reply1 = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'reply one',
        replyToMessageId: root.id,
      });
      // carol's own in-thread message, inserted directly (bypassing the
      // service) so it does NOT register a follow — carol stays a non-follower
      // until the mention below. Backfill must exclude this, her own message.
      const carolOwn = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: carol.id,
        content: 'carol own (pre-follow)',
        threadRootId: root.id,
      });
      const reply3 = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: 'reply three',
        replyToMessageId: root.id,
      });

      // Now pull carol in mid-thread via mention. Backfill must include
      // root + reply1 + reply3 (seq < current), ordered by seq, and EXCLUDE
      // carol's own message and the current mention reply.
      const mention = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: '@carol catch up',
        replyToMessageId: root.id,
      });

      const inbox = t.conversationInboxes
        .listPending(t.channel.id, carol.id)
        .map(i => i.message.id);
      expect(inbox).toEqual([root.id, reply1.message.id, reply3.message.id]);
      expect(inbox).not.toContain(carolOwn.id);
      expect(inbox).not.toContain(mention.message.id);
    } finally {
      t.cleanup();
    }
  });
});
