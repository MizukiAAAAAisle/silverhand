import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeOpenFailure,
  formatOpenException,
  openAttachmentExternally,
  type OpenAttachmentDeps,
} from './open-attachment';

const BYTES = new Uint8Array([1, 2, 3]);

function deps(overrides: Partial<OpenAttachmentDeps> = {}): OpenAttachmentDeps {
  return {
    fetchBytes: vi.fn(async () => ({ bytes: BYTES })),
    open: vi.fn(async () => ({ ok: true as const })),
    toastError: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openAttachmentExternally', () => {
  it('fetches bytes and hands them to the open IPC on the happy path — no error surface', async () => {
    const d = deps();

    await openAttachmentExternally(
      { id: 'a1', filename: 'x.pdf' },
      {},
      d,
    );

    expect(d.fetchBytes).toHaveBeenCalledWith('a1');
    expect(d.open).toHaveBeenCalledWith({ filename: 'x.pdf', bytes: BYTES });
    expect(d.toastError).not.toHaveBeenCalled();
  });

  it('surfaces `unsafe_extension` via toast when no inline slot is provided', async () => {
    const d = deps({
      open: vi.fn(async () => ({ ok: false as const, reason: 'unsafe_extension' })),
    });

    await openAttachmentExternally(
      { id: 'a1', filename: 'x.command' },
      {},
      d,
    );

    expect(d.toastError).toHaveBeenCalledWith(
      '该类型的文件不能直接在应用内打开（出于安全考虑）。',
    );
  });

  it('routes failures through `onInlineError` when provided (no toast)', async () => {
    const inline = vi.fn();
    const d = deps({
      open: vi.fn(async () => ({ ok: false as const, reason: 'open_failed: foo' })),
    });

    await openAttachmentExternally(
      { id: 'a1', filename: 'x.pdf' },
      { onInlineError: inline },
      d,
    );

    expect(inline).toHaveBeenCalledWith('系统未能打开此文件。');
    expect(d.toastError).not.toHaveBeenCalled();
  });

  it('translates a fetch exception into a user-facing "打开失败：<msg>"', async () => {
    const d = deps({
      fetchBytes: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    await openAttachmentExternally(
      { id: 'a1', filename: 'x.pdf' },
      {},
      d,
    );

    expect(d.toastError).toHaveBeenCalledWith('打开失败：network down');
    expect(d.open).not.toHaveBeenCalled();
  });
});

describe('describeOpenFailure', () => {
  it('maps every canonical reason to a short Chinese message', () => {
    expect(describeOpenFailure('unsafe_extension')).toBe(
      '该类型的文件不能直接在应用内打开（出于安全考虑）。',
    );
    expect(describeOpenFailure('open_failed')).toBe('系统未能打开此文件。');
    expect(describeOpenFailure('open_failed: EPERM')).toBe('系统未能打开此文件。');
    expect(describeOpenFailure('empty_payload')).toBe('附件数据无效。');
    expect(describeOpenFailure('invalid_payload')).toBe('附件数据无效。');
  });

  it('echoes an unknown reason verbatim as a last resort', () => {
    expect(describeOpenFailure('mystery_reason')).toBe('mystery_reason');
  });
});

describe('formatOpenException', () => {
  it('wraps an Error message with the "打开失败：" prefix', () => {
    expect(formatOpenException(new Error('network down'))).toBe(
      '打开失败：network down',
    );
  });

  it('coerces a non-Error thrown value into a string', () => {
    expect(formatOpenException('boom')).toBe('打开失败：boom');
    expect(formatOpenException(42)).toBe('打开失败：42');
  });
});
