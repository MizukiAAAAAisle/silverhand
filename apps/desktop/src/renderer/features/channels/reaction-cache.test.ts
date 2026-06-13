import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type {
  ConversationMessagesDto,
  MessageDto,
  MessageReactionChangedEvent,
} from '@silverhand/shared';
import {
  applyReactionChangedToChannelCaches,
  applyReactionChangedToThreadRootCache,
  applyReactionToMessage,
  clusterMessagesKey,
  messagesKey,
  threadRootKey,
} from './hooks';
import { messageReactorsKey } from './reaction-hooks';

const VIEWER = 'user-self';
const OTHER = 'user-other';

describe('applyReactionToMessage (the one merge helper)', () => {
  it('absolute-assigns count from the event, never op-derived', () => {
    const msg = message({
      reactions: [{ emoji: '👍', count: 4, viewer_reacted: false }],
    });
    // Server says the post-change count is 7 even though op is a single add.
    const out = applyReactionToMessage(
      msg,
      reactionEvent({ emoji: '👍', op: 'add', count: 7, reactor_id: OTHER }),
      VIEWER,
    );
    expect(out.reactions).toEqual([
      { emoji: '👍', count: 7, viewer_reacted: false },
    ]);
  });

  it('flips viewer_reacted true only when the reactor is the viewer', () => {
    const base = message({
      reactions: [{ emoji: '🎉', count: 1, viewer_reacted: false }],
    });
    const byViewer = applyReactionToMessage(
      base,
      reactionEvent({ emoji: '🎉', op: 'add', count: 2, reactor_id: VIEWER }),
      VIEWER,
    );
    expect(byViewer.reactions).toEqual([
      { emoji: '🎉', count: 2, viewer_reacted: true },
    ]);

    // Same emoji bumped by someone else leaves the viewer flag untouched.
    const byOther = applyReactionToMessage(
      base,
      reactionEvent({ emoji: '🎉', op: 'add', count: 2, reactor_id: OTHER }),
      VIEWER,
    );
    expect(byOther.reactions).toEqual([
      { emoji: '🎉', count: 2, viewer_reacted: false },
    ]);
  });

  it('appends a brand-new emoji aggregate', () => {
    const out = applyReactionToMessage(
      message({ reactions: [{ emoji: '👍', count: 1, viewer_reacted: true }] }),
      reactionEvent({ emoji: '👀', op: 'add', count: 1, reactor_id: OTHER }),
      VIEWER,
    );
    expect(out.reactions).toEqual([
      { emoji: '👍', count: 1, viewer_reacted: true },
      { emoji: '👀', count: 1, viewer_reacted: false },
    ]);
  });

  it('drops an emoji when count falls to zero and collapses to null', () => {
    const out = applyReactionToMessage(
      message({ reactions: [{ emoji: '👍', count: 1, viewer_reacted: true }] }),
      reactionEvent({ emoji: '👍', op: 'remove', count: 0, reactor_id: VIEWER }),
      VIEWER,
    );
    expect(out.reactions).toBeNull();
  });
});

