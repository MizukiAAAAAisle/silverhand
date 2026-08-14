import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeOpenExtension } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { AttachmentRepo } from '../../src/repos/attachment-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
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
  const workspace = workspaces.insert({
    name: 'att-ws',
    description: null,
  });
  const agent = new AgentRepo(db).create({ name: 'a', runtime: 'claude' }, localHostId, 'local');
  workspaces.insertMembership(workspace.id, agent.id);
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    name: 'ch-1',
    workspaceId: workspace.id,
    title: 't',
  });
  conversations.addAgent(channel.id, agent.id);

  const storage = createLocalBlobFileStorage({ rootDir: join(tmp.silverhandDir, 'blobs') });
  const attachments = new AttachmentRepo(db);
  const service = new AttachmentService({
    storage,
    attachments,
    conversations,
  });
  return {
    db,
    channel,
    service,
    storage,
    attachments,
    agent,
    cleanup: tmp.cleanup,
    silverhandDir: tmp.silverhandDir,
    localHostId,
  };
}

/** Count physical blob files under a blobs root — regular files only, so the
 *  stable-alias symlinks (which live in the same tree) never inflate the count.
 *  Used by the pointer-swap failure matrix to assert "exactly one live blob" /
 *  "old blob retained" without threading storage keys through injected faults. */
function countPhysicalBlobs(root: string): number {
  let n = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue; // an alias, not a physical blob
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) n += 1;
    }
  };
  walk(root);
  return n;
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
      });
      const otherChannel = conversations.insertChannel({
        name: 'ch-2',
        workspaceId: otherWorkspace.id,
        title: 'o',
      });
      const denied = await service.locateForAgent(dto.id, otherChannel.id);
      expect(denied).toBeNull();
    } finally {
      cleanup();
    }
  });
});

const PDF_BYTES = Buffer.from('%PDF-1.4\n');
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.alloc(8, 0),
]);

