import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import {
  AttachmentRejection,
  AttachmentService,
  detectContentType,
} from '../../src/services/attachment-service.js';
import { createLocalBlobFileStorage } from '../../src/storage/blob-file-storage.js';
import { makeTempSilverhandDir, openTestDb } from '../utils/db.js';

function bootstrap() {
  const { db, localHostId } = openTestDb();
  const tmp = makeTempSilverhandDir();
  const workspaces = new WorkspaceRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-attsvc-test'),
  });
  const workspacePath = workspaces.workspacePathFor('att-ws');
  const workspace = workspaces.insert({
    name: 'att-ws',
    description: null,
    workspacePath,
    workspaceHostId: localHostId,
  });
  const agent = new AgentRepo(db).create({ name: 'a', runtime: 'claude' }, localHostId);
  workspaces.addMember(workspace.id, agent.id);
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 't',
  });
  const thread = conversations.insertThread({
    channelId: channel.id,
    title: 'thread',
  });
  conversations.addAgent(channel.id, agent.id);

  const storage = createLocalBlobFileStorage({ silverhandDir: tmp.silverhandDir });
  const service = new AttachmentService({
    storage,
    attachments: new AttachmentRepo(db),
    conversations,
  });
  return {
    db,
    channel,
    thread,
    service,
    storage,
    cleanup: tmp.cleanup,
    silverhandDir: tmp.silverhandDir,
    localHostId,
  };
}

describe('AttachmentService.upload', () => {
  it('writes the blob and stores a row scoped to the channel', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'shot.png',
        contentType: null,
        // PNG magic bytes — exercise the content-type sniff path.
        buffer: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          Buffer.alloc(8, 0),
        ]),
        createdByKind: 'user',
        createdById: 'local',
      });
      expect(dto.channel_id).toBe(channel.id);
      expect(dto.content_type).toBe('image/png');
      expect(dto.filename).toBe('shot.png');
      expect(dto.size).toBe(12);
    } finally {
      cleanup();
    }
  });

  it('uploads from a thread and resolves to the parent channel', async () => {
    const { service, channel, thread, cleanup } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: thread.id,
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4'),
        createdByKind: 'agent',
        createdById: 'agent-id',
      });
      expect(dto.channel_id).toBe(channel.id);
      expect(dto.source_conversation_id).toBe(thread.id);
    } finally {
      cleanup();
    }
  });

  it('rejects empty buffers and oversize uploads', async () => {
    const { db, channel, cleanup } = bootstrap();
    try {
      const tmp = makeTempSilverhandDir();
      const storage = createLocalBlobFileStorage({ silverhandDir: tmp.silverhandDir });
      const service = new AttachmentService({
        storage,
        attachments: new AttachmentRepo(db),
        conversations: new ConversationRepo(db),
        maxBytes: 8,
      });
      await expect(
        service.upload({
          sourceConversationId: channel.id,
          filename: 'x.png',
          contentType: null,
          buffer: Buffer.alloc(0),
          createdByKind: 'user',
          createdById: 'local',
        }),
      ).rejects.toBeInstanceOf(AttachmentRejection);

      await expect(
        service.upload({
          sourceConversationId: channel.id,
          filename: 'x.png',
          contentType: null,
          buffer: Buffer.alloc(16),
          createdByKind: 'user',
          createdById: 'local',
        }),
      ).rejects.toMatchObject({ failure: { kind: 'too_large' } });
      tmp.cleanup();
    } finally {
      cleanup();
    }
  });

  it('rejects unknown source conversations', async () => {
    const { service, cleanup } = bootstrap();
    try {
      await expect(
        service.upload({
          sourceConversationId: 'missing',
          filename: 'x.png',
          contentType: null,
          buffer: Buffer.from('data'),
          createdByKind: 'user',
          createdById: 'local',
        }),
      ).rejects.toMatchObject({ failure: { kind: 'conversation_not_found' } });
    } finally {
      cleanup();
    }
  });
});