describe('applyReactionChangedToChannelCaches', () => {
  it('patches the main-stream window row in place', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), cache([message({ id: 'm1' })]));

    applyReactionChangedToChannelCaches(
      qc,
      'c1',
      reactionEvent({ message_id: 'm1', emoji: '👍', op: 'add', count: 1 }),
      VIEWER,
    );

    const data = qc.getQueryData(messagesKey('c1')) as ReturnType<typeof cache>;
    expect(data.pages[0]?.messages[0]?.reactions).toEqual([
      { emoji: '👍', count: 1, viewer_reacted: true },
    ]);
  });

  it('patches the reply-cluster window when the event targets a reply', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      clusterMessagesKey('c1', 'root1'),
      cache([message({ id: 'reply1' })]),
    );

    applyReactionChangedToChannelCaches(
      qc,
      'c1',
      reactionEvent({
        message_id: 'reply1',
        thread_root_id: 'root1',
        emoji: '🔥',
        op: 'add',
        count: 2,
        reactor_id: OTHER,
      }),
      VIEWER,
    );

    const data = qc.getQueryData(
      clusterMessagesKey('c1', 'root1'),
    ) as ReturnType<typeof cache>;
    expect(data.pages[0]?.messages[0]?.reactions).toEqual([
      { emoji: '🔥', count: 2, viewer_reacted: false },
    ]);
  });

  // P1.2 (#task:1122 review): the lazy hover "who reacted" list must be
  // invalidated, or an already-open list shows names stale by up to its
  // staleTime even though the chip count already moved.
  it('invalidates the lazy reactor-detail query', () => {
    const qc = new QueryClient();
    qc.setQueryData(messageReactorsKey('m1'), []);
    expect(qc.getQueryState(messageReactorsKey('m1'))?.isInvalidated).toBe(
      false,
    );

    applyReactionChangedToChannelCaches(
      qc,
      'c1',
      reactionEvent({ message_id: 'm1', emoji: '👍', op: 'add', count: 1 }),
      VIEWER,
    );

    expect(qc.getQueryState(messageReactorsKey('m1'))?.isInvalidated).toBe(true);
  });
});

describe('applyReactionChangedToThreadRootCache', () => {
  // P1.1 (#task:1122 review): a reaction on a thread root (thread_root_id is
  // null — it lives in the main stream) must reach the thread pane's separate
  // root-row query, which the channel handler never touches.
  it('patches the thread-pane root row for its own root', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      threadRootKey('c1', 'root1'),
      windowDto([message({ id: 'root1' })]),
    );

    applyReactionChangedToThreadRootCache(
      qc,
      'c1',
      'root1',
      reactionEvent({
        message_id: 'root1',
        thread_root_id: null,
        emoji: '👀',
        op: 'add',
        count: 1,
        reactor_id: OTHER,
      }),
      VIEWER,
    );

    const data = qc.getQueryData(
      threadRootKey('c1', 'root1'),
    ) as ConversationMessagesDto;
    expect(data.messages[0]?.reactions).toEqual([
      { emoji: '👀', count: 1, viewer_reacted: false },
    ]);
  });

  it('is a no-op for an event targeting a different message', () => {
    const qc = new QueryClient();
    const seeded = windowDto([message({ id: 'root1' })]);
    qc.setQueryData(threadRootKey('c1', 'root1'), seeded);

    applyReactionChangedToThreadRootCache(
      qc,
      'c1',
      'root1',
      reactionEvent({ message_id: 'someone-else', emoji: '👀', op: 'add' }),
      VIEWER,
    );

    // Untouched — same reference, no reactions added.
    expect(qc.getQueryData(threadRootKey('c1', 'root1'))).toBe(seeded);
  });
});

function message(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'm1',
    conversation_id: 'c1',
    from_kind: 'user',
    from_agent_id: null,
    from_user_id: 'u1',
    content: 'body',
    metadata: null,
    attachments: null,
    seq: 1,
    created_at: 0,
    thread_root_id: null,
    task_number: null,
    task_status: null,
    task_title: null,
    task_workspace_id: null,
    task_closed_at: null,
    task_assignee: null,
    reactions: null,
    ...overrides,
  };
}

function windowDto(messages: MessageDto[]): ConversationMessagesDto {
  return {
    messages,
    reply_counts_by_root: {},
    has_more_before: false,
    has_more_after: false,
  };
}

function cache(messages: MessageDto[]) {
  return {
    pages: [windowDto(messages)],
    pageParams: [undefined],
  };
}

function reactionEvent(
  overrides: Partial<MessageReactionChangedEvent> = {},
): MessageReactionChangedEvent {
  return {
    message_id: 'm1',
    conversation_id: 'c1',
    thread_root_id: null,
    emoji: '👍',
    op: 'add',
    reactor_kind: 'user',
    reactor_id: VIEWER,
    count: 1,
    ...overrides,
  };
}
