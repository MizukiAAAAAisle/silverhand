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
