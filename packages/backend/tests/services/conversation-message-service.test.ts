import { describe, expect, it, vi } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { SettingsRepo } from '../../src/repos/settings-repo.js';
import { UserRepo } from '../../src/repos/user-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AttachmentService } from '../../src/services/attachment-service.js';
import {
  ActorError,
  AttachmentError,
  ConversationError,
  ConversationMessageService,
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
  hangDeliver = false;
  onDeliver: (() => void) | null = null;

  async start(conversationId: string, agentId: string): Promise<void> {
    this.starts.push({ conversationId, agentId });
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
  const messages = new MessageRepo(db);
  const notifications = new NotificationRepo(db);
  const settings = new SettingsRepo(db);
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
    messages,
    agents,
    users,
    settings,
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
  workspaces.addMember(workspace.id, alice.id);
  workspaces.addMember(workspace.id, bob.id);
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
    attachments,
    agents,
    workspaces,
    conversations,
    messages,
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

      expect(t.notifications.list({ unread: true })).toEqual([
        expect.objectContaining({
          kind: 'mention_self',
          conversation_id: t.channel.id,
          message_id: result.message.id,
          source_conversation_id: t.channel.id,
          source_message_id: result.message.id,
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

      expect(t.notifications.list({ unread: true })).toEqual([]);
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
});
