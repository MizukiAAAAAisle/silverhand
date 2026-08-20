import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fixedConversationTitle } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const conversations = new ConversationRepo(db);
  const workspaces = new WorkspaceRepo(db);
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
  it('creates channels, agents, and messages without legacy tables', () => {
    const t = bootstrap();
    try {
      const agent = t.agents.create({ name: 'alice', runtime: 'claude' }, t.localHostId, 'local');
      const workspace = t.workspaces.insert({
        name: fixedWorkspaceName('eng'),
        description: 'Engineering',
      });
      t.workspaces.insertMembership(workspace.id, agent.id);
      const channel = t.conversations.insertChannel({
        workspaceId: workspace.id,
        title: fixedConversationTitle('Planning'),
      });
      t.conversations.addAgent(channel.id, agent.id);
      const message = t.messages.insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'hello',
      });

      expect(t.workspaces.get(workspace.id)).toMatchObject({
        id: workspace.id,
        name: 'eng',
        owner_agent_id: null,
      });
      expect(t.conversations.getChannel(channel.id)).toMatchObject({
        id: channel.id,
        workspace_id: workspace.id,
        placement_kind: 'workspace',
        roster_policy: 'open',
        title: 'Planning',
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

  it('keeps DM channels under the agent_home workspace with agent L1 path snapshots', () => {
    const t = bootstrap();
    try {
      const agent = t.agents.create({ name: 'cindy', runtime: 'codex' }, t.localHostId, 'local');
      const home = t.workspaces.insertAgentHome({
        agent,
      });
      const dm = t.conversations.insertDmChannel({
        workspaceId: home.id,
        title: fixedConversationTitle('dm-cindy'),
        agentId: agent.id,
      });
      t.conversations.addAgent(dm.id, agent.id);
      const mentions = t.conversations.insertDmChannel({
        workspaceId: home.id,
        title: fixedConversationTitle('Mentions'),
        agentId: agent.id,
      });
      t.conversations.addAgent(mentions.id, agent.id);

      expect(t.workspaces.get(home.id)).toMatchObject({
        owner_agent_id: agent.id,
        dm_channel_id: dm.id,
      });
      expect(t.conversations.listAllDmChannelsForWorkspace(home.id).map(c => c.id))
        .toEqual([dm.id, mentions.id]);
      expect(t.conversations.getDmChannel(dm.id)).toMatchObject({
        id: dm.id,
        workspace_id: home.id,
        placement_kind: 'workspace',
        roster_policy: 'fixed',
      });
    } finally {
      t.cleanup();
    }
  });

});
