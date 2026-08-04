import { describe, expect, it, vi } from 'vitest';
import { readChannelContextMetadata } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import {
  ActorError,
  ChannelService,
  MemberError,
  SeedError,
  WorkspaceUnsuitableError,
} from '../../src/services/channel-service.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

class FakeConversationManager {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];
  deliverError: Error | null = null;

  async start(conversationId: string, agentId: string): Promise<void> {
    this.starts.push({ conversationId, agentId });
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    if (this.deliverError) throw this.deliverError;
    this.delivered.push({ conversationId, agentId, messageId });
  }

  resolveRun(): void {}
  resolvedConversations: Array<{ conversationId: string; reason?: string }> = [];
  resolveConversationRuns(conversationId: string, reason?: string): void {
    this.resolvedConversations.push({ conversationId, reason });
  }
  getAgentRunStates(): never[] {
    return [];
  }
  stops: Array<{ conversationId: string; agentId: string }> = [];
  async stop(conversationId: string, agentId: string): Promise<void> {
    this.stops.push({ conversationId, agentId });
  }
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
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const hosts = new HostRepo(db);
  hosts.ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const conversationReads = new ConversationReadRepo(db);
  const messages = new MessageRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = new ChannelService({
    db,
    conversations,
    conversationReads,
    workspaces,
    agents,
    messages,
    events,
    runtimeHost: fake as unknown as AgentRuntimeHost,
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
  const source = conversations.insertChannel({
    workspaceId: workspace.id,
    title: 'source',
  });
  conversations.addAgent(source.id, alice.id);
  conversations.addAgent(source.id, bob.id);

  return {
    db,
    tmp,
    localHostId,
    agents,
    workspaces,
    conversations,
    messages,
    events,
    fake,
    logger,
    service,
    workspace,
    source,
    alice,
    bob,
    cleanup: tmp.cleanup,
  };
}

describe('ChannelService.createChannel', () => {
  it('creates a blank human channel with members and publishes workspace change', async () => {
    const t = bootstrap();
    try {
      const events: Array<{ kind: string; payload: unknown }> = [];
      const unsub = t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        events.push({ kind: e.kind, payload: e.payload });
      });

      const result = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'planning',
        memberAgentIds: [t.alice.id, t.bob.id],
        actor: { kind: 'user', userId: 'local' },
      });
      unsub();

      expect(result.channel.title).toBe('planning');
      expect(t.conversations.listAgents(result.channel.id).map(a => a.agent_id).sort())
        .toEqual([t.alice.id, t.bob.id].sort());
      expect(t.messages.listForConversation(result.channel.id)).toHaveLength(0);
      expect(events).toContainEqual({
        kind: 'workspace_channels_changed',
        payload: { workspace_id: t.workspace.id, channel_id: result.channel.id },
      });
    } finally {
      t.cleanup();
    }
  });

  it('rejects unsuitable workspaces, invalid members, and human seed', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.createChannel({
          workspaceId: 'missing',
          title: 'x',
          memberAgentIds: [],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toMatchObject({ code: 'workspace_not_found' });

      const dmWorkspace = t.workspaces.insertAgentHome({
        agent: t.alice,
      });
      await expect(
        t.service.createChannel({
          workspaceId: dmWorkspace.id,
          title: 'x',
          memberAgentIds: [],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toBeInstanceOf(WorkspaceUnsuitableError);

      const outsider = t.agents.create({ name: 'outsider', runtime: 'claude' }, t.localHostId, 'local');
      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'x',
          memberAgentIds: [outsider.id],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toBeInstanceOf(MemberError);

      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'x',
          memberAgentIds: [],
          actor: { kind: 'user', userId: 'local' },
          seed: {
            systemMessageBody: 'ctx',
            initialPrompt: 'go',
            autoStartMembers: 'all',
          },
        }),
      ).rejects.toBeInstanceOf(SeedError);
    } finally {
      t.cleanup();
    }
  });

  it('creates an agent-seeded channel, publishes first, then best-effort delivers and starts', async () => {
    const t = bootstrap();
    try {
      const publishOrder: string[] = [];
      const unsub = t.events.subscribeScope(`workspace:${t.workspace.id}`, () => {
        publishOrder.push('publish');
      });
      const originalDeliver = t.fake.deliverMessage.bind(t.fake);
      t.fake.deliverMessage = async (
        conversationId: string,
        agentId: string,
        messageId: string,
      ): Promise<void> => {
        publishOrder.push('deliver');
        await originalDeliver(conversationId, agentId, messageId);
      };

      const result = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'release',
        memberAgentIds: [t.alice.id, t.bob.id],
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
        seed: {
          systemMessageBody: 'context',
          initialPrompt: 'initial',
          autoStartMembers: 'all',
        },
      });
      unsub();

      const msgs = t.messages.listForConversation(result.channel.id);
      expect(msgs.map(m => m.content)).toEqual(['context', 'initial']);
      // PR-5 producer round-trip: channel_context metadata must
      // satisfy ChannelContextMetadataSchema and snapshot the source
      // conversation title + creator agent name so the renderer can
      // pull a Spawned-from chip without re-querying.
      const channelCtxParsed = readChannelContextMetadata(
        msgs[0]!.metadata as Record<string, unknown>,
      );
      expect(channelCtxParsed).not.toBeNull();
      expect(channelCtxParsed!.source_conversation_id).toBe(t.source.id);
      expect(channelCtxParsed!.source_conversation_title).toBe(t.source.title);
      expect(channelCtxParsed!.created_by_agent_id).toBe(t.alice.id);
      expect(channelCtxParsed!.created_by_agent_name).toBe(t.alice.name);
      expect(t.fake.delivered).toEqual([
        { conversationId: result.channel.id, agentId: t.alice.id, messageId: msgs[0]!.id },
        { conversationId: result.channel.id, agentId: t.bob.id, messageId: msgs[1]!.id },
      ]);
      expect(t.fake.starts.map(s => s.agentId).sort()).toEqual(
        [t.alice.id, t.bob.id].sort(),
      );
      expect(publishOrder[0]).toBe('publish');
    } finally {
      t.cleanup();
    }
  });

  it('rejects forged agent actors before inserting', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'x',
          memberAgentIds: [],
          actor: { kind: 'agent', agentId: 'missing-agent', conversationId: t.source.id },
          seed: { systemMessageBody: 'ctx', initialPrompt: 'go', autoStartMembers: 'none' },
        }),
      ).rejects.toMatchObject({ code: 'agent_not_found' });

      const otherWorkspace = t.workspaces.insert({
        name: 'other',
        description: null,
      });
      await expect(
        t.service.createChannel({
          workspaceId: otherWorkspace.id,
          title: 'x',
          memberAgentIds: [],
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
          seed: { systemMessageBody: 'ctx', initialPrompt: 'go', autoStartMembers: 'none' },
        }),
      ).rejects.toMatchObject({ code: 'agent_workspace_mismatch' });

      t.conversations.removeAgent(t.source.id, t.alice.id);
      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'x',
          memberAgentIds: [t.bob.id],
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
          seed: { systemMessageBody: 'ctx', initialPrompt: 'go', autoStartMembers: 'none' },
        }),
      ).rejects.toBeInstanceOf(ActorError);
    } finally {
      t.cleanup();
    }
  });

  it('swallows post-commit delivery failure but propagates publish failure', async () => {
    const t = bootstrap();
    try {
      t.fake.deliverError = new Error('deliver failed');
      const ok = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'ok',
        memberAgentIds: [t.alice.id],
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
        seed: { systemMessageBody: 'ctx', initialPrompt: 'go', autoStartMembers: 'none' },
      });
      expect(ok.channel.title).toBe('ok');
      expect(t.logger.warn).toHaveBeenCalled();

      const publish = vi.spyOn(t.events, 'publishToScope').mockImplementation(() => {
        throw new Error('bus failed');
      });
      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'committed-before-bus',
          memberAgentIds: [],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toThrow('bus failed');
      publish.mockRestore();
      expect(
        t.conversations.listActiveChannelsForWorkspace(t.workspace.id).some(
          (c: { title: string }) => c.title === 'committed-before-bus',
        ),
      ).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it('user-created channel with no explicit human list seeds ONLY the creator', async () => {
    const t = bootstrap();
    try {
      // Drop test-fixture autoseed triggers so the user-membership we
      // observe is *only* what ChannelService writes — not what the
      // openTestDb triggers fan out to every fixture user.
      t.db.exec(
        `DROP TRIGGER IF EXISTS test_seed_workspace_users;
         DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
      );
      // `local` and `alice` are both workspace members, but an omitted human
      // list must NOT snapshot the whole workspace anymore — only the creator
      // is added, so a new channel starts scoped to its creator + chosen
      // members (others reach a public one by browse + self-join).
      t.db.exec(`DELETE FROM workspace_users WHERE workspace_id = '${t.workspace.id}'`);
      const now = Date.now();
      t.db
        .prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
             VALUES (?, 'local', ?), (?, 'alice', ?)`,
        )
        .run(t.workspace.id, now, t.workspace.id, now);

      const result = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'planning',
        memberAgentIds: [t.alice.id],
        actor: { kind: 'user', userId: 'local' },
      });

      const userMembers = t.conversations
        .listUsers(result.channel.id)
        .map(u => u.user_id)
        .sort();
      // Creator only — `alice` is a workspace member but was not selected.
      expect(userMembers).toEqual(['local']);
    } finally {
      t.cleanup();
    }
  });

  it('user-created channel with an explicit human list seeds creator + that subset', async () => {
    const t = bootstrap();
    try {
      t.db.exec(
        `DROP TRIGGER IF EXISTS test_seed_workspace_users;
         DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
      );
      t.db.exec(`DELETE FROM workspace_users WHERE workspace_id = '${t.workspace.id}'`);
      const now = Date.now();
      t.db
        .prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
             VALUES (?, 'local', ?), (?, 'alice', ?)`,
        )
        .run(t.workspace.id, now, t.workspace.id, now);

      const result = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'planning',
        memberAgentIds: [t.alice.id],
        memberUserIds: ['alice'],
        actor: { kind: 'user', userId: 'local' },
      });

      const userMembers = t.conversations
        .listUsers(result.channel.id)
        .map(u => u.user_id)
        .sort();
      // Explicit subset plus the implicit creator.
      expect(userMembers).toEqual(['alice', 'local']);
    } finally {
      t.cleanup();
    }
  });

  it('persists visibility: explicit public is stored, omitted defaults to private', async () => {
    const t = bootstrap();
    try {
      const pub = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'public-chan',
        memberAgentIds: [],
        actor: { kind: 'user', userId: 'local' },
        visibility: 'public',
      });
      expect(pub.channel.visibility).toBe('public');

      const priv = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'default-chan',
        memberAgentIds: [],
        actor: { kind: 'user', userId: 'local' },
      });
      expect(priv.channel.visibility).toBe('private');
    } finally {
      t.cleanup();
    }
  });

  it('rejects public channel creation by an agent actor (public is human-only)', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'agent-public',
          memberAgentIds: [t.alice.id],
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
          visibility: 'public',
        }),
      ).rejects.toMatchObject({ name: 'ActorError', code: 'agent_cannot_create_public' });
    } finally {
      t.cleanup();
    }
  });

  it('agent-created channel inherits user members narrowly from the source conversation', async () => {
    const t = bootstrap();
    try {
      // Drop test-fixture autoseed triggers (see comment above).
      t.db.exec(
        `DROP TRIGGER IF EXISTS test_seed_workspace_users;
         DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
      );
      // Constrain the source conversation_users to a strict subset:
      // only `local` is a member of the source, NOT `alice` (even
      // though both are workspace members). The agent-actor branch
      // must inherit only `local` into the new channel.
      t.db.exec(
        `DELETE FROM conversation_users WHERE conversation_id = '${t.source.id}'`,
      );
      t.db
        .prepare(
          `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
             VALUES (?, 'local', ?)`,
        )
        .run(t.source.id, Date.now());

      const result = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'spawned',
        memberAgentIds: [t.alice.id],
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
      });

      const userMembers = t.conversations
        .listUsers(result.channel.id)
        .map(u => u.user_id);
      expect(userMembers).toEqual(['local']);
    } finally {
      t.cleanup();
    }
  });
});

describe('ChannelService.setArchived', () => {
  it('archives and unarchives top-level channels with workspace publish', async () => {
    const t = bootstrap();
    try {
      const events: string[] = [];
      const unsub = t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        events.push(e.kind);
      });
      const archived = await t.service.setArchived({
        channelId: t.source.id,
        archived: true,
      });
      expect(archived.channel.archived_at).not.toBeNull();
      expect(t.conversations.get(t.source.id)?.archived_at).not.toBeNull();
      const unarchived = await t.service.setArchived({
        channelId: t.source.id,
        archived: false,
      });
      unsub();
      expect(unarchived.channel.archived_at).toBeNull();
      expect(t.conversations.get(t.source.id)?.archived_at).toBeNull();
      expect(events).toEqual([
        'workspace_channels_changed',
        'workspace_channels_changed',
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('emits viewer-scoped unread_updated on archive and unarchive so cached badges drop then restore (#task:1403)', async () => {
    const t = bootstrap();
    try {
      // The 'local' human viewer is a member of `source`; give them one unread
      // agent message so archiving has a badge to drop.
      t.messages.insertForConversation({
        conversationId: t.source.id,
        fromKind: 'agent',
        content: 'unread work',
      });

      const frames: Array<{
        conversation_id?: string;
        conversation_unread_count?: number;
        workspace_unread_count?: number;
        latest_unread?: unknown;
      }> = [];
      const unsub = t.events.subscribeScope('viewer:local', e => {
        if (e.kind === 'unread_updated') {
          frames.push(
            e.payload as {
              conversation_id?: string;
              conversation_unread_count?: number;
              workspace_unread_count?: number;
              latest_unread?: unknown;
            },
          );
        }
      });

      await t.service.setArchived({ channelId: t.source.id, archived: true });
      await t.service.setArchived({ channelId: t.source.id, archived: false });
      unsub();

      // Both frames are message-variant (carry conversation_id) so the #1284
      // ingestor patches the badge in place: archive → 0, unarchive → restored.
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({
        conversation_id: t.source.id,
        conversation_unread_count: 0,
        workspace_unread_count: 0,
        latest_unread: null,
      });
      expect(frames[1]).toMatchObject({
        conversation_id: t.source.id,
        conversation_unread_count: 1,
        workspace_unread_count: 1,
      });
    } finally {
      t.cleanup();
    }
  });

  it('rejects missing ids with not_found', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.setArchived({ channelId: 'missing', archived: true }),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      t.cleanup();
    }
  });

  it('archiving stops the runtime of every agent in the channel (#task:1398)', async () => {
    // Domain decision: an agent working in an archived channel is doing
    // meaningless work, so archive terminates its runtime. source has alice+bob.
    const t = bootstrap();
    try {
      await t.service.setArchived({ channelId: t.source.id, archived: true });
      expect(t.fake.resolvedConversations).toEqual([
        { conversationId: t.source.id, reason: 'conversation_closed' },
      ]);
      // hard-stop issued for both agents in the channel (order-independent).
      expect(t.fake.stops).toHaveLength(2);
      expect(t.fake.stops.every(s => s.conversationId === t.source.id)).toBe(true);
      expect(new Set(t.fake.stops.map(s => s.agentId))).toEqual(
        new Set([t.alice.id, t.bob.id]),
      );
    } finally {
      t.cleanup();
    }
  });

  it('unarchiving does NOT start or stop any runtime (#task:1398)', async () => {
    // Unarchive is a pure visibility flip — it must not touch agent lifecycle
    // (no auto-restart of the agents archive stopped, no spurious stop).
    const t = bootstrap();
    try {
      await t.service.setArchived({ channelId: t.source.id, archived: true });
      t.fake.stops.length = 0;
      t.fake.resolvedConversations.length = 0;
      await t.service.setArchived({ channelId: t.source.id, archived: false });
      expect(t.fake.stops).toEqual([]);
      expect(t.fake.resolvedConversations).toEqual([]);
      expect(t.fake.starts).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});

describe('ChannelService.setChannelVisibility', () => {
  it('toggles private↔public with a workspace publish, and no-ops on same value', async () => {
    const t = bootstrap();
    try {
      const events: string[] = [];
      const unsub = t.events.subscribeScope(`workspace:${t.workspace.id}`, e => events.push(e.kind));

      // source is created private → make it public.
      const pub = await t.service.setChannelVisibility({
        channelId: t.source.id,
        visibility: 'public',
        actor: { kind: 'user', userId: 'local' },
      });
      expect(pub.channel.visibility).toBe('public');
      expect(t.conversations.get(t.source.id)?.visibility).toBe('public');

      // Same-value request → no-op (no second publish).
      await t.service.setChannelVisibility({
        channelId: t.source.id,
        visibility: 'public',
        actor: { kind: 'user', userId: 'local' },
      });

      // Back to private.
      const priv = await t.service.setChannelVisibility({
        channelId: t.source.id,
        visibility: 'private',
        actor: { kind: 'user', userId: 'local' },
      });
      unsub();
      expect(priv.channel.visibility).toBe('private');
      // Exactly two publishes: the two real changes, not the same-value no-op.
      expect(events).toEqual(['workspace_channels_changed', 'workspace_channels_changed']);
    } finally {
      t.cleanup();
    }
  });

  it('rejects a NON-user actor requesting public (defense in depth beyond the route admin gate)', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.setChannelVisibility({
          channelId: t.source.id,
          visibility: 'public',
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
        }),
      ).rejects.toMatchObject({ code: 'agent_cannot_create_public' });
      // No write happened.
      expect(t.conversations.get(t.source.id)?.visibility).toBe('private');
    } finally {
      t.cleanup();
    }
  });

  it('rejects a missing channel with not_found', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.setChannelVisibility({
          channelId: 'missing',
          visibility: 'public',
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      t.cleanup();
    }
  });
});
