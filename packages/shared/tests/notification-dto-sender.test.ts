import { describe, expect, it } from 'vitest';
import { NotificationDtoSchema } from '../src/api/notification.js';

const base = {
  id: 'n-1',
  kind: 'mention_self',
  user_id: 'u-1',
  agent_id: null,
  workspace_id: 'w-1',
  conversation_id: 'c-1',
  message_id: 'm-1',
  thread_root_id: null,
  source_workspace_id: null,
  source_conversation_id: null,
  source_message_id: null,
  payload: {},
  read_at: null,
  created_at: 1,
};

describe('NotificationDto.sender', () => {
  it('accepts an older backend response without the field', () => {
    expect(NotificationDtoSchema.parse(base).sender ?? null).toBeNull();
  });

  it('accepts null and every author arm', () => {
    const senders = [
      null,
      { status: 'active', kind: 'user', id: 'u-2', name: 'bo', display_name: 'Bo', avatar_url: null, runtime: null },
      { status: 'deleted', kind: 'agent', id: 'a-1', name: 'gone', display_name: 'Gone', avatar_url: null },
      { status: 'unresolved', kind: 'user', id: null, name: null, display_name: null, avatar_url: null },
    ];
    for (const sender of senders) {
      expect(NotificationDtoSchema.parse({ ...base, sender }).sender).toEqual(sender);
    }
  });
});
