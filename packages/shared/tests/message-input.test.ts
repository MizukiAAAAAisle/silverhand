import { describe, expect, it } from 'vitest';
import {
  AgentSendMessageInputSchema,
  SendMessageInputSchema,
} from '../src/api/index.js';

describe('message send input schemas', () => {
  it('accepts text-only messages', () => {
    expect(SendMessageInputSchema.safeParse({ content: 'hello' }).success).toBe(true);
    expect(
      AgentSendMessageInputSchema.safeParse({ content: 'hello' }).success,
    ).toBe(true);
  });

  it('accepts attachment-only messages with empty content', () => {
    expect(
      SendMessageInputSchema.safeParse({
        content: '',
        attachment_ids: ['att-1'],
      }).success,
    ).toBe(true);
    expect(
      AgentSendMessageInputSchema.safeParse({
        content: '',
        attachment_ids: ['att-1'],
      }).success,
    ).toBe(true);
  });

  it('rejects empty messages without text or attachments', () => {
    const user = SendMessageInputSchema.safeParse({ content: '' });
    const agent = AgentSendMessageInputSchema.safeParse({ content: '   ' });
    expect(user.success).toBe(false);
    expect(agent.success).toBe(false);
    if (!user.success) {
      expect(user.error.issues[0]?.message).toBe(
        'message must include text or at least one attachment',
      );
    }
    if (!agent.success) {
      expect(agent.error.issues[0]?.message).toBe(
        'message must include text or at least one attachment',
      );
    }
  });
});
