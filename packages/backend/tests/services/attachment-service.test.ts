import { describe, expect, it } from 'vitest';
import { testWorkspacePath } from '../utils/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeOpenExtension } from '@silverhand/shared';
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
  const workspaces = new WorkspaceRepo(db);
  const workspacePath = testWorkspacePath('att-ws');
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

  const storage = createLocalBlobFileStorage({ rootDir: join(tmp.silverhandDir, 'blobs') });
  const service = new AttachmentService({
    storage,
    attachments: new AttachmentRepo(db),
    conversations,
  });
  return {
    db,
    channel,
    service,
    storage,
    agent,
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

  it('rejects empty buffers and oversize uploads', async () => {
    const { db, channel, cleanup } = bootstrap();
    try {
      const tmp = makeTempSilverhandDir();
      const storage = createLocalBlobFileStorage({ rootDir: join(tmp.silverhandDir, 'blobs') });
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
    const { service, channel, agent, cleanup, silverhandDir } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'x.png',
        contentType: 'image/png',
        buffer: Buffer.from('bytes'),
        createdByKind: 'agent',
        createdById: agent.id,
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
    const { service, channel, agent, cleanup, db, localHostId } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'x.png',
        contentType: 'image/png',
        buffer: Buffer.from('bytes'),
        createdByKind: 'agent',
        createdById: agent.id,
      });
      const conversations = new ConversationRepo(db);
      const otherWorkspace = new WorkspaceRepo(db).insert({
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

describe('AttachmentService.serveForViewer', () => {
  it('streams when the attachment exists and ACL callback allows', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'x.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('hello'),
        createdByKind: 'user',
        createdById: 'local',
      });
      const res = await service.serveForViewer(dto.id, row => row.channel_id === channel.id);
      expect(res).not.toBeNull();
      expect(res!.headers.get('content-type')).toBe('text/plain');
      expect(await res!.text()).toBe('hello');
    } finally {
      cleanup();
    }
  });

  it('folds missing rows and ACL denied into null', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      let callbackCalls = 0;
      const missing = await service.serveForViewer('missing', () => {
        callbackCalls += 1;
        return true;
      });
      expect(missing).toBeNull();
      expect(callbackCalls).toBe(0);

      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'x.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('hello'),
        createdByKind: 'user',
        createdById: 'local',
      });
      const denied = await service.serveForViewer(dto.id, () => false);
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
      const result = service.resolveSnapshotsForChannel(
        [{ id: a.id }, { id: b.id }],
        channel.id,
      );
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
      const otherWorkspace = new WorkspaceRepo(db).insert({
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
        [{ id: owned.id }, { id: foreign.id }],
        channel.id,
      );
      expect(result).toEqual({
        ok: false,
        offendingId: foreign.id,
        reason: 'outside_channel',
      });
    } finally {
      cleanup();
    }
  });

  it('rejects a label whose kind contradicts the real content type', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      const pdf = await service.upload({
        sourceConversationId: channel.id,
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        buffer: Buffer.from('%PDF'),
        createdByKind: 'user',
        createdById: 'local',
      });
      const png = await service.upload({
        sourceConversationId: channel.id,
        filename: 'pic.png',
        contentType: 'image/png',
        buffer: Buffer.from('x'),
        createdByKind: 'user',
        createdById: 'local',
      });

      // PDF claiming to be an image is a trust-boundary lie → rejected.
      expect(
        service.resolveSnapshotsForChannel([{ id: pdf.id, label: 'Image #1' }], channel.id),
      ).toEqual({ ok: false, offendingId: pdf.id, reason: 'label_kind_mismatch' });

      // A matching kind passes and stamps the label onto the snapshot.
      const ok = service.resolveSnapshotsForChannel(
        [{ id: png.id, label: 'Image #1' }],
        channel.id,
      );
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.snapshots[0]?.label).toBe('Image #1');
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
  it('treats application/octet-stream as a no-hint and continues to suffix detection', () => {
    // Reproduces the `#task:383` bug: agent-uploaded HTML had its MIME
    // recorded as `application/octet-stream` because the explicit branch
    // accepted that uninformative value. The contract is that
    // octet-stream — regardless of source (CLI default, multipart
    // default, browser fallback) — must fall through to magic + suffix.
    expect(
      detectContentType(
        'application/octet-stream',
        Buffer.from('<html></html>'),
        'report.html',
      ),
    ).toBe('text/html');
  });
  it('treats octet-stream + suffix-mapped extension as the suffix MIME', () => {
    expect(
      detectContentType('application/octet-stream', Buffer.from('hi'), 'notes.md'),
    ).toBe('text/markdown');
    expect(
      detectContentType('application/octet-stream', Buffer.from('a,b'), 'data.csv'),
    ).toBe('text/csv');
    expect(
      detectContentType('application/octet-stream', Buffer.from('{}'), 'x.json'),
    ).toBe('application/json');
  });
  it('treats binary/octet-stream and empty MIME as no-hint', () => {
    expect(
      detectContentType('binary/octet-stream', Buffer.from('hi'), 'page.htm'),
    ).toBe('text/html');
    expect(detectContentType('', Buffer.from('hi'), 'page.html')).toBe('text/html');
  });
  it('lets magic bytes override a misleading extension', () => {
    // A PNG renamed `.txt` must still resolve as image/png — magic wins
    // over suffix.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.alloc(4, 0),
    ]);
    expect(detectContentType(null, png, 'fake.txt')).toBe('image/png');
    expect(
      detectContentType('application/octet-stream', png, 'fake.txt'),
    ).toBe('image/png');
  });
  it('sniffs PDF and ZIP magic bytes', () => {
    expect(
      detectContentType(null, Buffer.from('%PDF-1.4'), 'doc.bin'),
    ).toBe('application/pdf');
    expect(
      detectContentType(
        null,
        Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(4, 0)]),
        'pkg.bin',
      ),
    ).toBe('application/zip');
  });
  it('rejects malformed explicit MIME and falls through', () => {
    // No `/` → not a valid type/subtype → treated as no-hint.
    expect(detectContentType('not-a-mime', Buffer.from('hi'), 'page.html')).toBe(
      'text/html',
    );
  });
  it('lower-cases and strips parameters from explicit MIME', () => {
    expect(
      detectContentType('Text/HTML; charset=utf-8', Buffer.from('hi'), 'x.bin'),
    ).toBe('text/html');
  });
});

