import { describe, expect, it, vi } from 'vitest';
import { readChannelContextMetadata } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createSqliteConversationPersistence } from '../../src/repos/conversation-persistence.js';
import { createUnreadPublishAdapter } from '../../src/adapters/unread-publish.js';
import {
  ActorError,
  ChannelService,
  MemberError,
  SeedError,
  WorkspaceUnsuitableError,
} from '../../src/services/channel-service.js';
import type { BackendLogger } from '../../src/context.js';
import type {
  ChannelTxScope,
  WorkspaceChannelTxScope,
} from '../../src/services/channel/ports.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';
import { overrideScope, twoAxisUowWithScopeWrap } from '../utils/tx-fault.js';

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
  const messages = new MessageRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const persistence = createSqliteConversationPersistence(db);
  // #task:1981 §9: faults and authority swaps are injected on the tx scope —
  // the only persistence seam the service has left. Read per transaction, so a
  // test can arm it after its setup writes committed normally.
  const txWrap: { current: ((tx: ChannelTxScope) => ChannelTxScope) | null } = { current: null };
  // The workspace-keyed axis (channel creation) carries a DIFFERENT scope type,
  // so it gets its own slot: a rename fault can never leak into a create.
  const wsTxWrap: {
    current: ((tx: WorkspaceChannelTxScope) => WorkspaceChannelTxScope) | null;
  } = { current: null };
  // A committed write in the gap between the service's pre-lock reads and BEGIN
  // — the only place the roster races this transaction (see `twoAxisUowWithScopeWrap`).
  const seam: { current: (() => void) | null } = { current: null };
  const service = new ChannelService({
    channels: persistence.channel.read,
    channelWrites: persistence.channel.directWrite,
    workspaces: persistence.channel.workspaces,
    agents: persistence.channel.agents,
    uow: twoAxisUowWithScopeWrap(persistence.channel.uow, {
      wrapForChannel: () => txWrap.current,
      wrapInWorkspace: () => wsTxWrap.current,
      seam: () => seam.current,
    }),
    unreadPublish: createUnreadPublishAdapter({ db, events }),
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
    persistence,
    txWrap,
    wsTxWrap,
    seam,
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
      // `local` is seeded as `admin`: the create route gates on
      // `canGovernWorkspace(…, 'admin')` and the callback re-derives that same
      // authority in the lock, so a plain-`member` creator is a state the product
      // cannot reach (the column default is `member`, hence the explicit role).
      t.db
        .prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, joined_at, role)
             VALUES (?, 'local', ?, 'admin'), (?, 'alice', ?, 'member')`,
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
          `INSERT INTO workspace_users (workspace_id, user_id, joined_at, role)
             VALUES (?, 'local', ?, 'admin'), (?, 'alice', ?, 'member')`,
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

describe('ChannelService.renameChannel', () => {
  it('audits the from-title read authoritatively INSIDE the rename transaction (§9.7)', async () => {
    const t = bootstrap();
    try {
      const created = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'before',
        memberAgentIds: [t.alice.id],
        actor: { kind: 'user', userId: 'local' },
      });

      // `getChannelLikeForUpdate` carries an isolation obligation: its value is
      // the ONLY source of the from-title audit. Feeding it a different title
      // than any outside read would return proves the audit is not recomputed
      // from a second, possibly stale, read.
      t.txWrap.current = tx =>
        overrideScope(tx, {
          channels: overrideScope(tx.channels, {
            getChannelLikeForUpdate: () => {
              const row = tx.channels.getChannelLikeForUpdate();
              return row ? { ...row, title: 'in-tx authority' } : null;
            },
          }),
        });

      const renamed = await t.service.renameChannel({
        channelId: created.channel.id,
        title: 'after',
      });
      expect(renamed.channel.title).toBe('after');

      const announce = t.messages
        .listForConversation(created.channel.id)
        .find(m => (m.metadata as Record<string, unknown> | null)?.old_name !== undefined);
      expect(announce).toBeTruthy();
      expect((announce!.metadata as Record<string, unknown>).old_name).toBe('in-tx authority');
      expect((announce!.metadata as Record<string, unknown>).new_name).toBe('after');
      expect((announce!.metadata as Record<string, unknown>).scope).toBe('conversation');
    } finally {
      t.cleanup();
    }
  });

  it('a same-title rename is a no-op: no system message, no delivery, no publish (§9.7)', async () => {
    const t = bootstrap();
    try {
      const created = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'steady',
        memberAgentIds: [t.alice.id],
        actor: { kind: 'user', userId: 'local' },
      });
      const messagesBefore = t.messages.listForConversation(created.channel.id).length;
      t.fake.delivered = [];
      const publishes: string[] = [];
      const unsub = t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        publishes.push(e.kind);
      });

      const result = await t.service.renameChannel({
        channelId: created.channel.id,
        title: 'steady',
      });
      unsub();

      expect(result.channel.title).toBe('steady');
      expect(t.messages.listForConversation(created.channel.id)).toHaveLength(messagesBefore);
      expect(t.fake.delivered).toEqual([]);
      expect(publishes).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('rejects a missing channel with not_found', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.renameChannel({
          channelId: 'missing',
          title: 'x',
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      t.cleanup();
    }
  });
});

describe('ChannelService persistence boundary (#task:1981)', () => {
  it('a failed seed insert leaves NO half-created channel and publishes nothing (§9.6)', async () => {
    const t = bootstrap();
    try {
      const before = t.conversations.listAllChannelsForWorkspace(t.workspace.id).map(c => c.id);
      const publishes: string[] = [];
      const unsub = t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        publishes.push(e.kind);
      });

      // The channel row, its memberships and both seed messages are one atomic
      // unit: failing the seed insert must take the channel with it.
      const insertedIds: string[] = [];
      t.wsTxWrap.current = tx =>
        overrideScope(tx, {
          channels: overrideScope(tx.channels, {
            insertChannel: args => {
              const row = tx.channels.insertChannel(args);
              insertedIds.push(row.id);
              return row;
            },
          }),
          messages: {
            insert: () => {
              throw new Error('seed insert exploded');
            },
          },
        });

      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'doomed',
          memberAgentIds: [t.alice.id, t.bob.id],
          actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
          seed: {
            systemMessageBody: 'context',
            initialPrompt: 'initial',
            autoStartMembers: 'all',
          },
        }),
      ).rejects.toThrowError('seed insert exploded');
      unsub();

      // Not vacuous: the channel really was inserted inside the transaction and
      // then taken back by the rollback.
      expect(insertedIds).toHaveLength(1);
      expect(t.conversations.get(insertedIds[0]!)).toBeNull();
      expect(t.conversations.listAllChannelsForWorkspace(t.workspace.id).map(c => c.id)).toEqual(
        before,
      );
      expect(publishes).toEqual([]);
      expect(t.fake.delivered).toEqual([]);
      expect(t.fake.starts).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('create/rename persistence goes through the TX scope, not a captured repo (R1)', async () => {
    const t = bootstrap();
    try {
      const touched = new Set<string>();
      // One tracer for BOTH axes: every slice of whatever scope arrives is
      // proxied by name, so the assertions below span the create (workspace-keyed)
      // and rename (conversation-keyed) transactions without enumerating either
      // scope's shape here.
      const trace = <S extends object>(tx: S): S =>
        new Proxy(tx, {
          get(scope, sliceName) {
            const slice = Reflect.get(scope, sliceName) as object;
            return new Proxy(slice, {
              get(obj, prop) {
                const value = Reflect.get(obj, prop) as unknown;
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                  touched.add(`${String(sliceName)}.${String(prop)}`);
                  return (value as (...a: unknown[]) => unknown).apply(obj, args);
                };
              },
            });
          },
        });
      t.txWrap.current = trace;
      t.wsTxWrap.current = trace;

      const created = await t.service.createChannel({
        workspaceId: t.workspace.id,
        title: 'traced',
        memberAgentIds: [t.alice.id],
        actor: { kind: 'agent', agentId: t.alice.id, conversationId: t.source.id },
        seed: {
          systemMessageBody: 'context',
          initialPrompt: 'initial',
          autoStartMembers: 'none',
        },
      });
      await t.service.renameChannel({
        channelId: created.channel.id,
        title: 'traced-again',
      });

      expect([...touched]).toContain('channels.insertChannel');
      expect([...touched]).toContain('channels.addAgent');
      expect([...touched]).toContain('channels.getChannelLikeForUpdate');
      expect([...touched]).toContain('channels.updateTitle');
      expect([...touched]).toContain('messages.insert');
      expect([...touched]).toContain('agents.get');
    } finally {
      t.cleanup();
    }
  });
});

/**
 * Write ELIGIBILITY is re-derived inside the lock (#task:1987, Cindy
 * `WzFlaHtF_3-4Jdvx`). Binding the write target to the workspace key is only half
 * the mechanism: the pre-lock gates are early refusals, and a roster change that
 * commits in the seam between them and BEGIN would otherwise let the creation
 * write a membership edge for a principal who is no longer a workspace member.
 *
 * That state is reachable by NO serial order — create-then-remove has the removal
 * cascade take the edge out, remove-then-create refuses — which is exactly the
 * test for a real defect rather than last-writer-wins (§CV). So each arm here
 * COMMITS a rival roster write in the seam (`t.seam`, which runs before BEGIN, not
 * inside the callback where it would roll back with the transaction under test)
 * and then asserts the whole transaction left nothing behind: no channel, no
 * membership edge, no message, no event, no runtime effect.
 */
describe('ChannelService.createChannel — in-lock write eligibility (#task:1987)', () => {
  /** Every row/effect a refused creation must not have produced. Totalled over
   *  the workspace rather than the new channel: "the channel does not exist" and
   *  "the channel is empty" are different claims, and only the first is enough. */
  function tally(t: ReturnType<typeof bootstrap>) {
    const convs = t.conversations.list().filter(c => c.workspace_id === t.workspace.id);
    return {
      conversations: convs.length,
      agentEdges: convs.reduce((n, c) => n + t.conversations.listAgents(c.id).length, 0),
      userEdges: convs.reduce((n, c) => n + t.conversations.listUsers(c.id).length, 0),
      messages: convs.reduce((n, c) => n + t.messages.listForConversation(c.id).length, 0),
      workspaceSeq: Number(t.events.currentSeq(`workspace:${t.workspace.id}`)),
      starts: t.fake.starts.length,
      delivered: t.fake.delivered.length,
    };
  }

  it('a founding AGENT member removed in the seam: typed refusal, nothing written', async () => {
    const t = bootstrap();
    try {
      const before = tally(t);
      // Committed before BEGIN — `bob` passed the pre-lock membership gate and is
      // gone by the time the callback would place him.
      t.seam.current = () => t.workspaces.removeMember(t.workspace.id, t.bob.id);

      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'planning',
          memberAgentIds: [t.alice.id, t.bob.id],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toMatchObject({
        name: 'MemberError',
        code: 'agent_not_workspace_member',
        memberId: t.bob.id,
      });

      // `alice` was placed BEFORE `bob` was rejected in the pre-lock order; the
      // rollback is what makes this equal rather than "one edge and a channel".
      expect(tally(t)).toEqual(before);
    } finally {
      t.cleanup();
    }
  });

  it('an EXPLICIT human member removed in the seam: typed refusal, nothing written', async () => {
    const t = bootstrap();
    try {
      // `teammate` is a fixture user (tests/utils/db.ts); the arm needs it to be a
      // workspace member the caller may legitimately name at create time.
      const teammate = 'teammate';
      t.workspaces.addUserMember(t.workspace.id, teammate, 'member');
      const before = tally(t);
      t.seam.current = () => t.workspaces.removeUserMember(t.workspace.id, teammate);

      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'planning',
          memberAgentIds: [t.alice.id],
          memberUserIds: [teammate],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toMatchObject({
        name: 'MemberError',
        code: 'user_not_workspace_member',
        memberId: teammate,
      });
      expect(tally(t)).toEqual(before);
    } finally {
      t.cleanup();
    }
  });

  it("the CREATOR's own role row removed in the seam: refused as a loss of AUTHORITY", async () => {
    const t = bootstrap();
    try {
      const before = tally(t);
      // The route's authority (`canGovernWorkspace`) IS a `workspace_users` role
      // row, so losing it in the seam would otherwise leave the creator holding a
      // `conversation_users` row in a workspace they no longer belong to. The
      // in-lock order mirrors the PRE-LOCK order — authority, then member
      // eligibility — so a role row that vanished in the seam refuses with the
      // same class the route would have refused with before the request.
      t.seam.current = () => t.workspaces.removeUserMember(t.workspace.id, 'local');

      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'planning',
          memberAgentIds: [t.alice.id],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toMatchObject({
        name: 'ActorError',
        code: 'user_cannot_govern_workspace',
      });
      expect(tally(t)).toEqual(before);
    } finally {
      t.cleanup();
    }
  });

  it('the actor is DEMOTED admin→member in the seam: typed refusal, nothing written', async () => {
    const t = bootstrap();
    try {
      // `teammate` is a fixture user (tests/utils/db.ts). An `admin` — not the
      // `owner`, whose role row is immutable — so the demotion this arm needs is
      // expressible at all.
      const admin = 'teammate';
      t.workspaces.addUserMember(t.workspace.id, admin, 'admin');
      const before = tally(t);
      // Still a MEMBER afterwards, so `humanRole !== null` passes: only the RANK
      // fails. This is the arm the membership predicate alone cannot catch, and it
      // is why this axis projects the role instead of a boolean (Cindy
      // `m6nN9WG8jvusBJA2`) — `addWorkspaceHumanMember` in this same slice already
      // treats an in-seam demotion as a rollback, and two writers of
      // workspace-governed rows must sample authority at the same moment.
      t.seam.current = () => {
        t.workspaces.setUserRole(t.workspace.id, admin, 'member');
      };

      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'planning',
          memberAgentIds: [t.alice.id],
          actor: { kind: 'user', userId: admin },
        }),
      ).rejects.toMatchObject({
        name: 'ActorError',
        // 403 through `channelServiceErrorResponse`'s ChannelActorError branch —
        // the same status the route's own `forbidden` gate returns.
        code: 'user_cannot_govern_workspace',
      });
      expect(tally(t)).toEqual(before);
    } finally {
      t.cleanup();
    }
  });

  it('the ACTOR loses its source-conversation edge in the seam: no seeded channel, no messages', async () => {
    const t = bootstrap();
    try {
      const before = tally(t);
      t.seam.current = () => t.conversations.removeAgent(t.source.id, t.alice.id);

      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'spawned',
          memberAgentIds: [t.alice.id],
          actor: {
            kind: 'agent',
            agentId: t.alice.id,
            conversationId: t.source.id,
          },
          seed: {
            systemMessageBody: 'ctx',
            initialPrompt: 'go',
            autoStartMembers: 'all',
          },
        }),
      ).rejects.toMatchObject({
        name: 'ActorError',
        code: 'agent_not_member_of_source_conv',
      });

      // The seam's own removal is the ONE difference — everything the refused
      // transaction would have written is absent, including both seed messages
      // and the auto-start of every member.
      expect(tally(t)).toEqual({ ...before, agentEdges: before.agentEdges - 1 });
    } finally {
      t.cleanup();
    }
  });

  it('the WORKSPACE is deleted in the seam: a typed refusal instead of a foreign-key crash', async () => {
    const t = bootstrap();
    try {
      t.seam.current = () => {
        t.conversations.delete(t.source.id);
        t.workspaces.delete(t.workspace.id);
      };

      await expect(
        t.service.createChannel({
          workspaceId: t.workspace.id,
          title: 'planning',
          memberAgentIds: [],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toMatchObject({
        name: 'WorkspaceUnsuitableError',
        code: 'workspace_not_found',
      });
      expect(t.conversations.list().filter(c => c.workspace_id === t.workspace.id)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
