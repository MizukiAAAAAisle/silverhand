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
import { createSqliteConversationPersistence } from '../../src/repos/conversation-persistence.js';
import { createUnreadPublishAdapter } from '../../src/adapters/unread-publish.js';
import {
  ActorError,
  ConversationError,
  ConversationMessageService,
  PolicyError,
} from '../../src/services/conversation-message-service.js';
import type { MessageTxScope } from '../../src/services/conversation-message/ports.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { writeMentionCcCopies } from '../../src/application/mention-cc.js';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';
import { PrincipalConversationMismatchError } from '../../src/auth/principal.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import { overrideScope, uowWithScopeWrap } from '../utils/tx-fault.js';

// v71 (#task:2014): the mention CC is no longer a post-commit port call but a
// WRITE INSIDE the send transaction, so the seam this file mocks moved from the
// adapter to the two module functions. The stub returns an empty report because
// this suite is about the send's own contract — what the CC itself writes is
// `tests/services/mention-cc.test.ts`, on the real thing.
vi.mock('../../src/application/mention-cc.js', () => ({
  writeMentionCcCopies: vi.fn(
    (
      _tx: unknown,
      input: { message: { id: string }; sourceConversation: { id: string } },
    ) => ({
      copies: [],
      skipped: [],
      source: {
        conversationId: input.sourceConversation.id,
        messageId: input.message.id,
      },
    }),
  ),
  dispatchMentionCcEffects: vi.fn(async () => {}),
}));