describe('isSafeOpenExtension (shell.openPath allowlist)', () => {
  it('allows viewer-format extensions whose default handler does not execute code', () => {
    for (const name of [
      'report.html',
      'page.HTM',
      'manual.pdf',
      'log.txt',
      'verbose.log',
      'notes.md',
      'README.markdown',
      'data.json',
      'rows.csv',
      'icon.png',
      'photo.jpg',
      'photo.JPEG',
      'animation.gif',
      'banner.webp',
    ]) {
      expect(isSafeOpenExtension(name)).toBe(true);
    }
  });
  it('rejects executable / installer / script extensions', () => {
    // The whole point of the allowlist: never let the OS dispatch a
    // chat attachment to a shell, installer, or runtime.
    for (const name of [
      'evil.command',
      'malware.app',
      'setup.pkg',
      'image.dmg',
      'macro.scpt',
      'binary.exe',
      'task.bat',
      'script.ps1',
      'archive.jar',
      'tool.sh',
      'script.zsh',
      'helper.applescript',
    ]) {
      expect(isSafeOpenExtension(name)).toBe(false);
    }
  });
  it('rejects SVG (browser executes <script> when opened directly)', () => {
    expect(isSafeOpenExtension('icon.svg')).toBe(false);
  });
  it('rejects Office macro-capable formats', () => {
    for (const name of ['x.docx', 'x.xlsm', 'x.pptm', 'x.ppam']) {
      expect(isSafeOpenExtension(name)).toBe(false);
    }
  });
  it('rejects archives — let the user save and unpack manually', () => {
    expect(isSafeOpenExtension('bundle.zip')).toBe(false);
  });
  it('rejects filenames with no extension', () => {
    expect(isSafeOpenExtension('Makefile')).toBe(false);
    expect(isSafeOpenExtension('')).toBe(false);
  });
  it('rejects dotfiles (no extension by spec)', () => {
    expect(isSafeOpenExtension('.bashrc')).toBe(false);
  });
});
