import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ChannelRepo } from '../../src/repos/channel-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SessionRepo } from '../../src/repos/session-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const channels = new ChannelRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const sessions = new SessionRepo(db);
  const conversations = new ConversationRepo(db);
  const workspaces = new WorkspaceRepo(db, { workspacesRoot: tmp.workspacesRoot });
  const messages = new MessageRepo(db);
  const agents = new AgentRepo(db);
  return {
    db,
    localHostId,
    tmp,
    channels,
    sessions,
    conversations,
    workspaces,
    messages,
    agents,
    cleanup: tmp.cleanup,
  };
}

describe('Workspace/Conversation shadow schema', () => {
  it('mirrors legacy regular channel/session writes into workspaces/conversations', () => {
    const t = bootstrap();
    try {
      const agent = t.agents.create({ name: 'alice', runtime: 'claude' }, t.localHostId);
      const channelPath = join(t.tmp.workspacesRoot, 'eng');
      const legacyChannel = t.channels.insert({
        name: 'eng',
        description: 'Engineering',
        kind: 'regular',
        workspace_path: channelPath,
        workspace_host_id: t.localHostId,
        dm_agent_id: null,
      });
      const session = t.sessions.insert({
        channelId: legacyChannel.id,
        title: 'Planning',
      });
      t.sessions.addAgent(session.id, agent.id);
      const message = t.messages.insert({
        sessionId: session.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'hello',
      });

      const workspace = t.workspaces.get(legacyChannel.id);
      expect(workspace).toMatchObject({
        id: legacyChannel.id,
        name: 'eng',
        workspace_kind: 'regular',
        workspace_path: channelPath,
      });

      const conversation = t.conversations.getChannel(session.id);
      expect(conversation).toMatchObject({
        id: session.id,
        workspace_id: legacyChannel.id,
        workspace_path: channelPath,
        kind: 'channel',
        title: 'Planning',
      });
      expect(t.conversations.listAgents(session.id).map(a => a.agent_id)).toEqual([
        agent.id,
      ]);

      const rawMessage = t.db
        .prepare<[string], { conversation_id: string | null }>(
          'SELECT conversation_id FROM messages WHERE id = ?',
        )
        .get(message.id);
      expect(rawMessage?.conversation_id).toBe(session.id);
    } finally {
      t.cleanup();
    }
  });

  it('mirrors legacy child sessions as threads with a copied workspace path', () => {
    const t = bootstrap();
    try {
      const channelPath = join(t.tmp.workspacesRoot, 'threads');
      const legacyChannel = t.channels.insert({
        name: 'threads',
        description: null,
        kind: 'regular',
        workspace_path: channelPath,
        workspace_host_id: t.localHostId,
        dm_agent_id: null,
      });
      const parent = t.sessions.insert({
        channelId: legacyChannel.id,
        title: 'Parent',
      });
      const child = t.sessions.insert({
        channelId: legacyChannel.id,
        title: 'Child',
        parentSessionId: parent.id,
      });

      const thread = t.conversations.getThread(child.id);
      expect(thread).toMatchObject({
        id: child.id,
        workspace_id: legacyChannel.id,
        channel_id: parent.id,
        workspace_path: channelPath,
        kind: 'thread',
        title: 'Child',
      });
    } finally {
      t.cleanup();
    }
  });

  it('keeps DM channels under the hidden system workspace and preserves DM threads', () => {
    const t = bootstrap();
    try {
      const agent = t.agents.create({ name: 'cindy', runtime: 'codex' }, t.localHostId);
      const agentWorkspacePath = join(t.tmp.silverhandDir, 'agents', agent.id);
      const legacyDm = t.channels.insert({
        name: 'dm-cindy',
        description: 'DM with @cindy',
        kind: 'dm',
        workspace_path: agentWorkspacePath,
        workspace_host_id: t.localHostId,
        dm_agent_id: agent.id,
      });
      const dmRoot = t.sessions.insert({
        channelId: legacyDm.id,
        title: 'Onboarding',
      });
      const dmThread = t.sessions.insert({
        channelId: legacyDm.id,
        title: 'Thread in DM',
        parentSessionId: dmRoot.id,
      });

      expect(t.workspaces.list().map(w => w.id)).not.toContain('__system_dm_workspace__');
      expect(t.workspaces.get('__system_dm_workspace__')).toMatchObject({
        workspace_kind: 'system_dm',
      });

      const dmConversation = t.conversations.getDmChannel(dmRoot.id);
      expect(dmConversation).toMatchObject({
        id: dmRoot.id,
        workspace_id: '__system_dm_workspace__',
        workspace_path: agentWorkspacePath,
        kind: 'dm_channel',
      });

      const thread = t.conversations.getThread(dmThread.id);
      expect(thread).toMatchObject({
        id: dmThread.id,
        workspace_id: '__system_dm_workspace__',
        channel_id: dmRoot.id,
        workspace_path: agentWorkspacePath,
        kind: 'thread',
      });
    } finally {
      t.cleanup();
    }
  });
});
