import { describe, expect, it, vi } from 'vitest';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
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
import type { ConversationManager } from '../../src/conversation-manager.js';
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
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const hosts = new HostRepo(db);
  hosts.ensureLocal();
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
  const service = new ChannelService({
    db,
    conversations,
    workspaces,
    agents,
    messages,
    events,
    conversationManager: fake as unknown as ConversationManager,
    logger,
  });
  const workspace = workspaces.insert({
    name: 'eng',
    description: null,
    workspacePath: tmp.workspacesRoot,
    workspaceHostId: localHostId,
  });
  const alice = agents.create({ name: 'alice', runtime: 'claude' }, localHostId);
  const bob = agents.create({ name: 'bob', runtime: 'claude' }, localHostId);
  workspaces.addMember(workspace.id, alice.id);
  workspaces.addMember(workspace.id, bob.id);
  const source = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath: workspace.workspace_path,
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
        workspacePath: `${t.tmp.silverhandDir}/agents/${t.alice.id}`,
      });
      await expect(
        t.service.createChannel({
          workspaceId: dmWorkspace.id,
          title: 'x',
          memberAgentIds: [],
          actor: { kind: 'user', userId: 'local' },
        }),
      ).rejects.toBeInstanceOf(WorkspaceUnsuitableError);

      const outsider = t.agents.create({ name: 'outsider', runtime: 'claude' }, t.localHostId);
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
        workspacePath: t.tmp.workspacesRoot,
        workspaceHostId: t.localHostId,
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
});

describe('ChannelService.setPinned', () => {
  it('pins and unpins channel-like conversations with workspace publish', async () => {
    const t = bootstrap();
    try {
      const events: string[] = [];
      const unsub = t.events.subscribeScope(`workspace:${t.workspace.id}`, e => {
        events.push(e.kind);
      });
      await t.service.setPinned({ channelId: t.source.id, pinned: true });
      expect(t.conversations.get(t.source.id)?.pinned_at).not.toBeNull();
      await t.service.setPinned({ channelId: t.source.id, pinned: false });
      unsub();
      expect(t.conversations.get(t.source.id)?.pinned_at).toBeNull();
      expect(events).toEqual(['workspace_channels_changed', 'workspace_channels_changed']);
    } finally {
      t.cleanup();
    }
  });

  it('normalizes missing and thread ids to RepoError codes', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.setPinned({ channelId: 'missing', pinned: true }),
      ).rejects.toMatchObject({ code: 'not_found' });
      const thread = t.conversations.insertThread({
        channelId: t.source.id,
        title: 'thread',
      });
      await expect(
        t.service.setPinned({ channelId: thread.id, pinned: false }),
      ).rejects.toMatchObject({ code: 'thread' });
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

  it('rejects threads and missing ids with not_archivable / not_found', async () => {
    const t = bootstrap();
    try {
      await expect(
        t.service.setArchived({ channelId: 'missing', archived: true }),
      ).rejects.toMatchObject({ code: 'not_found' });
      const thread = t.conversations.insertThread({
        channelId: t.source.id,
        title: 'thread',
      });
      await expect(
        t.service.setArchived({ channelId: thread.id, archived: true }),
      ).rejects.toMatchObject({ code: 'not_archivable' });
    } finally {
      t.cleanup();
    }
  });
});