// #task:2000 (Cindy round-2 MUST FIX 1): the REAL parser, spy-wrapped. The send
// boundary owns the single derivation of "who does this message address" and
// hands the resulting set to thread auto-follow / the `mention_self`
// notification / the cross-channel CC as a required argument. Wrapping instead
// of stubbing keeps every other test in this file on production behavior, while
// making a re-parse by any consumer observable as a second call.
vi.mock('@silverhand/shared/reference-markdown', async importOriginal => {
  const actual = await importOriginal<
    typeof import('@silverhand/shared/reference-markdown')
  >();
  return {
    ...actual,
    extractMessageReferences: vi.fn(actual.extractMessageReferences),
  };
});

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

  pendingDrives: Array<{ conversationId: string; agentId: string }> = [];
  async deliverPending(conversationId: string, agentId: string): Promise<boolean> {
    this.pendingDrives.push({ conversationId, agentId });
    return true;
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
  vi.mocked(writeMentionCcCopies).mockClear();
  vi.mocked(extractMessageReferences).mockClear();
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const hosts = new HostRepo(db);
  hosts.ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const conversationInboxes = new ConversationInboxRepo(db);
  const messages = new MessageRepo(db);
  const threadFollowers = new ThreadFollowerRepo(db);
  const notifications = new NotificationRepo(db);
  const users = new UserRepo(db);
  const attachments = new AttachmentRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const persistence = createSqliteConversationPersistence(db);
  // #task:1981 §9: the only persistence seam the service still exposes is the
  // tx scope. `txWrap.current` is read per transaction, so a test arms its
  // fault / authority swap AFTER its setup writes committed normally.
  const txWrap: { current: ((tx: MessageTxScope) => MessageTxScope) | null } = { current: null };
  const service = new ConversationMessageService({
    uow: uowWithScopeWrap(persistence.message.uow, () => txWrap.current),
    threadFollow: persistence.threadFollow,
    delivery: persistence.delivery,
    unreadPublish: createUnreadPublishAdapter({ db, events }),
    runtimeHost: fake as unknown as AgentRuntimeHost,
    events,
    logger,
  });
  const workspace = workspaces.insert({
    name: 'eng',
    description: null,
  });
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, alice.id);
  workspaces.insertMembership(workspace.id, bob.id);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
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
    persistence,
    txWrap,
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
        // The plain `@handle` alias addresses nobody (#task:2000), so this
        // stays an undirected user message: both agents are woken.
        content: 'hello @alice',
      });
      unsubConversation();
      unsubViewer();

      expect(result.targetConversationId).toBe(t.channel.id);
      expect(result.committed.message.from_kind).toBe('user');
      expect(t.fake.delivered.map(d => d.agentId).sort()).toEqual(
        [t.alice.id, t.bob.id].sort(),
      );
      expect(t.fake.starts.map(s => s.agentId).sort()).toEqual(
        [t.alice.id, t.bob.id].sort(),
      );
      expect(vi.mocked(writeMentionCcCopies)).toHaveBeenCalledTimes(1);
      expect(conversationEvents[0]).toMatchObject({
        kind: 'message',
        payload: { message: { id: result.committed.message.id } },
      });
      // #task:1283: the message variant now carries authoritative absolute
      // unread counts (enriched), keyed by conversation_id (the discriminator).
      const unread = viewerEvents.find(
        e =>
          e.kind === 'unread_updated' &&
          (e.payload as { conversation_id?: string }).conversation_id ===
            t.channel.id,
      );
      expect(unread?.payload).toMatchObject({
        conversation_id: t.channel.id,
        workspace_id: expect.any(String),
        conversation_unread_count: expect.any(Number),
        workspace_unread_count: expect.any(Number),
      });
      expect(unread?.payload).toHaveProperty('latest_unread');
    } finally {
      t.cleanup();
    }
  });

  // #task:1283: the enriched payload is computed PER VIEWER inside the fan-out
  // loop, not once and reused. The sharpest regression: one arrival must yield
  // DIFFERENT absolutes for two humans — the sender sees 0 (own message never
  // unread), the other human sees exactly this one message. If the payload were
  // hoisted out of the viewer loop, both would share one (wrong) count.
  it('computes per-viewer absolutes for one arrival: sender=0/null, other human=1/pointer', async () => {
    const t = bootstrap();
    try {
      // A second human member alongside the implicit `local` sender.
      t.conversations.addUser(t.channel.id, 'teammate');

      const localEvents: Array<{ kind: string; payload: any }> = [];
      const teammateEvents: Array<{ kind: string; payload: any }> = [];
      const unsubLocal = t.events.subscribeScope('viewer:local', e => {
        localEvents.push({ kind: e.kind, payload: e.payload });
      });
      const unsubTeammate = t.events.subscribeScope('viewer:teammate', e => {
        teammateEvents.push({ kind: e.kind, payload: e.payload });
      });

      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'hello team',
      });
      unsubLocal();
      unsubTeammate();

      const pick = (evts: Array<{ kind: string; payload: any }>) =>
        evts.find(
          e =>
            e.kind === 'unread_updated' &&
            (e.payload as { conversation_id?: string }).conversation_id ===
              t.channel.id,
        )?.payload;

      // Sender: their own message is never unread for them.
      expect(pick(localEvents)).toMatchObject({
        conversation_id: t.channel.id,
        conversation_unread_count: 0,
        workspace_unread_count: 0,
        latest_unread: null,
      });
      // Other human: exactly one unread — this message — with a real pointer.
      expect(pick(teammateEvents)).toMatchObject({
        conversation_id: t.channel.id,
        conversation_unread_count: 1,
        workspace_unread_count: 1,
        latest_unread: {
          conversation_id: t.channel.id,
          message_id: result.committed.message.id,
          thread_root_id: null,
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
        content: 'can you check this, <silverhand://human/local-test>?',
      });
      unsubViewer();

      expect(t.notifications.list({ userId: 'local', unread: true })).toEqual([
        expect.objectContaining({
          kind: 'mention_self',
          user_id: 'local',
          conversation_id: t.channel.id,
          message_id: result.committed.message.id,
          source_conversation_id: t.channel.id,
          source_message_id: result.committed.message.id,
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
          message_id: result.committed.message.id,
        },
      });
    } finally {
      t.cleanup();
    }
  });

  it('notifies the viewer for a thread-reply mention, carrying the thread root (#task:1227 §5.1)', async () => {
    // The directed "@me" source for the Attention/Activity read model is this
    // existing `mention_self` notification — including inside a reply-cluster.
    // A thread reply lives in the parent CHANNEL conversation (conversation_id =
    // channel, not a separate thread conversation); the notification's
    // thread_root_id is derived from the message via the repo's LEFT JOIN, so
    // the source ref still points at the correct thread. #1227 consumes this
    // contract; it does NOT add a second emission.
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'root question',
      });
      const viewerEvents: Array<{ kind: string; payload: any }> = [];
      const unsubViewer = t.events.subscribeScope('viewer:local', e => {
        viewerEvents.push({ kind: e.kind, payload: e.payload });
      });

      const reply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'in the thread: <silverhand://human/local-test> can you take this?',
        target: { kind: 'thread', message_id: root.id },
      });
      unsubViewer();

      expect(reply.committed.message.thread_root_id).toBe(root.id);
      const notifications = t.notifications.list({ userId: 'local', unread: true });
      expect(notifications).toEqual([
        expect.objectContaining({
          kind: 'mention_self',
          user_id: 'local',
          conversation_id: t.channel.id,
          message_id: reply.committed.message.id,
          // Derived from the replied message — routes Activity to the thread.
          thread_root_id: root.id,
          source_conversation_id: t.channel.id,
          source_message_id: reply.committed.message.id,
          read_at: null,
        }),
      ]);
      expect(viewerEvents).toContainEqual({
        kind: 'notification',
        payload: {
          kind: 'mention_self',
          conversation_id: t.channel.id,
          message_id: reply.committed.message.id,
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
        content: 'note to <silverhand://human/local-test>',
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
          source_message_id: result.committed.message.id,
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
          source_message_id: result.committed.message.id,
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
          attachmentRefs: [{ id: foreign.id }],
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
        attachmentRefs: [{ id: attachment.id, label: 'Image #1' }],
      });

      expect(result.committed.message.attachments).toEqual([
        {
          id: attachment.id,
          filename: 'ok.png',
          size: 12,
          content_type: 'image/png',
          label: 'Image #1',
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
          target: 'self',
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

      expect(result.committed.message.from_kind).toBe('agent');
      expect(result.committed.message.from_agent_id).toBe(t.alice.id);
      expect(t.fake.delivered.map(d => d.agentId)).toEqual([t.bob.id]);
      expect(t.fake.starts).toEqual([]);
      expect(t.fake.resolvedRuns).toEqual([
        { conversationId: t.channel.id, agentId: t.alice.id, reason: 'replied' },
      ]);
      expect(vi.mocked(writeMentionCcCopies)).not.toHaveBeenCalled();
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

      expect(result.committed.message.content).toBe('send anyway');
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
          messageId: result.committed.message.id,
          messageSeq: result.committed.message.seq,
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
        target: { kind: 'thread', message_id: root.id },
      });
      expect(result.committed.message.thread_root_id).toBe(root.id);
      // a reply to that reply joins the SAME root (no nested threads)
      const nested = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: 'follow-up',
        target: { kind: 'thread', message_id: result.committed.message.id },
      });
      expect(nested.committed.message.thread_root_id).toBe(root.id);
    } finally {
      t.cleanup();
    }
  });

  it('accepts a matching asserted stream_key and rejects a mismatched one', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'root question',
      });
      // Matching assertion (daemon resolved thread:<root> for a reply to root)
      // passes through.
      const ok = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'threaded answer',
        target: { kind: 'thread', message_id: root.id },
        assertedStreamKey: `thread:${root.id}`,
        seenUpToSeq: 0,
      });
      expect(ok.committed.message.thread_root_id).toBe(root.id);
      // A main-line send asserting 'main' also passes.
      const mainOk = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: 'main line',
        assertedStreamKey: 'main',
        seenUpToSeq: root.seq,
      });
      expect(mainOk.committed.message.thread_root_id).toBeNull();
      // A mismatched assertion (daemon thinks main, backend resolves a thread)
      // hard-rejects.
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          content: 'wrong stream',
          target: { kind: 'thread', message_id: root.id },
          assertedStreamKey: 'main',
          seenUpToSeq: 0,
        }),
      ).rejects.toMatchObject({ code: 'stream_key_mismatch' });
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
          target: { kind: 'thread', message_id: 'does-not-exist' },
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
        target: { kind: 'thread', message_id: root.id },
        seenUpToSeq: 0,
      });
      const result = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'main-line answer',
        seenUpToSeq: root.seq,
      });
      expect(result.committed.message.content).toBe('main-line answer');
      expect(result.committed.message.thread_root_id).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('stale reply scopes the unseen count to the same thread stream and materializes the window as normal observe deliveries', async () => {
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
        target: { kind: 'thread', message_id: root.id },
        seenUpToSeq: 0,
      });
      // a concurrent main-line message advances the conversation-global seq
      // but is in a DIFFERENT stream — it must NOT count into the thread's
      // unseen window.
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
          target: { kind: 'thread', message_id: root.id },
          seenUpToSeq: firstReply.committed.message.seq,
        }),
      ).rejects.toMatchObject({
        code: 'message_stale',
        currentSeq: secondReply.seq,
      });
      // Contract 3 (no signal-only deadlock): the window rows the signal
      // asks alice to wait for now exist as NORMAL observe deliveries —
      // the same rows a later follow-backfill would ensureDelivery
      // idempotently.
      const pendingForAlice = t.conversationInboxes.listPending(
        t.channel.id,
        t.alice.id,
      );
      expect(
        pendingForAlice.filter(pi => pi.message.id === secondReply.id),
      ).toHaveLength(1);
      expect(
        pendingForAlice.find(pi => pi.message.id === secondReply.id)!.deliveryKind,
      ).toBe('observe');
      // C1-gate P1-1: the rows must MOVE, not just exist — the 409 path
      // drives the live delivery plane so a mid-turn agent (no future
      // ready_for_drain guarantee) still receives the window.
      await new Promise(res => setImmediate(res));
      expect(t.fake.pendingDrives).toContainEqual({
        conversationId: t.channel.id,
        agentId: t.alice.id,
      });
      // Successful retry runs follow-backfill — it must hit the SAME row,
      // never a second one.
      // ensureDelivery is idempotent — use it as the row lookup.
      const before = t.conversationInboxes.ensureDelivery(
        t.channel.id,
        t.alice.id,
        secondReply.id,
      ).inboxId;
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'informed retry',
        target: { kind: 'thread', message_id: root.id },
        seenUpToSeq: secondReply.seq,
      });
      expect(
        t.conversationInboxes.ensureDelivery(t.channel.id, t.alice.id, secondReply.id)
          .inboxId,
      ).toBe(before);
    } finally {
      t.cleanup();
    }
  });

  it('C1-gate P1-2: materialization failure fails CLOSED — no fabricated message_stale signal', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'root',
      });
      const firstReply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: 'prior reply',
        target: { kind: 'thread', message_id: root.id },
        seenUpToSeq: 0,
      });
      t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'newer reply',
        threadRootId: root.id,
      });
      // The failure must be injected on the TX SCOPE: after #task:1981 the
      // service materializes through `tx.inboxes`, so that is the only place a
      // delivery-row write can fail from.
      t.txWrap.current = tx =>
        overrideScope(tx, {
          inboxes: {
            ensureDelivery: () => {
              throw new Error('disk full');
            },
          },
        });
      // A signal that promises "wait for delivery" while the delivery row
      // could not be created is a fabricated promise — the send must fail
      // with the underlying error, NOT message_stale.
      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
          content: 'stale draft',
          target: { kind: 'thread', message_id: root.id },
          seenUpToSeq: firstReply.committed.message.seq,
        }),
      ).rejects.toThrowError('disk full');
      vi.restoreAllMocks();
    } finally {
      vi.restoreAllMocks();
      t.cleanup();
    }
  });

  it('bypass sends return stream_head_before as the merge prerequisite; normal sends do not (countgame bypass-hole P1)', async () => {
    const t = bootstrap();
    try {
      const observed = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'observed',
      });
      const gap = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'unseen gap',
      });

      const forced = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'forced',
        seenUpToSeq: observed.seq,
        freshnessBypass: true,
      });
      // The head at insert time = everything freshness-relevant the
      // sender skipped — the daemon merges the own seq once its observed
      // covers this value (sender is excluded from its own fan-out, so
      // the forced seq never arrives by inbox).
      expect(forced.streamHeadBeforeSend).toBe(gap.seq);

      const normal = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'normal',
        seenUpToSeq: forced.committed.message.seq,
      });
      expect(normal.streamHeadBeforeSend).toBeUndefined();
    } finally {
      t.cleanup();
    }
  });

  it('bypass reply returns the THREAD stream head, not the main-line head (per-stream scoping falsifier, #task:1749)', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'root question',
      });
      // Advance the THREAD head: a reply lands in root's stream.
      const threadReply = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'earlier thread reply',
        threadRootId: root.id,
      });
      // Advance the MAIN-LINE head PAST the thread head with an unrelated
      // main-line message. This is the trap value: if the bypass branch
      // captured the head with a null (main-line) thread scope instead of
      // `threadRootId`, `streamHeadBeforeSend` would be this seq.
      const mainGap = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'unrelated main-line gap',
      });
      expect(mainGap.seq).toBeGreaterThan(threadReply.seq);

      const forced = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'forced thread reply',
        target: { kind: 'thread', message_id: root.id },
        seenUpToSeq: root.seq,
        freshnessBypass: true,
      });

      // The bypass send is a thread reply, so the merge prerequisite is the
      // THREAD stream head at insert time — everything in THIS thread the
      // sender skipped — not the higher main-line head.
      expect(forced.committed.message.thread_root_id).toBe(root.id);
      expect(forced.streamHeadBeforeSend).toBe(threadReply.seq);
      expect(forced.streamHeadBeforeSend).not.toBe(mainGap.seq);
    } finally {
      t.cleanup();
    }
  });

  it('a loose first-touch send (no seenUpToSeq) returns stream_head_before too — every skipped CAS owes the merge prerequisite (#task:1854)', async () => {
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'root question',
      });
      const threadReply = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'a reply the agent never observed',
        threadRootId: root.id,
      });
      // Trap value: a main-line head ABOVE the thread head. A prerequisite
      // captured with a null (main-line) scope would be this seq.
      const mainGap = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'unrelated main-line gap',
      });
      expect(mainGap.seq).toBeGreaterThan(threadReply.seq);

      // The daemon has never observed this cluster, so it omits BOTH freshness
      // fields rather than claim a false `seen`. The insert therefore skips the
      // CAS — and, exactly like a bypass, proves nothing about what the sender
      // covers. Without the prerequisite the sender is stuck: nothing ever
      // delivers its own seq back to it, so its next send in this cluster
      // 409s against its own message forever.
      const firstTouch = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'first touch of an unseen cluster',
        target: { kind: 'thread', message_id: root.id },
      });

      expect(firstTouch.committed.message.thread_root_id).toBe(root.id);
      expect(firstTouch.streamHeadBeforeSend).toBe(threadReply.seq);
      expect(firstTouch.streamHeadBeforeSend).not.toBe(mainGap.seq);

      // Same on the main line: an agent that speaks before reading anything.
      const mainFirstTouch = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'first thing I ever say',
      });
      expect(mainFirstTouch.streamHeadBeforeSend).toBe(mainGap.seq);

      // A user send has no per-stream cursor, so there is nothing to merge.
      const fromUser = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'human line',
      });
      expect(fromUser.streamHeadBeforeSend).toBeUndefined();

      // The COMMON first touch: first reply in a cluster that has none yet, so
      // the thread head is 0 while the main-line head is well above it. Zero
      // must be RETURNED, not treated as "no value" — the daemon reads it as
      // "nothing to cover" and merges the own seq immediately (Cindy/Norman
      // review of #task:1854).
      const quietRoot = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        content: 'a root nobody has replied to',
      });
      const firstReply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'first reply in an empty cluster',
        target: { kind: 'thread', message_id: quietRoot.id },
      });
      expect(firstReply.committed.message.thread_root_id).toBe(quietRoot.id);
      expect(firstReply.streamHeadBeforeSend).toBe(0);
      expect(quietRoot.seq).toBeGreaterThan(0);
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

      expect(result.committed.message.content).toBe('revised reply');
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          staleEventId: 'evt-revised',
          resolutionReason: 'revised',
          outcome: 'message_sent',
          messageId: result.committed.message.id,
          messageSeq: result.committed.message.seq,
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

      expect(result.committed.message.content).toBe('retry without reason');
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          staleEventId: 'evt-unattributed',
          resolutionReason: 'unattributed',
          outcome: 'message_sent',
          messageId: result.committed.message.id,
          messageSeq: result.committed.message.seq,
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

      expect(result.committed.message.content).toBe('still returns');
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
      ).resolves.toMatchObject({ committed: { message: { content: 'deliver fail' } } });
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

  it('wakes visible follower agents for every current thread reply', async () => {
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

      // A human starts a thread under bob's message. bob becomes a
      // target_author follower now; current thread delivery aligns with
      // channel delivery, so visible follower agents receive a turn.
      // carol is a member but follows nothing.
      const reply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'human reply',
        target: { kind: 'thread', message_id: root.id },
      });
      expect(reply.committed.message.thread_root_id).toBe(root.id);

      await waitFor(() =>
        t.fake.delivered.some(
          d => d.agentId === t.bob.id && d.messageId === reply.committed.message.id,
        ),
      );
      expect(t.fake.starts.some(s => s.agentId === t.bob.id)).toBe(false);
      t.fake.delivered = [];

      // A later ordinary reply to the same thread still turns bob because
      // thread current-message delivery mirrors channel delivery over the
      // follower set. `observe` is reserved for backfill/pull history.
      const second = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'plain follow-up',
        target: { kind: 'thread', message_id: root.id },
      });
      await waitFor(() =>
        t.fake.delivered.some(
          d => d.agentId === t.bob.id && d.messageId === second.committed.message.id,
        ),
      );
      expect(
        t.fake.delivered.some(
          d => d.agentId === t.bob.id && d.messageId === second.committed.message.id,
        ),
      ).toBe(true);
      expect(t.fake.starts.some(s => s.agentId === t.bob.id)).toBe(false);

      // carol is not a follower → no inbox row, no delivery, no follow record.
      expect(t.conversationInboxes.listPending(t.channel.id, carol.id)).toEqual([]);
      expect(
        t.fake.delivered.some(d => d.agentId === carol.id),
      ).toBe(false);
      expect(t.threadFollowers.isFollower(root.id, 'agent', carol.id)).toBe(false);

      // followers recorded: local human (reply), bob (target_author).
      const followers = t.threadFollowers.listFollowers(root.id);
      expect(
        followers
          .filter(f => f.principal_kind === 'agent')
          .map(f => [f.principal_id, f.source])
          .sort(),
      ).toEqual(
        [
          [t.bob.id, 'target_author'],
        ],
      );
      expect(
        followers.some(
          f =>
            f.principal_kind === 'human'
            && f.principal_id === 'local'
            && f.source === 'reply',
        ),
      ).toBe(true);
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
        target: { kind: 'thread', message_id: root.id },
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
        target: { kind: 'thread', message_id: root.id },
      });
      // give any post-commit delivery a chance to run, then assert bob got none.
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(
        t.conversationInboxes
          .listPending(t.channel.id, t.bob.id)
          .some(i => i.message.id === second.committed.message.id),
      ).toBe(false);
      expect(
        t.fake.delivered.some(
          d => d.agentId === t.bob.id && d.messageId === second.committed.message.id,
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
        target: { kind: 'thread', message_id: root.id },
      });

      // bob mentions @carol in a thread reply: carol is followed (mention) and
      // backfilled with prior thread history (root + reply1) inside the tx,
      // THEN the current reply is delivered to her as a turn.
      const mentionReply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: '<silverhand://agent/carol> please look',
        target: { kind: 'thread', message_id: reply1.committed.message.id },
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
      expect(backfilled).toEqual([root.id, reply1.committed.message.id]);
      expect(backfilled).not.toContain(mentionReply.committed.message.id);

      // current reply reaches carol as a turn (deliverMessage → wake).
      await waitFor(() =>
        t.fake.delivered.some(
          d => d.agentId === carol.id && d.messageId === mentionReply.committed.message.id,
        ),
      );
    } finally {
      t.cleanup();
    }
  });

  it('derives the addressing set ONCE per send and hands that same set to every in-send consumer (#task:2000)', async () => {
    // Regression guard for the round-2 finding: the addressing contract had
    // three independent derivations (thread-follow, the `mention_self`
    // notification, the CC pass each parsed `message.content` themselves), so
    // one send parsed the same immutable body three times and "what this
    // message addresses" had three authorities that could drift apart.
    //
    // The guard is deliberately two-sided:
    //   - CALL COUNT — exactly one parse for a send that reaches ALL THREE
    //     consumers (a thread reply, from a user actor so `ccMentions` is on,
    //     addressing both a human and an agent). A consumer that re-parses
    //     turns this into 2+.
    //   - IDENTITY — the CC port receives the very array the boundary derived
    //     (`toBe`, not `toEqual`), so a future consumer cannot satisfy the
    //     count by parsing an equal-looking set from somewhere else.
    // Thread-follow has no injectable seam here, so it is pinned by its
    // effect: the mentioned agent ends up followed with `source='mention'`,
    // which is only reachable through the passed set.
    const t = bootstrap();
    try {
      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'root',
      });

      vi.mocked(extractMessageReferences).mockClear();
      const content =
        'in-thread: <silverhand://human/teammate-test> <silverhand://agent/alice> please look';
      const reply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content,
        target: { kind: 'thread', message_id: root.id },
      });

      // ONE derivation, at the send boundary, off the caller's bytes (the
      // insert copies `content` verbatim, so this is the same body the
      // consumers would have re-parsed).
      expect(vi.mocked(extractMessageReferences).mock.calls).toEqual([[content]]);
      const derived = vi.mocked(extractMessageReferences).mock.results[0]!.value;
      expect(derived).toEqual([
        { kind: 'human', handle: 'teammate-test' },
        { kind: 'agent', handle: 'alice' },
      ]);

      // Consumer 1 (in-tx): thread auto-follow used the passed set.
      const aliceFollow = t.threadFollowers
        .listFollowers(root.id)
        .find(f => f.principal_id === t.alice.id);
      expect(aliceFollow?.source).toBe('mention');

      // Consumer 2 (post-commit): the `mention_self` notification.
      expect(t.notifications.list({ userId: 'teammate', unread: true })).toEqual([
        expect.objectContaining({
          kind: 'mention_self',
          user_id: 'teammate',
          message_id: reply.committed.message.id,
        }),
      ]);

      // Consumer 3 (IN-TX since v71 §5): the CC write is handed the identical
      // array — no second parse, no second authority. No `waitFor` any more, and
      // that is the point: the call happened synchronously inside the send
      // transaction, so by the time `sendMessage` resolved it had already run.
      expect(vi.mocked(writeMentionCcCopies).mock.calls).toHaveLength(1);
      const ccArgs = vi.mocked(writeMentionCcCopies).mock.calls[0]![1];
      expect(ccArgs.references).toBe(derived);
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
        target: { kind: 'thread', message_id: root.id },
      });
      const before = t.conversationInboxes
        .listPending(t.channel.id, t.alice.id)
        .map(i => i.message.id);

      // bob now mentions @alice in a thread reply. alice is already a follower
      // → ON CONFLICT DO NOTHING: source stays 'reply', no re-backfill.
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.bob.id, conversationId: t.channel.id },
        content: '<silverhand://agent/alice> ping',
        target: { kind: 'thread', message_id: root.id },
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
        target: { kind: 'thread', message_id: root.id },
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
        target: { kind: 'thread', message_id: root.id },
      });

      // Now pull carol in mid-thread via mention. Backfill must include
      // root + reply1 + reply3 (seq < current), ordered by seq, and EXCLUDE
      // carol's own message and the current mention reply.
      const mention = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: '<silverhand://agent/carol> catch up',
        target: { kind: 'thread', message_id: root.id },
      });

      const inbox = t.conversationInboxes
        .listPending(t.channel.id, carol.id)
        .map(i => i.message.id);
      expect(inbox).toEqual([root.id, reply1.committed.message.id, reply3.committed.message.id]);
      expect(inbox).not.toContain(carolOwn.id);
      expect(inbox).not.toContain(mention.committed.message.id);
    } finally {
      t.cleanup();
    }
  });

  it('backfills the COMPLETE thread history for a large thread — never drops the newest replies', async () => {
    const t = bootstrap();
    try {
      const carol = t.agents.create(
        { name: 'carol', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      t.workspaces.insertMembership(t.workspace.id, carol.id);
      t.conversations.addAgent(t.channel.id, carol.id);

      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'root',
      });
      // A thread with more replies than the old 500 cap. Inserted directly so
      // none of them register a follow — carol is pulled in only at the end.
      const REPLY_COUNT = 520;
      const replyIds: string[] = [];
      for (let i = 0; i < REPLY_COUNT; i++) {
        replyIds.push(
          t.messages.insertForConversation({
            conversationId: t.channel.id,
            fromKind: 'agent',
            fromAgentId: t.bob.id,
            content: `reply ${i}`,
            threadRootId: root.id,
          }).id,
        );
      }

      // mention carol → full backfill of root + every prior reply.
      const mention = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: '<silverhand://agent/carol> catch up on everything',
        target: { kind: 'thread', message_id: root.id },
      });

      const inbox = t.conversationInboxes
        .listPending(t.channel.id, carol.id)
        .map(i => i.message.id);
      // root + all 520 replies, nothing dropped, current reply not enqueued.
      expect(inbox).toEqual([root.id, ...replyIds]);
      // Regression guard: the OLD `ORDER BY seq ASC LIMIT 500` kept the oldest
      // 500 and dropped the newest 20 — the most relevant context.
      expect(inbox).toContain(replyIds[REPLY_COUNT - 1]);
      expect(inbox).not.toContain(mention.committed.message.id);
    } finally {
      t.cleanup();
    }
  });
});

