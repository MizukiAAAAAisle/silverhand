import { describe, expect, it } from 'vitest';
import type { AgentRuntimeConversation } from '@silverhand/shared';
import { applyFilter } from './AgentConversationActivityList';

function row(
  overrides: Partial<AgentRuntimeConversation>,
): AgentRuntimeConversation {
  return {
    conversation_id: 'c-0',
    workspace_id: 'w-0',
    workspace_name: 'ws',
    workspace_kind: 'regular',
    conversation_kind: 'channel',
    channel_id: 'c-0',
    thread_id: null,
    channel_title: 'general',
    thread_title: null,
    status: 'idle',
    pid: null,
    closed_at: null,
    ...overrides,
  } as AgentRuntimeConversation;
}

const FIXTURE: AgentRuntimeConversation[] = [
  row({ conversation_id: 'a-active', status: 'active' }),
  row({ conversation_id: 'a-starting', status: 'starting' }),
  row({ conversation_id: 'a-idle', status: 'idle' }),
  row({ conversation_id: 'a-crashed', status: 'crashed' }),
  // A conversation that was last seen `active` but the conversation
  // itself is now closed. v2.3 contract: `Closed` covers any status,
  // and the live status filters must NOT pick this up.
  row({
    conversation_id: 'a-closed-was-active',
    status: 'active',
    closed_at: 1700000000,
  }),
  // A historical crashed row that has since been closed. Cindy's
  // PR-2 review finding: previously this leaked into `Crashed`
  // forever.
  row({
    conversation_id: 'a-closed-was-crashed',
    status: 'crashed',
    closed_at: 1700000001,
  }),
];

function ids(rows: AgentRuntimeConversation[]): string[] {
  return rows.map(r => r.conversation_id).sort();
}

describe('AgentConversationActivityList applyFilter', () => {
  it('`all` returns every row, no filtering', () => {
    expect(ids(applyFilter(FIXTURE, 'all'))).toEqual(
      ids([...FIXTURE]),
    );
  });

  it('`active` includes starting+active, excludes closed-was-active', () => {
    expect(ids(applyFilter(FIXTURE, 'active'))).toEqual([
      'a-active',
      'a-starting',
    ]);
  });

  it('`idle` excludes closed rows even when the last status was idle', () => {
    expect(ids(applyFilter(FIXTURE, 'idle'))).toEqual(['a-idle']);
  });

  it('`crashed` excludes closed rows (regression for #task:396 PR-2 review)', () => {
    // The historical closed/crashed row must NOT show up here — once a
    // conversation is closed it belongs in `Closed` only. This locks
    // the contract Cindy flagged on the first PR-2 review.
    expect(ids(applyFilter(FIXTURE, 'crashed'))).toEqual(['a-crashed']);
  });

  it('`closed` returns every row with a non-null closed_at, regardless of status', () => {
    expect(ids(applyFilter(FIXTURE, 'closed'))).toEqual([
      'a-closed-was-active',
      'a-closed-was-crashed',
    ]);
  });
});
