import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo, SYSTEM_DM_WORKSPACE_ID } from '../../src/repos/workspace-repo.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const conversations = new ConversationRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const messages = new MessageRepo(db);
  const agents = new AgentRepo(db);
  return {
    db,
    localHostId,
    tmp,
    conversations,
    workspaces,
    messages,
    agents,
    cleanup: tmp.cleanup,
  };
}

describe('ConversationRepo canonical schema', () => {
  it('creates channels, threads, agents, and messages without legacy tables', () => {
    const t = bootstrap();
    try {
      const agent = t.agents.create({ name: 'alice', runtime: 'claude' }, t.localHostId);
      const workspacePath = join(t.tmp.workspacesRoot, 'eng');
      const workspace = t.workspaces.insert({
        name: 'eng',
        description: 'Engineering',
        workspacePath,
        workspaceHostId: t.localHostId,
      });
      t.workspaces.addMember(workspace.id, agent.id);
      const channel = t.conversations.insertChannel({
        workspaceId: workspace.id,
        workspacePath,
        title: 'Planning',
      });
      t.conversations.addAgent(channel.id, agent.id);
      const thread = t.conversations.insertThread({
        channelId: channel.id,
        title: 'Follow-up',
      });
      const message = t.messages.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'hello',
      });

      expect(t.workspaces.get(workspace.id)).toMatchObject({
        id: workspace.id,
        name: 'eng',
        workspace_kind: 'regular',
        workspace_path: workspacePath,
      });
      expect(t.conversations.getChannel(channel.id)).toMatchObject({
        id: channel.id,
        workspace_id: workspace.id,
        workspace_path: workspacePath,
        kind: 'channel',
        title: 'Planning',
      });
      expect(t.conversations.getThread(thread.id)).toMatchObject({
        id: thread.id,
        workspace_id: workspace.id,
        channel_id: channel.id,
        workspace_path: workspacePath,
        kind: 'thread',
      });
      expect(t.conversations.listAgents(channel.id).map(a => a.agent_id)).toEqual([
        agent.id,
      ]);
      const rawMessage = t.db
        .prepare<[string], { conversation_id: string }>(
          'SELECT conversation_id FROM messages WHERE id = ?',
        )
        .get(message.id);
      expect(rawMessage?.conversation_id).toBe(channel.id);

      const oldTables = t.db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('channels', 'channel_members', 'sessions',
                          'session_agents', 'session_reads', 'agent_inboxes')`,
        )
        .all()
        .map(r => r.name);
      expect(oldTables).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('keeps DM channels under the hidden system workspace with agent L1 path snapshots', () => {
    const t = bootstrap();
    try {
      const agent = t.agents.create({ name: 'cindy', runtime: 'codex' }, t.localHostId);
      const agentWorkspacePath = join(t.tmp.silverhandDir, 'agents', agent.id);
      const system = t.workspaces.ensureSystemDmWorkspace({
        workspacePath: agentWorkspacePath,
        workspaceHostId: t.localHostId,
      });
      const dm = t.conversations.insertDmChannel({
        workspaceId: system.id,
        workspacePath: agentWorkspacePath,
        title: 'dm-cindy',
        agentId: agent.id,
      });
      t.conversations.addAgent(dm.id, agent.id);
      const thread = t.conversations.insertThread({
        channelId: dm.id,
        title: 'Thread in DM',
      });

      expect(t.workspaces.list().map(w => w.id)).not.toContain(SYSTEM_DM_WORKSPACE_ID);
      expect(t.workspaces.get(SYSTEM_DM_WORKSPACE_ID)).toMatchObject({
        workspace_kind: 'system_dm',
      });
      expect(t.conversations.getDmChannel(dm.id)).toMatchObject({
        id: dm.id,
        workspace_id: SYSTEM_DM_WORKSPACE_ID,
        workspace_path: agentWorkspacePath,
        kind: 'dm_channel',
      });
      expect(t.conversations.getThread(thread.id)).toMatchObject({
        id: thread.id,
        workspace_id: SYSTEM_DM_WORKSPACE_ID,
        channel_id: dm.id,
        workspace_path: agentWorkspacePath,
        kind: 'thread',
      });
    } finally {
      t.cleanup();
    }
  });

  it('rejects nested threads', () => {
    const t = bootstrap();
    try {
      const workspacePath = join(t.tmp.workspacesRoot, 'nested');
      const workspace = t.workspaces.insert({
        name: 'nested',
        description: null,
        workspacePath,
        workspaceHostId: t.localHostId,
      });
      const channel = t.conversations.insertChannel({
        workspaceId: workspace.id,
        workspacePath,
        title: 'Root',
      });
      const thread = t.conversations.insertThread({
        channelId: channel.id,
        title: 'Child',
      });
      expect(() =>
        t.conversations.insertThread({
          channelId: thread.id,
          title: 'Nested',
        }),
      ).toThrow('parent channel not found');
    } finally {
      t.cleanup();
    }
  });

  it('lists anchored and unanchored thread summaries in one parent query', () => {
    const t = bootstrap();
    try {
      const workspacePath = join(t.tmp.workspacesRoot, 'thread-summaries');
      const workspace = t.workspaces.insert({
        name: 'thread-summaries',
        description: null,
        workspacePath,
        workspaceHostId: t.localHostId,
      });
      const channel = t.conversations.insertChannel({
        workspaceId: workspace.id,
        workspacePath,
        title: 'Root',
      });
      const original = t.messages.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'topic',
      });
      const anchored = t.conversations.insertThread({
        channelId: channel.id,
        title: 'Anchored',
      });
      t.messages.insertForConversation({
        conversationId: anchored.id,
        fromKind: 'system',
        content: 'anchor',
        metadata: {
          subtype: 'thread_anchor',
          quoted_message_id: original.id,
        },
      });
      t.messages.insertForConversation({
        conversationId: anchored.id,
        fromKind: 'agent',
        fromAgentId: null,
        content: 'reply',
      });
      const unanchored = t.conversations.insertThread({
        channelId: channel.id,
        title: 'Unanchored',
      });
      t.messages.insertForConversation({
        conversationId: unanchored.id,
        fromKind: 'system',
        content: 'context',
        metadata: { subtype: 'child_context' },
      });
      t.messages.insertForConversation({
        conversationId: unanchored.id,
        fromKind: 'agent',
        fromAgentId: null,
        content: 'prompt',
      });

      expect(t.conversations.listThreadSummariesForParent(channel.id)).toEqual([
        {
          thread_id: anchored.id,
          anchor_message_id: original.id,
          reply_count: 1,
        },
        {
          thread_id: unanchored.id,
          anchor_message_id: null,
          reply_count: 1,
        },
      ]);
    } finally {
      t.cleanup();
    }
  });
});
