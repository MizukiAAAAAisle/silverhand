import { describe, expect, it } from 'vitest';
import {
  formatDeliveryInstruction,
  formatStdinMessageHeader,
  type MessageLite,
} from '../../src/runtime/stdin-format.js';
import { createReferenceMemo } from '../../src/runtime/reference-memo.js';

const TOOL = 'silverhand message send';

// #task:2000 — the formatter no longer parses; it asks the phase's one
// derivation for the addressing set. A fresh memo per call keeps these cases
// independent of each other.
const REFERENCES = () => createReferenceMemo().referencesOf;

describe('formatDeliveryInstruction system-message subtypes', () => {
  it('keeps ordinary system-only messages informational', () => {
    expect(
      formatDeliveryInstruction(
        [systemMessage({ subtype: 'rename' })],
        'Cindy',
        TOOL,
        REFERENCES(),
      ),
    ).toBe(
      'Respond as appropriate. System messages do not require a reply unless they explicitly ask for one.',
    );
  });

  it('does not treat retired thread_summary as actionable in reply-cluster mode', () => {
    expect(
      formatDeliveryInstruction(
        [systemMessage({ subtype: 'thread_summary' })],
        'Cindy',
        TOOL,
        REFERENCES(),
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
      REFERENCES(),
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
      agentComputer,
      userName,
      undefined,
    );

    expect(header).toMatch(
      /^\[msg_id=m-main sender=@shiki type=human target=channel time=/,
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
      agentComputer,
      userName,
      undefined,
    );

    expect(header).toMatch(
      /^\[msg_id=m-reply sender=@Alice type=agent computer=host-alice target=thread:m-root time=/,
    );
  });

  it('appends task=#<n> status=<status> for a task system-event message', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-task',
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'Fix the flaky test',
        created_at: 0,
        // The suffix now derives from the task system-event's own metadata
        // (v60: a task is a first-class aggregate, not a message column).
        metadata: JSON.stringify({
          subtype: 'task_create',
          task_number: 123,
          task_status: 'todo',
        }),
      },
      agentName,
      agentComputer,
      userName,
      undefined,
    );

    expect(header).toMatch(
      /^\[msg_id=m-task sender=@shiki type=human target=channel time=\S+ task=#123 status=todo\]$/,
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
        metadata: null,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
    );

    expect(header).not.toContain('task=');
    expect(header).not.toContain('status=');
  });

  it('carries the current status for a task status-change event (in_progress)', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-claimed',
        thread_root_id: null,
        from_kind: 'agent',
        from_agent_id: 'a1',
        from_user_id: null,
        content: 'work it',
        created_at: 0,
        metadata: JSON.stringify({
          subtype: 'task_status',
          task_number: 7,
          task_status: 'in_progress',
        }),
      },
      agentName,
      agentComputer,
      userName,
      undefined,
    );

    expect(header).toContain('task=#7 status=in_progress');
  });

  // ── #task:1600 — conditional computer= header ──────────────────────

  it('agent rows carry computer=<current host id>, resolved live at render time', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-a',
        thread_root_id: null,
        from_kind: 'agent',
        from_agent_id: 'a1',
        from_user_id: null,
        content: 'hi',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
    );
    expect(header).toMatch(
      /^\[msg_id=m-a sender=@Alice type=agent computer=host-alice target=channel time=/,
    );
  });

  it('human and system rows NEVER carry a computer field', () => {
    const human = formatStdinMessageHeader(
      {
        id: 'm-h',
        thread_root_id: null,
        from_kind: 'user',
        from_agent_id: null,
        from_user_id: 'u1',
        content: 'hi',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
    );
    const system = formatStdinMessageHeader(
      systemMessage({}),
      agentName,
      agentComputer,
      userName,
      undefined,
    );
    expect(human).not.toContain('computer=');
    expect(system).not.toContain('computer=');
  });

  it('an unresolvable sender agent OMITS the field — no computer=unknown token exists', () => {
    const header = formatStdinMessageHeader(
      {
        id: 'm-gone',
        thread_root_id: null,
        from_kind: 'agent',
        from_agent_id: 'a-deleted',
        from_user_id: null,
        content: 'hi',
        created_at: 0,
      },
      agentName,
      agentComputer,
      userName,
      undefined,
    );
    expect(header).not.toContain('computer=');
    expect(header).not.toContain('unknown');
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

function agentComputer(id: string): string | undefined {
  return id === 'a1' ? 'host-alice' : undefined;
}

function userName(id: string): string | undefined {
  return id === 'u1' ? 'shiki' : undefined;
}
