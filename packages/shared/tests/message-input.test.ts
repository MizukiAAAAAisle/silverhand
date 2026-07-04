import { describe, expect, it } from 'vitest';
import {
  AgentSendMessageInputSchema,
  ConversationMessagesDtoSchema,
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

  it('accepts attachment refs carrying a compose-time label alongside bare ids', () => {
    // Composer path: {id, label} objects; mixed with a bare id is still valid
    // (the wire union normalizes both at the route boundary).
    expect(
      SendMessageInputSchema.safeParse({
        content: '',
        attachment_ids: [{ id: 'att-1', label: 'Image #1' }, 'att-2'],
      }).success,
    ).toBe(true);
  });

  it('rejects attachment refs with an empty id', () => {
    expect(
      SendMessageInputSchema.safeParse({
        content: 'x',
        attachment_ids: [{ id: '' }],
      }).success,
    ).toBe(false);
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

  it('accepts reply-cluster count sidecars on message windows', () => {
    expect(
      ConversationMessagesDtoSchema.safeParse({
        messages: [],
        reply_counts_by_root: { root_message_id: 2 },
        has_more_before: false,
        has_more_after: false,
        stream_head_seq: 0,
      }).success,
    ).toBe(true);
  });
});
