import { describe, expect, it } from 'vitest';
import {
  formatDeliveryInstruction,
  formatStdinMessageHeader,
  type MessageLite,
} from '../../src/runtime/stdin-format.js';

const TOOL = 'silverhand message send';

describe('formatDeliveryInstruction system-message subtypes', () => {
  it('keeps ordinary system-only messages informational', () => {
    expect(
      formatDeliveryInstruction(
        [systemMessage({ subtype: 'rename' })],
        'Cindy',
        TOOL,
      ),
    ).toBe(
      'Respond as appropriate. System messages do not require a reply unless they explicitly ask for one.',
    );
  });

  it('does not treat legacy thread_summary as actionable in reply-cluster mode', () => {
    expect(
      formatDeliveryInstruction(
        [systemMessage({ subtype: 'thread_summary' })],
        'Cindy',
        TOOL,
      ),
    ).toBe(
      'Respond as appropriate. System messages do not require a reply unless they explicitly ask for one.',
    );
  });

  it('keeps user-message precedence over system subtypes', () => {
    const instruction = formatDeliveryInstruction(
      [
        systemMessage({ subtype: 'thread_summary' }),
        {
          id: 'm-user',
          from_kind: 'user',
          from_agent_id: null,
          from_user_id: 'u1',
          content: 'Please handle this',
          created_at: 1,
          thread_root_id: null,
        },
      ],
      'Cindy',
      TOOL,
    );

    expect(instruction).toContain('Respond as appropriate');
    expect(instruction).not.toContain('closed-thread summary');
  });
});

describe('formatStdinMessageHeader reply-cluster metadata', () => {
  it('omits thread metadata for main-line messages', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-main',
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'main',
        created_at: 0,
      },
      agentName,
      userName,
      undefined,
    );

    expect(header).toMatch(
      /^msg_id=m-main sender=@shiki type=human target=channel time=/,
    );
    expect(header).not.toContain('thread:');
  });

  it('includes thread root metadata for reply-cluster messages', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-reply',
        thread_root_id: 'm-root',
        from_kind: 'agent',
        from_agent_id: 'a1',
        from_user_id: null,
        content: 'reply',
        created_at: 0,
      },
      agentName,
      userName,
      undefined,
    );

    expect(header).toMatch(
      /^msg_id=m-reply sender=@Alice type=agent target=thread:m-root time=/,
    );
  });

  it('appends task=#<n> status=<status> when the row is a task anchor', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-task',
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'Fix the flaky test',
        created_at: 0,
        task_number: 123,
        task_status: 'todo',
      },
      agentName,
      userName,
      undefined,
    );

    expect(header).toMatch(
      /^msg_id=m-task sender=@shiki type=human target=channel time=\S+ task=#123 status=todo$/,
    );
  });

  it('omits the task suffix for a non-task message', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-plain',
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'just chatting',
        created_at: 0,
        task_number: null,
        task_status: null,
      },
      agentName,
      userName,
      undefined,
    );

    expect(header).not.toContain('task=');
    expect(header).not.toContain('status=');
  });

  it('carries the current status for a promoted (in_progress) task', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-claimed',
        thread_root_id: null,
        from_kind: 'agent',
        from_agent_id: 'a1',
        from_user_id: null,
        content: 'work it',
        created_at: 0,
        task_number: 7,
        task_status: 'in_progress',
      },
      agentName,
      userName,
      undefined,
    );

    expect(header).toContain('task=#7 status=in_progress');
  });
});

function systemMessage(overrides: Partial<MessageLite> = {}): MessageLite {
  return {
    id: 'm-system',
    thread_root_id: null,
    from_kind: 'system',
    from_agent_id: null,
    from_user_id: null,
    content: 'system event',
    created_at: 0,
    ...overrides,
  };
}

function agentName(id: string): string | undefined {
  return id === 'a1' ? 'Alice' : undefined;
}

function userName(id: string): string | undefined {
  return id === 'u1' ? 'shiki' : undefined;
}