describe('AttachmentService.locateForAgent', () => {
  it('returns the local path for own-channel attachments', async () => {
    const { service, channel, cleanup, silverhandDir } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'x.png',
        contentType: 'image/png',
        buffer: Buffer.from('bytes'),
        createdByKind: 'agent',
        createdById: 'agent-id',
      });
      const located = await service.locateForAgent(dto.id, channel.id);
      expect(located).not.toBeNull();
      expect(located!.locate.storage).toBe('local');
      if (located!.locate.storage === 'local') {
        expect(located!.locate.local_path.startsWith(silverhandDir)).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it('denies cross-channel access (returns null without leaking existence)', async () => {
    const { service, channel, cleanup, db, localHostId } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'x.png',
        contentType: 'image/png',
        buffer: Buffer.from('bytes'),
        createdByKind: 'agent',
        createdById: 'agent-id',
      });
      const conversations = new ConversationRepo(db);
      const otherWorkspace = new WorkspaceRepo(db, {
        workspacesRoot: join(tmpdir(), 'silverhand-attsvc-test-2'),
      }).insert({
        name: 'other',
        description: null,
        workspacePath: join(tmpdir(), 'silverhand-attsvc-test-2', 'other'),
        workspaceHostId: localHostId,
      });
      const otherChannel = conversations.insertChannel({
        workspaceId: otherWorkspace.id,
        workspacePath: otherWorkspace.workspace_path,
        title: 'o',
      });
      const denied = await service.locateForAgent(dto.id, otherChannel.id);
      expect(denied).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('AttachmentService.resolveSnapshotsForChannel', () => {
  it('returns snapshots when all ids belong to the channel', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      const a = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('a'),
        createdByKind: 'user',
        createdById: 'local',
      });
      const b = await service.upload({
        sourceConversationId: channel.id,
        filename: 'b.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('b'),
        createdByKind: 'user',
        createdById: 'local',
      });
      const result = service.resolveSnapshotsForChannel([a.id, b.id], channel.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.snapshots.map(s => s.filename).sort()).toEqual(['a.txt', 'b.txt']);
      }
    } finally {
      cleanup();
    }
  });

  it('flags the offending id when one belongs to a different channel', async () => {
    const { service, channel, cleanup, db, localHostId } = bootstrap();
    try {
      const owned = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('a'),
        createdByKind: 'user',
        createdById: 'local',
      });

      // Create another channel and upload an attachment scoped to it.
      const otherWorkspace = new WorkspaceRepo(db, {
        workspacesRoot: join(tmpdir(), 'silverhand-attsvc-test-3'),
      }).insert({
        name: 'other',
        description: null,
        workspacePath: join(tmpdir(), 'silverhand-attsvc-test-3', 'other'),
        workspaceHostId: localHostId,
      });
      const otherChannel = new ConversationRepo(db).insertChannel({
        workspaceId: otherWorkspace.id,
        workspacePath: otherWorkspace.workspace_path,
        title: 'o',
      });
      const foreign = await service.upload({
        sourceConversationId: otherChannel.id,
        filename: 'foreign.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('x'),
        createdByKind: 'user',
        createdById: 'local',
      });

      const result = service.resolveSnapshotsForChannel(
        [owned.id, foreign.id],
        channel.id,
      );
      expect(result).toEqual({ ok: false, offendingId: foreign.id });
    } finally {
      cleanup();
    }
  });
});

describe('detectContentType', () => {
  it('honours an explicit MIME type', () => {
    expect(detectContentType('text/plain', Buffer.from(''), 'x.png')).toBe('text/plain');
  });
  it('sniffs PNG magic bytes', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.alloc(4, 0),
    ]);
    expect(detectContentType(null, png, 'x.bin')).toBe('image/png');
  });
  it('falls back to extension when no sniff and no explicit', () => {
    expect(detectContentType(null, Buffer.from('hi'), 'a.json')).toBe('application/json');
  });
  it('defaults to octet-stream when nothing matches', () => {
    expect(detectContentType(null, Buffer.from('hi'), 'a.unknown')).toBe(
      'application/octet-stream',
    );
  });
});
