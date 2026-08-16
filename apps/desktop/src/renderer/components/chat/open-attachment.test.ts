import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import {
  describeOpenFailure,
  formatOpenException,
  openAttachmentExternally,
  openAuditAttachmentExternally,
  type OpenAttachmentCoreDeps,
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

describe('openAuditAttachmentExternally — owner-audit bytes → safe IPC, no blob URL', () => {
  const silverhand = {
    getBackendInfo: vi.fn(),
    backendRequest: vi.fn(),
    backendUpload: vi.fn(),
  };
  const windowOpen = vi.fn();

  function coreDeps(
    overrides: Partial<OpenAttachmentCoreDeps> = {},
  ): OpenAttachmentCoreDeps {
    return {
      open: vi.fn(async () => ({ ok: true as const })),
      toastError: vi.fn(),
      ...overrides,
    };
  }

  const TARGET = {
    agentId: 'ag_1',
    conversationId: 'cv_2',
    attachmentId: 'at_3',
    filename: 'audit.pdf',
  };
  const AUDIT_PATH = apiPaths.agentChatAttachment('ag_1', 'cv_2', 'at_3');

  function mockBytesOnce(bytes: number[]): void {
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/pdf' },
      bodyBytes: new Uint8Array(bytes),
    });
  }

  beforeEach(() => {
    silverhand.backendRequest.mockReset();
    windowOpen.mockReset();
    vi.stubGlobal('window', { silverhand, open: windowOpen });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the dedicated audit path and hands raw bytes + DTO filename to the open IPC', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    mockBytesOnce([5, 6, 7]);
    const d = coreDeps();

    await openAuditAttachmentExternally(TARGET, {}, d);

    // Exact owner-audit face — NOT the membership-scoped /api/attachments/:id.
    expect(silverhand.backendRequest).toHaveBeenCalledWith({
      path: AUDIT_PATH,
      responseType: 'arrayBuffer',
    });
    expect(AUDIT_PATH).not.toContain('/api/attachments/');
    // Raw bytes + the server/DTO filename reach the safe main-process boundary.
    const openArg = (d.open as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(openArg.filename).toBe('audit.pdf');
    expect(Array.from(openArg.bytes as Uint8Array)).toEqual([5, 6, 7]);
    // The dead/leaky path is gone: zero object URL, zero window.open.
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
    expect(d.toastError).not.toHaveBeenCalled();
  });

  it('routes an OS-open refusal through the inline surface (no toast, no window.open)', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    mockBytesOnce([1]);
    const inline = vi.fn();
    const d = coreDeps({
      open: vi.fn(async () => ({ ok: false as const, reason: 'unsafe_extension' })),
    });

    await openAuditAttachmentExternally(TARGET, { onInlineError: inline }, d);

    expect(inline).toHaveBeenCalledWith(describeOpenFailure('unsafe_extension'));
    expect(d.toastError).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('surfaces a transport failure (403) inline and never reaches the open IPC', async () => {
    silverhand.backendRequest.mockResolvedValueOnce({
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      bodyText: '{"error":"forbidden"}',
    });
    const inline = vi.fn();
    const d = coreDeps();

    await openAuditAttachmentExternally(TARGET, { onInlineError: inline }, d);

    expect(d.open).not.toHaveBeenCalled();
    expect(inline).toHaveBeenCalledTimes(1);
    expect(windowOpen).not.toHaveBeenCalled();
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
