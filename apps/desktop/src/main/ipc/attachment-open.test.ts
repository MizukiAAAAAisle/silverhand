import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  materializeAndOpenAttachment,
  resolveAttachmentScratchTarget,
  type AttachmentOpenIo,
} from './attachment-open';

const SCRATCH = join(tmpdir(), 'silverhand-attachments');

describe('resolveAttachmentScratchTarget', () => {
  it('maps a valid attachment id + safe filename to one stable per-id path', () => {
    const r = resolveAttachmentScratchTarget('AbC-1_2xyz09', 'mockup.html');
    expect(r).toEqual({
      ok: true,
      target: {
        dir: join(SCRATCH, 'AbC-1_2xyz09'),
        fullPath: join(SCRATCH, 'AbC-1_2xyz09', 'mockup.html'),
      },
    });
  });

  it('fails closed on an id with out-of-alphabet chars instead of stripping them (no collision)', () => {
    // A lossy `replace(/[^A-Za-z0-9_-]/g,'')` would fold `a/b` onto `ab` and
    // let one attachment overwrite another's scratch file. Whole-string match
    // rejects it, so the only survivors resolve to distinct paths.
    expect(resolveAttachmentScratchTarget('a/b', 'x.pdf')).toEqual({
      ok: false,
      reason: 'invalid_attachment_id',
    });
    expect(resolveAttachmentScratchTarget('a.b', 'x.pdf').ok).toBe(false);
    expect(resolveAttachmentScratchTarget('../evil', 'x.pdf')).toEqual({
      ok: false,
      reason: 'invalid_attachment_id',
    });
    const ab = resolveAttachmentScratchTarget('ab', 'x.pdf');
    expect(ab.ok).toBe(true);
  });

  it('rejects an empty id and an empty / control-only filename', () => {
    expect(resolveAttachmentScratchTarget('', 'x.pdf').ok).toBe(false);
    expect(resolveAttachmentScratchTarget('abc', '').ok).toBe(false);
    expect(resolveAttachmentScratchTarget('abc', '')).toEqual({
      ok: false,
      reason: 'invalid_filename',
    });
  });

  it('refuses an extension Launch Services would execute rather than view', () => {
    expect(resolveAttachmentScratchTarget('abc', 'run.command')).toEqual({
      ok: false,
      reason: 'unsafe_extension',
    });
  });
});

interface RecordingIo extends AttachmentOpenIo {
  dirs: string[];
  writes: Array<{ path: string; bytes: Buffer }>;
  opened: string[];
}

function recordingIo(openErr = ''): RecordingIo {
  const io: RecordingIo = {
    dirs: [],
    writes: [],
    opened: [],
    ensureDir: dir => {
      io.dirs.push(dir);
    },
    writeFile: (path, bytes) => {
      io.writes.push({ path, bytes });
    },
    openPath: async path => {
      io.opened.push(path);
      return openErr;
    },
  };
  return io;
}

describe('materializeAndOpenAttachment', () => {
  it('reuses one path across repeated opens and overwrites with the latest bytes', async () => {
    const io = recordingIo();
    const first = Buffer.from([1, 1, 1]);
    const second = Buffer.from([2, 2, 2, 2]);

    const r1 = await materializeAndOpenAttachment(
      { attachmentId: 'stable-id', filename: 'm.html', bytes: first },
      io,
    );
    const r2 = await materializeAndOpenAttachment(
      { attachmentId: 'stable-id', filename: 'm.html', bytes: second },
      io,
    );

    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    const path = join(SCRATCH, 'stable-id', 'm.html');
    // Same file both times — no fresh random temp per open.
    expect(io.writes.map(w => w.path)).toEqual([path, path]);
    expect(io.opened).toEqual([path, path]);
    // The second write carries the updated bytes.
    expect(io.writes[1]?.bytes).toBe(second);
  });

  it('never touches disk for an invalid id (covers the strip-collision reject)', async () => {
    const io = recordingIo();
    const r = await materializeAndOpenAttachment(
      { attachmentId: 'a/b', filename: 'x.pdf', bytes: Buffer.from([1]) },
      io,
    );
    expect(r).toEqual({ ok: false, reason: 'invalid_attachment_id' });
    expect(io.dirs).toEqual([]);
    expect(io.writes).toEqual([]);
    expect(io.opened).toEqual([]);
  });

  it('rejects empty bytes without writing or opening', async () => {
    const io = recordingIo();
    const r = await materializeAndOpenAttachment(
      { attachmentId: 'abc', filename: 'x.pdf', bytes: Buffer.alloc(0) },
      io,
    );
    expect(r).toEqual({ ok: false, reason: 'empty_payload' });
    expect(io.writes).toEqual([]);
    expect(io.opened).toEqual([]);
  });

  it('surfaces an OS open failure after writing', async () => {
    const io = recordingIo('LSNoHandler');
    const r = await materializeAndOpenAttachment(
      { attachmentId: 'abc', filename: 'x.pdf', bytes: Buffer.from([1]) },
      io,
    );
    expect(r).toEqual({ ok: false, reason: 'open_failed:LSNoHandler' });
    expect(io.writes).toHaveLength(1);
  });
});
