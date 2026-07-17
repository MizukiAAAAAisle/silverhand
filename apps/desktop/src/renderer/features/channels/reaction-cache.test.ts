import { describe, expect, it } from 'vitest';
import type { MessageDto, MessageReactionChangedEvent } from '@silverhand/shared';
import { decodeMessageSeq } from '@silverhand/shared';
import { applyReactionToMessage } from './hooks';

// The projection fan-out that used to live in `applyReactionChangedToChannelCaches`
// / `applyReactionChangedToThreadRootCache` moved into the single message-row
// patch seam (`patchMessageInActiveProjections`, #task:1270); its
// event×projection×reader coverage now lives in
// `features/realtime/conversation-ingestor.test.ts` (the "message-row patch seam"
// matrix). This file keeps the ONE merge helper's unit tests — the pure row
// transform the seam carries as its `patchRow`.

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

function message(
  overrides: Partial<Omit<MessageDto, 'seq'>> & { seq?: number } = {},
): MessageDto {
  const { seq, ...rest } = overrides;
  return {
    id: 'm1',
    conversation_id: 'c1',
    from_kind: 'user',
    from_agent_id: null,
    from_user_id: 'u1',
    content: 'body',
    metadata: null,
    attachments: null,
    seq: decodeMessageSeq(seq ?? 1),
    created_at: 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
    ...rest,
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
