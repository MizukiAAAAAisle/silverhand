import { describe, expect, it, vi } from 'vitest';
import {
  handleAttachmentSave,
  sanitizeAttachmentFilename,
  type AttachmentSaveDeps,
} from '../attachment-save';

function makeDeps(overrides: Partial<AttachmentSaveDeps> = {}): {
  deps: AttachmentSaveDeps;
  showSaveDialog: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
} {
  const showSaveDialog = vi.fn(async () => ({ canceled: true } as const));
  const writeFile = vi.fn(async () => {});
  const deps: AttachmentSaveDeps = {
    showSaveDialog: overrides.showSaveDialog ?? showSaveDialog,
    writeFile: overrides.writeFile ?? writeFile,
  };
  return { deps, showSaveDialog, writeFile };
}

describe('sanitizeAttachmentFilename', () => {
  it('preserves ordinary filenames verbatim (extension + case)', () => {
    expect(sanitizeAttachmentFilename('Report Q3.PDF')).toBe('Report Q3.PDF');
    expect(sanitizeAttachmentFilename('日志-2026.log')).toBe('日志-2026.log');
  });

  it('replaces path separators with underscores so the pre-fill is a bare name', () => {
    expect(sanitizeAttachmentFilename('foo/bar.txt')).toBe('foo_bar.txt');
    expect(sanitizeAttachmentFilename('a\\b\\c.zip')).toBe('a_b_c.zip');
  });

  it('strips control characters', () => {
    expect(sanitizeAttachmentFilename('a\x00b\x1fc.txt')).toBe('abc.txt');
  });

  it('caps at 255 chars', () => {
    const long = 'x'.repeat(400) + '.log';
    expect(sanitizeAttachmentFilename(long).length).toBe(255);
  });

  it('returns empty string when input is only unsafe/blank chars — caller must fail closed', () => {
    expect(sanitizeAttachmentFilename('   ')).toBe('');
    expect(sanitizeAttachmentFilename('\x00\x01\x02')).toBe('');
  });
});

describe('handleAttachmentSave — input validation', () => {
  it('rejects missing filename before opening the dialog', async () => {
    const { deps, showSaveDialog } = makeDeps();
    const result = await handleAttachmentSave(
      { bytes: new Uint8Array([1, 2, 3]) },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_filename' });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('rejects non-Uint8Array/Buffer payload', async () => {
    const { deps, showSaveDialog } = makeDeps();
    const result = await handleAttachmentSave(
      { filename: 'x.txt', bytes: 'not bytes' as unknown as Uint8Array },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('rejects empty payload', async () => {
    const { deps, showSaveDialog } = makeDeps();
    const result = await handleAttachmentSave(
      { filename: 'x.txt', bytes: new Uint8Array(0) },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'empty_payload' });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('rejects filename that sanitizes to empty', async () => {
    const { deps, showSaveDialog } = makeDeps();
    const result = await handleAttachmentSave(
      { filename: '   \x00\x01', bytes: new Uint8Array([1]) },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_filename' });
    expect(showSaveDialog).not.toHaveBeenCalled();
  });
});

describe('handleAttachmentSave — dialog flow', () => {
  it('cancel branch: no write, returns { canceled: true } (caller treats as silent)', async () => {
    const showSaveDialog = vi.fn(async () => ({ canceled: true } as const));
    const writeFile = vi.fn(async () => {});
    const result = await handleAttachmentSave(
      { filename: 'a.log', bytes: new Uint8Array([1, 2]) },
      { showSaveDialog, writeFile },
    );
    expect(result).toEqual({ ok: false, canceled: true });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('dialog returns no filePath (edge case: canceled=false but no path): still cancel', async () => {
    const showSaveDialog = vi.fn(async () => ({ canceled: false }));
    const writeFile = vi.fn(async () => {});
    const result = await handleAttachmentSave(
      { filename: 'a.log', bytes: new Uint8Array([1, 2]) },
      { showSaveDialog, writeFile },
    );
    expect(result).toEqual({ ok: false, canceled: true });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('pre-fills the sanitized filename as defaultPath — original name preserved', async () => {
    const showSaveDialog = vi.fn(async () => ({ canceled: true } as const));
    await handleAttachmentSave(
      { filename: 'quarterly report.pdf', bytes: new Uint8Array([1]) },
      { showSaveDialog, writeFile: async () => {} },
    );
    expect(showSaveDialog).toHaveBeenCalledWith({
      title: 'Save attachment',
      defaultPath: 'quarterly report.pdf',
    });
  });

  it('writes the user-selected path (not the pre-fill) on success', async () => {
    // Falsifier: an implementation that wrote to `defaultPath` instead
    // of the dialog's returned `filePath` would silently ignore where
    // the user chose to save.
    const showSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: '/Users/x/Desktop/renamed.pdf',
    }));
    const writeFile = vi.fn(async () => {});
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await handleAttachmentSave(
      { filename: 'quarterly report.pdf', bytes },
      { showSaveDialog, writeFile },
    );
    expect(result).toEqual({
      ok: true,
      path: '/Users/x/Desktop/renamed.pdf',
    });
    expect(writeFile).toHaveBeenCalledWith(
      '/Users/x/Desktop/renamed.pdf',
      Buffer.from(bytes),
    );
  });

  it('write failure surfaces as { ok: false, reason: "write_failed:..." }', async () => {
    const showSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: '/protected/path.pdf',
    }));
    const writeFile = vi.fn(async () => {
      throw new Error('EACCES: permission denied');
    });
    const result = await handleAttachmentSave(
      { filename: 'x.pdf', bytes: new Uint8Array([1]) },
      { showSaveDialog, writeFile },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'write_failed:EACCES: permission denied',
    });
  });
});
