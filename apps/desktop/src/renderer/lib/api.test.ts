import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiUpload } from './api';

const agentHub = {
  getBackendInfo: vi.fn(),
  backendRequest: vi.fn(),
  backendUpload: vi.fn(),
};

describe('renderer API proxy', () => {
  beforeEach(() => {
    agentHub.getBackendInfo.mockReset();
    agentHub.backendRequest.mockReset();
    agentHub.backendUpload.mockReset();
    vi.stubGlobal('window', { agentHub });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends ordinary API calls through the main-process proxy', async () => {
    agentHub.backendRequest.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ ok: true }),
    });

    await expect(
      api('/api/example', {
        method: 'POST',
        body: JSON.stringify({ a: 1 }),
      }),
    ).resolves.toEqual({ ok: true });

    expect(agentHub.backendRequest).toHaveBeenCalledWith({
      path: '/api/example',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ a: 1 }),
    });
    expect(agentHub.getBackendInfo).not.toHaveBeenCalled();
  });

  it('surfaces proxy failures as ApiError without retrying legacy auth', async () => {
    agentHub.backendRequest.mockResolvedValueOnce({
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ error: 'unauthorized' }),
    });

    await expect(api('/api/example')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
      body: JSON.stringify({ error: 'unauthorized' }),
    } satisfies Partial<ApiError>);

    expect(agentHub.backendRequest).toHaveBeenCalledTimes(1);
  });

  it('serializes multipart uploads for the main-process proxy', async () => {
    const form = new FormData();
    form.set('title', 'draft');
    form.set(
      'file',
      new File([new Uint8Array([1, 2, 3])], 'draft.txt', {
        type: 'text/plain',
      }),
    );
    agentHub.backendUpload.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ id: 'att-1' }),
    });

    await expect(apiUpload('/api/upload', form)).resolves.toEqual({
      id: 'att-1',
    });

    expect(agentHub.backendUpload).toHaveBeenCalledTimes(1);
    const input = agentHub.backendUpload.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      path: '/api/upload',
      fields: [{ name: 'title', value: 'draft' }],
      files: [
        {
          fieldName: 'file',
          filename: 'draft.txt',
          contentType: 'text/plain',
        },
      ],
    });
    expect(Array.from(input.files[0].bytes)).toEqual([1, 2, 3]);
  });
});

describe('ApiError — D4.a Commit 5d-fixup (Cindy P1-2): backend_unreachable kind', () => {
  beforeEach(() => {
    agentHub.getBackendInfo.mockReset();
    agentHub.backendRequest.mockReset();
    agentHub.backendUpload.mockReset();
    vi.stubGlobal('window', { agentHub });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('default kind for ordinary HTTP errors is "http" (regression bait)', async () => {
    agentHub.backendRequest.mockResolvedValueOnce({
      status: 404,
      statusText: 'Not Found',
      headers: {},
      bodyText: '{}',
    });
    let caught: unknown;
    try {
      await api('/api/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe('http');
    expect((caught as ApiError).status).toBe(404);
  });

  it('status: 0 from main-process proxy (network failure) → ApiError.kind = "backend_unreachable"', async () => {
    // Cindy 5d-fixup tighter constraint: `status: 0` MUST NOT fall
    // through as a generic HTTP error. The renderer's gate logic
    // branches on `err.kind === "backend_unreachable"`, so this
    // is the load-bearing pin for that contract. A regression that
    // dropped the special case in `assertOk` would surface as the
    // kind defaulting to `'http'` and the gate failing to render.
    agentHub.backendRequest.mockResolvedValueOnce({
      status: 0,
      statusText: 'Network Error',
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        error: 'backend_unreachable',
        message: 'fetch failed',
      }),
    });
    let caught: unknown;
    try {
      await api('/api/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe('backend_unreachable');
    expect((caught as ApiError).status).toBe(0);
    expect((caught as ApiError).statusText).toBe('Network Error');
    // Body is preserved verbatim — callers that want to render the
    // underlying error message can JSON.parse it.
    expect((caught as ApiError).body).toContain('backend_unreachable');
    expect((caught as ApiError).body).toContain('fetch failed');
  });

  it('status: 0 with empty statusText still surfaces as backend_unreachable (renderer copy fallback)', async () => {
    // Pin: even when the proxy doesn't supply statusText, the kind
    // discriminator survives. Renderer copy can still display
    // "Network Error" via a fallback constant.
    agentHub.backendRequest.mockResolvedValueOnce({
      status: 0,
      statusText: '',
      headers: {},
      bodyText: '',
    });
    let caught: unknown;
    try {
      await api('/api/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe('backend_unreachable');
    expect((caught as ApiError).status).toBe(0);
    // Constructor falls back to "Network Error" when statusText is
    // empty so the renderer always has something to show.
    expect((caught as ApiError).statusText).toBe('Network Error');
  });

  it('apiUpload also tags status: 0 as backend_unreachable (symmetric handling)', async () => {
    agentHub.backendUpload.mockResolvedValueOnce({
      status: 0,
      statusText: 'Network Error',
      headers: {},
      bodyText: JSON.stringify({
        error: 'backend_unreachable',
        message: 'connect ECONNREFUSED',
      }),
    });
    const form = new FormData();
    form.set('field', 'value');
    let caught: unknown;
    try {
      await apiUpload('/api/upload', form);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe('backend_unreachable');
    expect((caught as ApiError).status).toBe(0);
  });

  it('ApiError constructor accepts explicit kind argument (forward-compat for callers)', async () => {
    // Direct construction — used by `authResultToUser` in
    // features/me/hooks.ts to forward a `result.status === 0`
    // signup/login result through the same typed channel.
    const err = new ApiError(0, 'Network Error', '{}', 'backend_unreachable');
    expect(err.kind).toBe('backend_unreachable');
    expect(err.message).toContain('Network Error');
  });
});