describe('AttachmentService.update (creator-only pointer-swap)', () => {
  it('swaps bytes in place: id/filename/content_type stable, size + revision advance', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'mockup.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      expect(dto.content_revision).toBe(1);

      const next = Buffer.concat([PNG_BYTES, Buffer.from('more-pixels')]);
      const res = await service.update(dto.id, next, { kind: 'user', id: 'local' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Identity axis is frozen; only content-derived fields move.
      expect(res.dto.id).toBe(dto.id);
      expect(res.dto.filename).toBe('mockup.png');
      expect(res.dto.content_type).toBe('image/png');
      expect(res.dto.size).toBe(next.length);
      expect(res.dto.content_revision).toBe(2);

      // The served bytes are the new ones.
      const served = await service.serveForViewer(dto.id, () => true);
      expect(Buffer.from(await served!.arrayBuffer())).toEqual(next);
    } finally {
      cleanup();
    }
  });

  it('rejects an update whose bytes are a different magic family (type lock enforced)', async () => {
    const { service, channel, cleanup, silverhandDir } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'shot.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      const blobsRoot = join(silverhandDir, 'blobs');
      const before = countPhysicalBlobs(blobsRoot);

      // PDF bytes into an image/png slot: the lock is ENFORCED from the bytes
      // (never the caller's declared type), so this rejects rather than
      // smuggling a format the renderer would decode as PNG.
      await expect(
        service.update(dto.id, PDF_BYTES, { kind: 'user', id: 'local' }),
      ).rejects.toMatchObject({ failure: { kind: 'content_type_mismatch' } });

      // No blob written, row untouched: same revision, same (PNG) bytes.
      expect(countPhysicalBlobs(blobsRoot)).toBe(before);
      const reread = await service.serveForViewer(dto.id, () => true);
      expect(Buffer.from(await reread!.arrayBuffer())).toEqual(PNG_BYTES);
      const served = await service.serveForViewer(dto.id, () => true);
      expect(served).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('fail-closed: unrecognizable bytes into a binary (image) slot are rejected', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'shot.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      // No magic → not provably the same family → rejected, not waved through.
      await expect(
        service.update(dto.id, Buffer.from('not an image at all'), {
          kind: 'user',
          id: 'local',
        }),
      ).rejects.toMatchObject({ failure: { kind: 'content_type_mismatch' } });
    } finally {
      cleanup();
    }
  });

  it('treats zip containers as one family: docx bytes update a docx row', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      const zip = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.alloc(8, 0),
      ]);
      const docxType =
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'spec.docx',
        contentType: docxType,
        buffer: zip,
        createdByKind: 'user',
        createdById: 'local',
      });
      expect(dto.content_type).toBe(docxType);
      // Fresh zip-magic bytes are the same family → allowed, type stays docx.
      const next = Buffer.concat([zip, Buffer.from('revised-doc')]);
      const res = await service.update(dto.id, next, { kind: 'user', id: 'local' });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.dto.content_type).toBe(docxType);
    } finally {
      cleanup();
    }
  });

  it('allows a text→text update (a text slot has no magic to lock)', async () => {
    const { service, channel, cleanup } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'notes.txt',
        contentType: 'text/plain',
        buffer: Buffer.from('first draft'),
        createdByKind: 'user',
        createdById: 'local',
      });
      const res = await service.update(dto.id, Buffer.from('second draft, longer'), {
        kind: 'user',
        id: 'local',
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.dto.content_type).toBe('text/plain');
    } finally {
      cleanup();
    }
  });

  it('GCs the old physical blob and leaves exactly one live blob', async () => {
    const { service, channel, cleanup, db, silverhandDir } = bootstrap();
    try {
      const repo = new AttachmentRepo(db);
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      const oldKey = repo.getById(dto.id)!.storage_key;
      const oldPath = join(silverhandDir, 'blobs', oldKey);
      expect(existsSync(oldPath)).toBe(true);

      const res = await service.update(
        dto.id,
        Buffer.concat([PNG_BYTES, Buffer.from('brand-new-bytes')]),
        { kind: 'user', id: 'local' },
      );
      expect(res.ok).toBe(true);
      const newKey = repo.getById(dto.id)!.storage_key;
      const newPath = join(silverhandDir, 'blobs', newKey);

      expect(newKey).not.toBe(oldKey); // fresh blob key (pointer-swap)
      expect(existsSync(newPath)).toBe(true);
      expect(existsSync(oldPath)).toBe(false); // old bytes GC'd, no accumulation
    } finally {
      cleanup();
    }
  });

  it('eager-relinks the alias in place: same path yields new bytes with NO re-locate', async () => {
    const { service, channel, agent, cleanup } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'iter.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'agent',
        createdById: agent.id,
      });
      const before = await service.locateForAgent(dto.id, channel.id);
      expect(before!.locate.storage).toBe('local');
      const aliasPath =
        before!.locate.storage === 'local' ? before!.locate.local_path : '';

      const next = Buffer.concat([PNG_BYTES, Buffer.from('the-next-revision')]);
      const res = await service.update(dto.id, next, { kind: 'agent', id: agent.id });
      expect(res.ok).toBe(true);

      // Read the SAME alias path captured before the update, WITHOUT a second
      // locate — so a broken eager relink can't be masked by locate's own
      // self-heal. The alias must already resolve (through the symlink) to the
      // new bytes: proves the reviewer's held path both stays fixed and reflects
      // the update the instant it lands.
      expect(readFileSync(aliasPath)).toEqual(next);
    } finally {
      cleanup();
    }
  });

  it('allows updating an attachment already referenced by a message (in_use), unlike delete', async () => {
    const { service, channel, cleanup, db } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'sent.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      // Reference it from a persisted message so it counts as in_use.
      new MessageRepo(db).insertForConversation({
        conversationId: channel.id,
        fromKind: 'user',
        fromUserId: 'local',
        content: 'here',
        attachments: [
          { id: dto.id, filename: 'sent.png', size: PNG_BYTES.length, content_type: 'image/png' },
        ],
      });

      // delete rejects an in-use attachment…
      const del = await service.deleteOrphan(dto.id, { kind: 'user', userId: 'local' });
      expect(del).toEqual({ ok: false, error: 'in_use' });
      // …but update accepts it — updating referenced bytes is the feature.
      const upd = await service.update(
        dto.id,
        Buffer.concat([PNG_BYTES, Buffer.from('revised')]),
        {
          kind: 'user',
          id: 'local',
        },
      );
      expect(upd.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('rejects a non-creator with forbidden and does not touch the bytes', async () => {
    const { service, channel, agent, cleanup } = bootstrap();
    try {
      // Agent-uploaded: a user (or a different agent) is not the creator.
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'owned.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'agent',
        createdById: agent.id,
      });
      const byUser = await service.update(dto.id, Buffer.from('x'), {
        kind: 'user',
        id: 'local',
      });
      expect(byUser).toEqual({ ok: false, error: 'forbidden' });
      const byOtherAgent = await service.update(dto.id, Buffer.from('x'), {
        kind: 'agent',
        id: 'some-other-agent',
      });
      expect(byOtherAgent).toEqual({ ok: false, error: 'forbidden' });

      // Bytes untouched.
      const served = await service.serveForViewer(dto.id, () => true);
      expect(Buffer.from(await served!.arrayBuffer())).toEqual(PNG_BYTES);
    } finally {
      cleanup();
    }
  });

  it('returns not_found for a missing id', async () => {
    const { service, cleanup } = bootstrap();
    try {
      const res = await service.update('missing', Buffer.from('x'), {
        kind: 'user',
        id: 'local',
      });
      expect(res).toEqual({ ok: false, error: 'not_found' });
    } finally {
      cleanup();
    }
  });

  it('folds a cross-channel agent update into not_found (no existence leak)', async () => {
    const { service, channel, agent, cleanup, db, localHostId } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'agent',
        createdById: agent.id,
      });
      const otherWorkspace = new WorkspaceRepo(db).insert({
        name: 'other',
        description: null,
      });
      const otherChannel = new ConversationRepo(db).insertChannel({
        name: 'ch-3',
        workspaceId: otherWorkspace.id,
        title: 'o',
      });
      // Creator matches, but the caller's channel is a different one → the
      // channel guard folds to not_found BEFORE the creator check can 403.
      const res = await service.update(
        dto.id,
        Buffer.from('x'),
        { kind: 'agent', id: agent.id },
        { requireCallerChannelOf: otherChannel.id },
      );
      expect(res).toEqual({ ok: false, error: 'not_found' });
    } finally {
      cleanup();
    }
  });

  it('rejects empty and oversize buffers with AttachmentRejection', async () => {
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
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'x.png',
        contentType: 'image/png',
        buffer: Buffer.from('abc'),
        createdByKind: 'user',
        createdById: 'local',
      });
      await expect(
        service.update(dto.id, Buffer.alloc(0), { kind: 'user', id: 'local' }),
      ).rejects.toBeInstanceOf(AttachmentRejection);
      await expect(
        service.update(dto.id, Buffer.alloc(16), { kind: 'user', id: 'local' }),
      ).rejects.toMatchObject({ failure: { kind: 'too_large' } });
      tmp.cleanup();
    } finally {
      cleanup();
    }
  });

  // ── pointer-swap failure matrix ────────────────────────────────────────────
  // The DB repoint is the sole visibility switch; everything around it is
  // best-effort. These prove: a failed switch never durably takes effect and
  // never leaks the pre-switch blob, and a failed post-switch sweep degrades to
  // a readable-stale alias / one leaked blob (surfaced, not corrupt).

  it('repoint throw: rethrows, row + old bytes unchanged, new blob cleaned', async () => {
    const { service, channel, cleanup, attachments, silverhandDir } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      const blobsRoot = join(silverhandDir, 'blobs');
      const boom = new Error('repoint boom');
      attachments.repointContent = () => {
        throw boom;
      };
      await expect(
        service.update(dto.id, Buffer.concat([PNG_BYTES, Buffer.from('x')]), {
          kind: 'user',
          id: 'local',
        }),
      ).rejects.toBe(boom);
      // New blob was written then cleaned on the throw → exactly the old one.
      expect(countPhysicalBlobs(blobsRoot)).toBe(1);
      const served = await service.serveForViewer(dto.id, () => true);
      expect(Buffer.from(await served!.arrayBuffer())).toEqual(PNG_BYTES);
    } finally {
      cleanup();
    }
  });

  it('repoint null (row vanished): not_found, new blob cleaned', async () => {
    const { service, channel, cleanup, attachments, silverhandDir } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      const blobsRoot = join(silverhandDir, 'blobs');
      attachments.repointContent = () => null; // concurrent delete between read + repoint
      const res = await service.update(
        dto.id,
        Buffer.concat([PNG_BYTES, Buffer.from('x')]),
        { kind: 'user', id: 'local' },
      );
      expect(res).toEqual({ ok: false, error: 'not_found' });
      expect(countPhysicalBlobs(blobsRoot)).toBe(1); // orphan cleaned
    } finally {
      cleanup();
    }
  });

  it('relink fail: DB on new bytes, OLD blob RETAINED, maintenance flags the miss', async () => {
    const { service, channel, cleanup, storage, silverhandDir } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      const blobsRoot = join(silverhandDir, 'blobs');
      const relinkErr = new Error('relink boom');
      storage.materializeAlias = async () => {
        throw relinkErr;
      };
      const next = Buffer.concat([PNG_BYTES, Buffer.from('new')]);
      const res = await service.update(dto.id, next, { kind: 'user', id: 'local' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Authoritative switch landed…
      expect(res.dto.content_revision).toBe(2);
      const served = await service.serveForViewer(dto.id, () => true);
      expect(Buffer.from(await served!.arrayBuffer())).toEqual(next);
      // …GC was SKIPPED so the alias stays readable-stale, not dangling.
      expect(res.maintenance.aliasRelinked).toBe(false);
      expect(res.maintenance.oldBlobDeleted).toBe(false);
      expect(res.maintenance.error).toBe(relinkErr);
      expect(countPhysicalBlobs(blobsRoot)).toBe(2); // old retained + new
    } finally {
      cleanup();
    }
  });

  it('relink returns null: fail-closed like a throw — old blob RETAINED, no dangle', async () => {
    const { service, channel, cleanup, storage, silverhandDir } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      const blobsRoot = join(silverhandDir, 'blobs');
      // `materializeAlias`'s contract is `{localPath} | null`; null means the
      // bytes are absent / no local alias. It must NOT be read as "confirmed on
      // the new bytes" — otherwise the GC below would delete the last readable
      // copy behind the still-old alias.
      storage.materializeAlias = async () => null;
      const next = Buffer.concat([PNG_BYTES, Buffer.from('new')]);
      const res = await service.update(dto.id, next, { kind: 'user', id: 'local' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Authoritative switch landed…
      expect(res.dto.content_revision).toBe(2);
      const served = await service.serveForViewer(dto.id, () => true);
      expect(Buffer.from(await served!.arrayBuffer())).toEqual(next);
      // …but the relink is NOT confirmed, so GC is skipped: old blob retained.
      expect(res.maintenance.aliasRelinked).toBe(false);
      expect(res.maintenance.oldBlobDeleted).toBe(false);
      expect(countPhysicalBlobs(blobsRoot)).toBe(2); // old retained (not dangled)
    } finally {
      cleanup();
    }
  });

  it('GC fail: DB + alias on new bytes, old-blob leak surfaced in maintenance', async () => {
    const { service, channel, cleanup, storage, silverhandDir } = bootstrap();
    try {
      const dto = await service.upload({
        sourceConversationId: channel.id,
        filename: 'a.png',
        contentType: 'image/png',
        buffer: PNG_BYTES,
        createdByKind: 'user',
        createdById: 'local',
      });
      const blobsRoot = join(silverhandDir, 'blobs');
      const gcErr = new Error('gc boom');
      storage.delete = async () => {
        throw gcErr;
      };
      const next = Buffer.concat([PNG_BYTES, Buffer.from('new')]);
      const res = await service.update(dto.id, next, { kind: 'user', id: 'local' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Relink succeeded, only the old-blob GC failed → surfaced, never swallowed.
      expect(res.maintenance.aliasRelinked).toBe(true);
      expect(res.maintenance.oldBlobDeleted).toBe(false);
      expect(res.maintenance.error).toBe(gcErr);
      const served = await service.serveForViewer(dto.id, () => true);
      expect(Buffer.from(await served!.arrayBuffer())).toEqual(next);
      expect(countPhysicalBlobs(blobsRoot)).toBe(2); // old blob leaked (attributable)
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
      });
      const otherChannel = new ConversationRepo(db).insertChannel({
        name: 'ch-4',
        workspaceId: otherWorkspace.id,
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