/**
 * #task:1981 §9 — the boundary contracts themselves: what the transaction owns,
 * what may only happen after it commits, and which read the delivery plan comes
 * from. These are not re-tests of send behaviour; each one fails if the
 * persistence boundary regresses while every behavioural test stays green.
 */
describe('ConversationMessageService persistence boundary (#task:1981)', () => {
  it('a failed in-tx insert publishes nothing, delivers nothing, notifies nobody (§9.5)', async () => {
    const t = bootstrap();
    try {
      const conversationEvents: string[] = [];
      const unsubConversation = t.events.subscribe(t.channel.id, e => {
        conversationEvents.push(e.kind);
      });
      const viewerEvents: string[] = [];
      const unsubViewer = t.events.subscribeScope('viewer:local', e => {
        viewerEvents.push(e.kind);
      });

      t.txWrap.current = tx =>
        overrideScope(tx, {
          messages: overrideScope(tx.messages, {
            insertForConversation: () => {
              throw new Error('insert exploded');
            },
          }),
        });

      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'user', userId: 'local' },
          content: 'addresses <silverhand://agent/alice> and would notify <silverhand://human/local-test>',
        }),
      ).rejects.toThrowError('insert exploded');
      unsubConversation();
      unsubViewer();

      // The whole point of post-commit effects: a rolled-back write cannot have
      // published, delivered, started a run, CC'd, or written a notification.
      expect(conversationEvents).toEqual([]);
      expect(viewerEvents).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
      expect(t.fake.starts).toEqual([]);
      expect(vi.mocked(writeMentionCcCopies).mock.calls).toEqual([]);
      expect(t.notifications.list({ userId: 'local' })).toEqual([]);
      // and no half-written message row
      expect(t.messages.listForConversation(t.channel.id)).toEqual([]);
      expect(t.messages.latestSeqForConversation(t.channel.id)).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it('the mention notification row is committed BEFORE unread_updated publishes (§9.5, #task:1870)', async () => {
    const t = bootstrap();
    try {
      // The tiered badge counts `mention_self`, so a viewer that recomputes on
      // unread_updated must already be able to see the row.
      const order: string[] = [];
      const notificationsAtUnread: number[] = [];
      const unsubViewer = t.events.subscribeScope('viewer:local', e => {
        order.push(e.kind);
        if (e.kind === 'unread_updated') {
          notificationsAtUnread.push(t.notifications.list({ userId: 'local' }).length);
        }
      });

      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.channel.id },
        content: 'please look, <silverhand://human/local-test>',
      });
      unsubViewer();

      expect(order).toContain('notification');
      expect(order).toContain('unread_updated');
      expect(order.indexOf('notification')).toBeLessThan(order.indexOf('unread_updated'));
      expect(notificationsAtUnread).toEqual([1]);
    } finally {
      t.cleanup();
    }
  });

  it('the follower-gated delivery plan comes from the TX scope, never a captured outside read (§9.10)', async () => {
    const t = bootstrap();
    try {
      const carol = t.agents.create(
        { name: 'carol', runtime: 'claude' },
        t.localHostId,
        'local',
      );
      t.workspaces.insertMembership(t.workspace.id, carol.id);
      t.conversations.addAgent(t.channel.id, carol.id);

      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'bob root',
      });

      // Authority split: the tx scope says "carol", the outside read port says
      // "bob". The plan must follow the tx scope — reading it through a
      // captured factory repo would compute the plan on another connection's
      // snapshot under a pooled engine (R1).
      const carolMembership = t.conversations.getAgent(t.channel.id, carol.id);
      const bobMembership = t.conversations.getAgent(t.channel.id, t.bob.id);
      expect(carolMembership).not.toBeNull();
      expect(bobMembership).not.toBeNull();
      const outsideRead = vi
        .spyOn(t.persistence.threadFollow.read, 'listFollowerAgentsVisible')
        .mockReturnValue([bobMembership!]);
      t.txWrap.current = tx =>
        overrideScope(tx, {
          threadFollowers: overrideScope(tx.threadFollowers, {
            listFollowerAgentsVisible: () => [carolMembership!],
          }),
        });

      const reply = await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'human reply',
        target: { kind: 'thread', message_id: root.id },
      });

      await waitFor(() =>
        t.fake.delivered.some(
          d => d.agentId === carol.id && d.messageId === reply.committed.message.id,
        ),
      );
      // bob is a real target_author follower AND what the outside port claims —
      // so delivering to him would mean the plan came from the wrong read.
      expect(t.fake.delivered.some(d => d.agentId === t.bob.id)).toBe(false);
      expect(outsideRead).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    } finally {
      vi.restoreAllMocks();
      t.cleanup();
    }
  });

  it('every scope slice the send path uses is the injected one — no captured repo survives (R1)', async () => {
    const t = bootstrap();
    try {
      // A blunt structural falsifier for R1: if any persistence call inside the
      // transaction still went through a captured repo instead of the scope,
      // this counter would not see it.
      const touched = new Set<string>();
      t.txWrap.current = tx => {
        const spy = <S extends object>(name: string, slice: S): S =>
          new Proxy(slice, {
            get(obj, prop) {
              const value = Reflect.get(obj, prop) as unknown;
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                touched.add(`${name}.${String(prop)}`);
                return (value as (...a: unknown[]) => unknown).apply(obj, args);
              };
            },
          });
        return overrideScope(tx, {
          messages: spy('messages', tx.messages),
          conversations: spy('conversations', tx.conversations),
          agents: spy('agents', tx.agents),
          inboxes: spy('inboxes', tx.inboxes),
          threadFollowers: spy('threadFollowers', tx.threadFollowers),
        });
      };

      const root = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'root',
      });
      await t.service.sendMessage({
        conversationId: t.channel.id,
        actor: { kind: 'user', userId: 'local' },
        content: 'reply',
        target: { kind: 'thread', message_id: root.id },
      });

      expect(touched).toContain('conversations.get');
      expect(touched).toContain('messages.getInConversation');
      expect(touched).toContain('messages.insertForConversation');
      expect(touched).toContain('threadFollowers.upsert');
      expect(touched).toContain('threadFollowers.listFollowerAgentsVisible');
    } finally {
      t.cleanup();
    }
  });
});

