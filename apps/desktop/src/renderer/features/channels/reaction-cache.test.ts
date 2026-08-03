import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@silverhand/shared';
import { decodeMessageSeq } from '@silverhand/shared';
import {
  type CommittedReaction,
  applyReactionToMessage,
} from './projection-cache';

// The projection fan-out that used to live in `applyReactionChangedToChannelCaches`
// / `applyReactionChangedToThreadRootCache` moved into the single message-row
// patch seam (`patchMessageInActiveProjections`, #task:1270); its
// event×projection×reader coverage now lives in
// `features/realtime/conversation-ingestor.test.ts` (the "message-row patch seam"
// matrix, plus the ACK/WS convergence grid added in #task:1753). This file keeps
// the ONE merge helper's unit tests — the pure row transform the seam carries as
// its `patchRow`.
//
// #task:1753 turned the helper's input from a WS event into a typed
// {@link CommittedReaction}: the viewer's terminal state is resolved at the
// transport edge (`op === 'add'` when the event's reactor IS the viewer, `null`
// when the change is someone else's), so the merge takes `viewerReacted` as a
// tri-state and never sees a reactor id. Only the ORDERED plane produces one —
// the viewer's write ACK, having no shared ordering axis, re-reads instead of
// assigning (#task:1753 review) — but the identity-preservation cases below still
// carry their weight: WS replay re-delivers the same committed value.

describe('applyReactionToMessage (the one merge helper)', () => {
  it('absolute-assigns count from the delta, never op-derived', () => {
    const msg = message({
      reactions: [{ emoji: '👍', count: 4, viewer_reacted: false }],
    });
    // The server's post-change aggregate is 7 even though a single add produced
    // it (a batch of other reactors landed in between).
    const out = applyReactionToMessage(
      msg,
      delta({ emoji: '👍', count: 7, viewerReacted: null }),
    );
    expect(out.reactions).toEqual([
      { emoji: '👍', count: 7, viewer_reacted: false },
    ]);
  });

  it('sets viewer_reacted from the delta, and leaves it untouched when the delta says nothing about the viewer', () => {
    const base = message({
      reactions: [{ emoji: '🎉', count: 1, viewer_reacted: false }],
    });
    const byViewer = applyReactionToMessage(
      base,
      delta({ emoji: '🎉', count: 2, viewerReacted: true }),
    );
    expect(byViewer.reactions).toEqual([
      { emoji: '🎉', count: 2, viewer_reacted: true },
    ]);

    // `viewerReacted: null` — someone else's change. The count is authoritative,
    // the viewer flag is NOT part of what this delta knows.
    const byOther = applyReactionToMessage(
      base,
      delta({ emoji: '🎉', count: 2, viewerReacted: null }),
    );
    expect(byOther.reactions).toEqual([
      { emoji: '🎉', count: 2, viewer_reacted: false },
    ]);

    // ...including when the row already had the viewer's flag set: another
    // reactor's bump must never clear it.
    const viewerHeld = applyReactionToMessage(
      message({ reactions: [{ emoji: '🎉', count: 1, viewer_reacted: true }] }),
      delta({ emoji: '🎉', count: 2, viewerReacted: null }),
    );
    expect(viewerHeld.reactions).toEqual([
      { emoji: '🎉', count: 2, viewer_reacted: true },
    ]);
  });

  it('appends a brand-new emoji aggregate', () => {
    const out = applyReactionToMessage(
      message({ reactions: [{ emoji: '👍', count: 1, viewer_reacted: true }] }),
      delta({ emoji: '👀', count: 1, viewerReacted: null }),
    );
    expect(out.reactions).toEqual([
      { emoji: '👍', count: 1, viewer_reacted: true },
      { emoji: '👀', count: 1, viewer_reacted: false },
    ]);
  });

  it('drops an emoji when count falls to zero and collapses to null', () => {
    const out = applyReactionToMessage(
      message({ reactions: [{ emoji: '👍', count: 1, viewer_reacted: true }] }),
      delta({ emoji: '👍', count: 0, viewerReacted: false }),
    );
    expect(out.reactions).toBeNull();
  });

  // The re-delivery cost control (#task:1753): the ordered plane replays, and a
  // recovery refetch can land a value the cache already holds, so a redundant
  // apply must be free. Returning the same object is what makes it free — both
  // projection walkers compare identity and skip the cache write (and therefore
  // the re-render) when the merge is a no-op. A structurally-equal-but-new object
  // would silently re-render every displayed projection on every reaction.
  describe('identity preservation (a redundant apply must write nothing)', () => {
    it('returns the SAME message object when the value already matches', () => {
      const msg = message({
        reactions: [{ emoji: '👍', count: 2, viewer_reacted: true }],
      });
      const out = applyReactionToMessage(
        msg,
        delta({ emoji: '👍', count: 2, viewerReacted: true }),
      );
      expect(out).toBe(msg);
    });

    it('returns the SAME object when a null-viewer delta matches the stored count', () => {
      const msg = message({
        reactions: [{ emoji: '👍', count: 2, viewer_reacted: true }],
      });
      const out = applyReactionToMessage(
        msg,
        delta({ emoji: '👍', count: 2, viewerReacted: null }),
      );
      expect(out).toBe(msg);
    });

    it('returns the SAME object when a zero-count delta targets an emoji the row does not hold', () => {
      const msg = message({
        reactions: [{ emoji: '👍', count: 1, viewer_reacted: false }],
      });
      const out = applyReactionToMessage(
        msg,
        delta({ emoji: '👀', count: 0, viewerReacted: false }),
      );
      expect(out).toBe(msg);
    });

    it('still writes when only the viewer flag moves (same count)', () => {
      const msg = message({
        reactions: [{ emoji: '👍', count: 1, viewer_reacted: false }],
      });
      // A remove-then-add by two different actors can leave the count identical
      // while the viewer's own membership flips — the flag is not derivable from
      // the count, so this is a real change.
      const out = applyReactionToMessage(
        msg,
        delta({ emoji: '👍', count: 1, viewerReacted: true }),
      );
      expect(out).not.toBe(msg);
      expect(out.reactions).toEqual([
        { emoji: '👍', count: 1, viewer_reacted: true },
      ]);
    });
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
    author: {
      status: 'active',
      kind: 'user',
      id: 'u1',
      name: 'User',
      display_name: 'User',
      avatar_url: null,
      runtime: null,
    },
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

function delta(
  overrides: Partial<Omit<CommittedReaction, 'target'>> = {},
): CommittedReaction {
  return {
    target: { channelId: 'c1', messageId: 'm1', threadRootId: null },
    emoji: '👍',
    count: 1,
    viewerReacted: null,
    ...overrides,
  };
}
