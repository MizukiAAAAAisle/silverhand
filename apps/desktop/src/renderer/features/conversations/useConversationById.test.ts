import { describe, expect, it } from 'vitest';
import type { ConversationRef } from '@silverhand/shared';
import { ApiError } from '@/lib/api';
import { mapConversationByIdResult } from './useConversationById';

const baseRef: ConversationRef = {
  id: 'conv-1',
  kind: 'channel',
  title: 'planning',
  workspace_id: 'ws-a',
  workspace_kind: 'regular',
  workspace_path: '/tmp/ws-a',
  parent_channel_id: null,
  parent_title: null,
  closed_at: null,
  archived_at: null,
};

describe('mapConversationByIdResult', () => {
  it('returns loading when id is null', () => {
    const r = mapConversationByIdResult(null, {
      data: undefined,
      error: null as unknown as Error,
      isError: false,
    });
    expect(r).toEqual({ status: 'loading', ref: null });
  });

  it('returns loading when id is set but fetch is pending (no data, no error)', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: null as unknown as Error,
      isError: false,
    });
    expect(r).toEqual({ status: 'loading', ref: null });
  });

  it('returns resolved with the ref payload on success', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: { ref: baseRef },
      error: null as unknown as Error,
      isError: false,
    });
    expect(r.status).toBe('resolved');
    expect(r.ref).toEqual(baseRef);
  });

  it('returns not_found on 404 ApiError', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: new ApiError(404, 'Not Found', '{"error":"conversation not found"}'),
      isError: true,
    });
    expect(r).toEqual({ status: 'not_found', ref: null });
  });

  it('returns unauthorized on 403 ApiError', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: new ApiError(403, 'Forbidden', '{"error":"forbidden"}'),
      isError: true,
    });
    expect(r).toEqual({ status: 'unauthorized', ref: null });
  });

  it('falls through to loading on transient errors (e.g. 500) so retry can take over', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: new ApiError(500, 'Internal Server Error', ''),
      isError: true,
    });
    // Design choice: a fourth "error" status is rejected; retry policy
    // keeps trying transient failures, so loading is the honest UI
    // status until the retry budget is exhausted (and even then we
    // stay in "loading" — the placeholder explains the situation).
    expect(r).toEqual({ status: 'loading', ref: null });
  });

  it('falls through to loading on non-ApiError thrown values (e.g. network)', () => {
    const r = mapConversationByIdResult('conv-1', {
      data: undefined,
      error: new Error('network down'),
      isError: true,
    });
    expect(r).toEqual({ status: 'loading', ref: null });
  });
});
