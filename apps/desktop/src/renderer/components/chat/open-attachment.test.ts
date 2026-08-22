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
    expect(d.open).toHaveBeenCalledWith({ attachmentId: 'a1', filename: 'x.pdf', bytes: BYTES });
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
      describeOpenFailure('unsafe_extension'),
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

    expect(inline).toHaveBeenCalledWith(describeOpenFailure('open_failed: foo'));
    expect(d.toastError).not.toHaveBeenCalled();
  });

  it('translates a fetch exception into the formatted open-exception message', async () => {
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

    expect(d.toastError).toHaveBeenCalledWith(
      formatOpenException(new Error('network down')),
    );
    expect(d.open).not.toHaveBeenCalled();
  });
});

describe('describeOpenFailure', () => {
  it('groups canonical reasons into stable buckets (refusal / open-failure / invalid-payload)', () => {
    // The safety refusal is its own non-empty message.
    expect(describeOpenFailure('unsafe_extension').length).toBeGreaterThan(0);
    // `open_failed` groups regardless of any trailing detail.
    expect(describeOpenFailure('open_failed: EPERM')).toBe(
      describeOpenFailure('open_failed'),
    );
    // Both payload reasons share one message.
    expect(describeOpenFailure('invalid_payload')).toBe(
      describeOpenFailure('empty_payload'),
    );
    // The three buckets are mutually distinct.
    const buckets = new Set([
      describeOpenFailure('unsafe_extension'),
      describeOpenFailure('open_failed'),
      describeOpenFailure('empty_payload'),
    ]);
    expect(buckets.size).toBe(3);
  });

  it('echoes an unknown reason verbatim as a last resort', () => {
    expect(describeOpenFailure('mystery_reason')).toBe('mystery_reason');
  });
});

describe('formatOpenException', () => {
  it('surfaces an Error message in the wrapped output', () => {
    expect(formatOpenException(new Error('network down'))).toContain(
      'network down',
    );
  });

  it('coerces a non-Error thrown value into the message', () => {
    expect(formatOpenException('boom')).toContain('boom');
    expect(formatOpenException(42)).toContain('42');
  });
});
