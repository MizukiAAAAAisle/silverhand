import { describe, expect, it, vi } from 'vitest';
import type {
  ServerConfig,
} from '@silverhand/shared';
import {
  readThreadAnchorMetadata,
} from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import {
  MembershipError,
  ParentError,
  SeedAgentError,
  ThreadService,
} from '../../src/services/thread-service.js';
import type { BackendLogger } from '../../src/context.js';
import type { AgentRuntimeHost } from '../../src/runtime/agent-runtime-host.js';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

class FakeConversationManager {
  starts: Array<{ conversationId: string; agentId: string }> = [];
  delivered: Array<{ conversationId: string; agentId: string; messageId: string }> = [];
  stops: Array<{ conversationId: string; agentId: string; mode: 'soft' | 'hard' }> = [];
  hangDeliver = false;
  deliverError: Error | null = null;
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

  async stop(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard' = 'hard',
  ): Promise<void> {
    this.stops.push({ conversationId, agentId, mode });
  }

  resolveConversationRuns(): void {}
  resolveRun(): void {}
  getAgentRunStates(): never[] {
    return [];
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
  new HostRepo(db).ensureLocal();
  const agents = new AgentRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const events = new ScopeEventBus('test-epoch');
  const fake = new FakeConversationManager();
  const logger: BackendLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const serverConfig: ServerConfig = {
    mode: 'embedded',
    url: 'http://127.0.0.1:0',
    auth_token: 'a'.repeat(32),
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };
  const service = new ThreadService({
    db,
    conversations,
    messages,
    agents,
    workspaces,
    runtimeHost: fake as unknown as AgentRuntimeHost,
    events,
    logger,
    serverConfig,
    lastSpawnAtByAgent: new Map(),
  });
  const workspace = workspaces.insert({
    name: 'eng',
    description: null,
    workspacePath: tmp.workspacesRoot,
    workspaceHostId: localHostId,
  });
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId, 'local');
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, localHostId, 'local');
  const carol = agents.create({ name: 'carol', runtime: 'claude' }, localHostId, 'local');
  for (const agent of [alice, bob, carol]) {
    workspaces.insertMembership(workspace.id, agent.id);
  }
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
    agents,
    workspaces,
    conversations,
    messages,
    events,
    fake,
    logger,
    service,
    workspace,
    channel,
    alice,
    bob,
    carol,
    cleanup: tmp.cleanup,
  };
}

