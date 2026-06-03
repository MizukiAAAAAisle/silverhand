import { describe, expect, it } from 'vitest';
import type { MemberDto } from '@silverhand/shared';
import { ApiError } from '@/lib/api';
import { mapConversationMembersResult } from './useConversationMembers';

const sampleMembers: MemberDto[] = [
  {
    kind: 'agent',
    agent_id: 'agt_alice',
    name: 'alice',
    display_name: 'Alice',
    runtime: 'claude',
  },
  {
    kind: 'human',
    user_id: 'usr_local',
    name: 'shiki',
    display_name: 'shiki',
    avatar_url: null,
  },
];

describe('mapConversationMembersResult', () => {
  it('returns loading when id is null', () => {
    const r = mapConversationMembersResult(null, {
      data: undefined,
      error: null as unknown as Error,
      isError: false,
    });
    expect(r).toEqual({ status: 'loading', members: [] });
  });

  it('returns loading when id set but fetch pending (no data, no error)', () => {
    const r = mapConversationMembersResult('conv-1', {
      data: undefined,
      error: null as unknown as Error,
      isError: false,
    });
    expect(r).toEqual({ status: 'loading', members: [] });
  });

  it('returns resolved with the members payload on success', () => {
    const r = mapConversationMembersResult('conv-1', {
      data: { members: sampleMembers },
      error: null as unknown as Error,
      isError: false,
    });
    expect(r.status).toBe('resolved');
    expect(r.members).toEqual(sampleMembers);
  });

  it('treats an empty members array as a valid resolution', () => {
    const r = mapConversationMembersResult('conv-1', {
      data: { members: [] },
      error: null as unknown as Error,
      isError: false,
    });
    expect(r).toEqual({ status: 'resolved', members: [] });
  });

  it('returns not_found on 404 ApiError', () => {
    const r = mapConversationMembersResult('conv-1', {
      data: undefined,
      error: new ApiError(404, 'Not Found', '{"error":"conversation not found"}'),
      isError: true,
    });
    expect(r).toEqual({ status: 'not_found', members: [] });
  });

  it('returns unauthorized on 403 ApiError', () => {
    const r = mapConversationMembersResult('conv-1', {
      data: undefined,
      error: new ApiError(403, 'Forbidden', '{"error":"forbidden"}'),
      isError: true,
    });
    expect(r).toEqual({ status: 'unauthorized', members: [] });
  });

  it('falls through to loading on transient errors (e.g. 500)', () => {
    const r = mapConversationMembersResult('conv-1', {
      data: undefined,
      error: new ApiError(500, 'Internal Server Error', ''),
      isError: true,
    });
    expect(r).toEqual({ status: 'loading', members: [] });
  });

  it('falls through to loading on non-ApiError errors', () => {
    const r = mapConversationMembersResult('conv-1', {
      data: undefined,
      error: new Error('network down'),
      isError: true,
    });
    expect(r).toEqual({ status: 'loading', members: [] });
  });
});
