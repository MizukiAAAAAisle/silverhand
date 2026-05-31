import { describe, expect, it } from 'vitest';
import { formatDeliveryInstruction, type MessageLite } from '../../src/runtime/stdin-format.js';

const TOOL = 'silverhand message send';

describe('formatDeliveryInstruction system-message subtypes', () => {
  it('asks relevant agents to act on closed-thread summaries', () => {
    const instruction = formatDeliveryInstruction(
      [systemMessage({ subtype: 'thread_summary' })],
      'Cindy',
      TOOL,
    );

    expect(instruction).toContain('closed-thread summary');
    expect(instruction).toContain(TOOL);
    expect(instruction).toContain('no visible reply is required');
  });

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

  it('keeps user-message precedence over actionable system subtypes', () => {
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
        },
      ],
      'Cindy',
      TOOL,
    );

    expect(instruction).toContain('Respond as appropriate');
    expect(instruction).not.toContain('closed-thread summary');
  });
});

function systemMessage(overrides: Partial<MessageLite> = {}): MessageLite {
  return {
    id: 'm-system',
    from_kind: 'system',
    from_agent_id: null,
    from_user_id: null,
    content: 'system event',
    created_at: 0,
    ...overrides,
  };
}