describe('ThreadService.createThreadFromMessage', () => {
  it('creates a quoted-message thread, publishes first, delivers onboarding, and starts the seed agent', async () => {
    const t = bootstrap();
    try {
      const order: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => {
        if (e.kind === 'thread_updated') order.push('publish');
      });
      t.fake.onDeliver = () => order.push('deliver');
      const original = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'Please inspect\nthis regression',
      });

      const result = await t.service.createThreadFromMessage({
        messageId: original.id,
        actor: { kind: 'user', userId: 'local' },
      });
      unsub();

      expect(result.reused).toBe(false);
      expect(order[0]).toBe('publish');
      const seeded = t.messages.listForConversation(result.thread.id);
      expect(seeded).toHaveLength(2);
      expect(seeded[0]).toMatchObject({
        from_kind: 'system',
        metadata: expect.objectContaining({ subtype: 'thread_anchor' }),
      });
      // PR-5 producer round-trip: thread_anchor metadata must satisfy
      // ThreadAnchorMetadataSchema so the renderer can pull a Quoted
      // card without re-parsing message.content.
      const anchorParsed = readThreadAnchorMetadata(
        seeded[0]!.metadata as Record<string, unknown>,
      );
      expect(anchorParsed).not.toBeNull();
      expect(anchorParsed!.quoted_message_id).toBe(original.id);
      expect(anchorParsed!.quoted_conversation_id).toBe(t.channel.id);
      expect(anchorParsed!.quoted_content).toBe('Please inspect\nthis regression');
      expect(anchorParsed!.quoted_from_kind).toBe('user');
      expect(seeded[1]).toMatchObject({
        from_kind: 'system',
        metadata: { subtype: 'onboarding' },
      });
      expect(t.fake.delivered).toHaveLength(1);
      expect(t.fake.delivered[0]).toMatchObject({
        conversationId: result.thread.id,
        messageId: seeded[1]!.id,
      });
      expect([t.alice.id, t.bob.id]).toContain(t.fake.delivered[0]!.agentId);
      expect(t.fake.starts).toEqual([
        { conversationId: result.thread.id, agentId: t.fake.delivered[0]!.agentId },
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('reuses an open anchored thread without side effects', async () => {
    const t = bootstrap();
    try {
      const original = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.bob.id,
        content: 'drill down here',
      });
      const first = await t.service.createThreadFromMessage({
        messageId: original.id,
        actor: { kind: 'user', userId: 'local' },
      });
      t.fake.delivered = [];
      t.fake.starts = [];
      const events: string[] = [];
      const unsub = t.events.subscribe(t.channel.id, e => events.push(e.kind));

      const second = await t.service.createThreadFromMessage({
        messageId: original.id,
        actor: { kind: 'user', userId: 'local' },
      });
      unsub();

      expect(second.reused).toBe(true);
      expect(second.thread.id).toBe(first.thread.id);
      expect(second.thread.anchor_message_id).toBe(original.id);
      expect(t.fake.delivered).toHaveLength(0);
      expect(t.fake.starts).toHaveLength(0);
      expect(events).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it('falls back to workspace members when a channel has no conversation agents', async () => {
    const t = bootstrap();
    try {
      const empty = t.conversations.insertChannel({
        workspaceId: t.workspace.id,
        workspacePath: t.workspace.workspace_path,
        title: 'empty',
      });
      const original = t.messages.insertForConversation({
        conversationId: empty.id,
        fromKind: 'user',
        content: 'needs a thread',
      });

      const result = await t.service.createThreadFromMessage({
        messageId: original.id,
        actor: { kind: 'user', userId: 'local' },
      });

      expect(t.conversations.listAgents(result.thread.id).map(a => a.agent_id).sort())
        .toEqual([t.alice.id, t.bob.id, t.carol.id].sort());
    } finally {
      t.cleanup();
    }
  });

  it('rejects a missing seed agent before inserting', async () => {
    const t = bootstrap();
    try {
      const msg = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'agent',
        fromAgentId: t.carol.id,
        content: 'stale agent author',
      });
      t.db.pragma('foreign_keys = OFF');
      try {
        t.db.prepare('UPDATE messages SET from_agent_id = ? WHERE id = ?')
          .run('missing-agent', msg.id);
      } finally {
        t.db.pragma('foreign_keys = ON');
      }

      await expect(
        t.service.createThreadFromMessage({
          messageId: msg.id,
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toBeInstanceOf(SeedAgentError);
    } finally {
      t.cleanup();
    }
  });
});

describe('ThreadService user-membership inheritance (v25)', () => {
  it('inherits user members from the parent conversation when creating a thread', async () => {
    const t = bootstrap();
    try {
      // Drop test-fixture autoseed triggers so observed user
      // membership reflects only what ThreadService writes.
      t.db.exec(
        `DROP TRIGGER IF EXISTS test_seed_workspace_users;
         DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
      );
      // Pin parent conversation_users to a specific subset.
      t.db.exec(
        `DELETE FROM conversation_users WHERE conversation_id = '${t.channel.id}'`,
      );
      t.db
        .prepare(
          `INSERT INTO conversation_users (conversation_id, user_id, joined_at)
             VALUES (?, 'local', ?), (?, 'alice', ?)`,
        )
        .run(t.channel.id, Date.now(), t.channel.id, Date.now());

      const anchor = t.messages.insertForConversation({
        conversationId: t.channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'open a legacy thread',
      });
      const result = await t.service.createThreadFromMessage({
        messageId: anchor.id,
        actor: { kind: 'user', userId: 'local' },
      });

      const userMembers = t.conversations
        .listUsers(result.thread.id)
        .map(u => u.user_id)
        .sort();
      expect(userMembers).toEqual(['alice', 'local']);
    } finally {
      t.cleanup();
    }
  });
});
