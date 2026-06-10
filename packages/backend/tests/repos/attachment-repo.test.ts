import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo, rowToDto, rowToSnapshot } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-att-test'),
  });
  const workspacePath = workspaces.workspacePathFor('att-ws');
  const workspace = workspaces.insert({
    name: 'att-ws',
    description: null,
    workspacePath,
    workspaceHostId: localHostId,
  });
  const agent = new AgentRepo(db).create({ name: 'a', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, agent.id);
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 't',
  });
  conversations.addAgent(channel.id, agent.id);
  return { db, channel, conversations, workspaces, workspace, agentId: agent.id };
}

describe('AttachmentRepo', () => {
  it('inserts and retrieves a row by id', () => {
    const { db, channel } = bootstrap();
    const repo = new AttachmentRepo(db);
    const dto = repo.insert({
      channelId: channel.id,
      sourceConversationId: channel.id,
      filename: 'x.png',
      size: 12,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/abc.png',
      createdByKind: 'user',
      createdById: 'local',
    });

    expect(dto.id).toBeTruthy();
    expect(dto.filename).toBe('x.png');
    expect(dto.created_by_kind).toBe('user');

    const row = repo.getById(dto.id);
    expect(row).not.toBeNull();
    expect(rowToDto(row!).id).toBe(dto.id);
    expect(rowToSnapshot(row!)).toEqual({
      id: dto.id,
      filename: 'x.png',
      size: 12,
      content_type: 'image/png',
    });
  });

  it('listByIds preserves filtering and listByChannel returns owned rows', () => {
    const { db, channel } = bootstrap();
    const repo = new AttachmentRepo(db);
    const a = repo.insert({
      channelId: channel.id,
      sourceConversationId: channel.id,
      filename: 'a.png',
      size: 1,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/a.png',
      createdByKind: 'user',
      createdById: 'local',
    });
    const b = repo.insert({
      channelId: channel.id,
      sourceConversationId: channel.id,
      filename: 'b.png',
      size: 1,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/b.png',
      createdByKind: 'user',
      createdById: 'local',
    });

    const fetched = repo.listByIds([a.id, b.id, 'missing']);
    expect(fetched.map(r => r.id).sort()).toEqual([a.id, b.id].sort());

    const owned = repo.listByChannel(channel.id);
    expect(owned).toHaveLength(2);
  });

  it('cascades on channel delete and SET NULL on source conversation delete', () => {
    const { db, channel, conversations, workspace } = bootstrap();
    const thread = conversations.insertThread({
      channelId: channel.id,
      title: 't',
    });
    const repo = new AttachmentRepo(db);
    const dto = repo.insert({
      channelId: channel.id,
      sourceConversationId: thread.id,
      filename: 'x.png',
      size: 1,
      contentType: 'image/png',
      storage: 'local',
      storageKey: 'attachments/x.png',
      createdByKind: 'user',
      createdById: 'local',
    });

    // Source conversation delete → SET NULL on attachments.source_conversation_id.
    db.prepare('DELETE FROM conversations WHERE id = ?').run(thread.id);
    const afterThreadDelete = repo.getById(dto.id);
    expect(afterThreadDelete?.source_conversation_id).toBeNull();

    // Channel delete → CASCADE removes the row.
    db.prepare('DELETE FROM conversations WHERE id = ?').run(channel.id);
    expect(repo.getById(dto.id)).toBeNull();
    void workspace;
  });
});