/**
 * Attachment admission parity (#task:1981 §9.8). The send path now resolves
 * snapshots INSIDE its transaction through `tx.attachments`, while
 * `AttachmentService.resolveSnapshotsForChannel` resolves them outside one.
 * Both faces must feed the SAME facts to the shared pure leaf, or the same
 * upload becomes attachable through one surface and not the other.
 */
describe('attachment admission parity across the two resolution faces (§9.8)', () => {
  const REFUSAL_CASES = ['outside_channel', 'label_kind_mismatch'] as const;

  it('both faces derive identical sources, and the tx face leaks no physical column (R4)', () => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: 'other',
      });
      const mine = t.attachments.insert({
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
      const foreign = t.attachments.insert({
        channelId: other.id,
        sourceConversationId: other.id,
        filename: 'x.pdf',
        size: 10,
        contentType: 'application/pdf',
        storage: 'local',
        storageKey: 'attachments/other/x',
        createdByKind: 'user',
        createdById: 'local',
      });
      const ids = [mine.id, foreign.id, 'no-such-attachment'];

      // The outside face's fetch (`AttachmentRepo.listByIds`, what
      // `resolveSnapshotsForChannel` passes to the leaf) projected onto the
      // facts the leaf reads.
      const outside = t.attachments
        .listByIds(ids)
        .map(row => ({
          id: row.id,
          channel_id: row.channel_id,
          filename: row.filename,
          size: row.size,
          content_type: row.content_type,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const inside = t.persistence.message.uow
        .atomically(tx => tx.attachments.listSnapshotSourcesByIds(ids))
        .sort((a, b) => a.id.localeCompare(b.id));

      expect(inside).toEqual(outside);
      // R4: the message domain never sees storage physics.
      for (const source of inside) {
        expect(Object.keys(source).sort()).toEqual([
          'channel_id',
          'content_type',
          'filename',
          'id',
          'size',
        ]);
      }
    } finally {
      t.cleanup();
    }
  });

  it.each(REFUSAL_CASES)('the send path refuses %s with the matching typed code', async reason => {
    const t = bootstrap();
    try {
      const other = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        title: 'other',
      });
      const attachment = t.attachments.insert({
        channelId: reason === 'outside_channel' ? other.id : t.channel.id,
        sourceConversationId: reason === 'outside_channel' ? other.id : t.channel.id,
        filename: 'doc.pdf',
        size: 10,
        contentType: 'application/pdf',
        storage: 'local',
        storageKey: 'attachments/x/doc',
        createdByKind: 'user',
        createdById: 'local',
      });

      await expect(
        t.service.sendMessage({
          conversationId: t.channel.id,
          actor: { kind: 'user', userId: 'local' },
          content: 'file',
          // A pdf labelled as an image is the mismatch case; the foreign
          // attachment is refused before the label is even considered.
          attachmentRefs: [{ id: attachment.id, label: 'Image #1' }],
        }),
      ).rejects.toMatchObject({
        code: `attachment_${reason}`,
        attachmentId: attachment.id,
      });
      expect(t.messages.listForConversation(t.channel.id)).toHaveLength(0);
      expect(t.messages.latestSeqForConversation(t.channel.id)).toBe(0);
      expect(t.fake.delivered).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
