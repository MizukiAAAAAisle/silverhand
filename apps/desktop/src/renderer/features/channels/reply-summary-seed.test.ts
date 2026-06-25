import { describe, expect, it } from 'vitest';
import type {
  ConversationMessagesDto,
  MessageDto,
  ReplyBadgeSummary,
} from '@silverhand/shared';
import { replyClusterNeedsSummarySeed, replyClusterNeedsSummaryReconcile } from './hooks';

// #task:1226 surface 3 dogfood bug: a reply chip never shows "N new" when the
// root had ZERO replies at fetch time, because the optimistic live-reply bump
// can't fabricate a per-viewer summary. `replyClusterNeedsSummarySeed` flags
// exactly that seeding transition so the caller refetches the server summary.

function message(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'root1',
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

function summary(over: Partial<ReplyBadgeSummary> = {}): ReplyBadgeSummary {
  return {
    reply_count: 1,
    last_reply_at: 0,
    repliers: [],
    replier_total: 1,
    unread_count: 1,
    first_unread_message_id: 'r1',
    first_unread_seq: 2,
    ...over,
  };
}

function page(
  over: Partial<ConversationMessagesDto> = {},
): ConversationMessagesDto {
  return {
    messages: [message()],
    reply_counts_by_root: {},
    has_more_before: false,
    has_more_after: false,
    stream_head_seq: 1,
    ...over,
  };
}

function cache(p: ConversationMessagesDto) {
  return { pages: [p], pageParams: [undefined] };
}

describe('replyClusterNeedsSummarySeed (#task:1226 surface 3)', () => {
  it('false when the cache is undefined', () => {
    expect(replyClusterNeedsSummarySeed(undefined, 'root1')).toBe(false);
  });

  it('false when the root is not in any loaded page', () => {
    expect(
      replyClusterNeedsSummarySeed(
        cache(page({ reply_summaries_by_root: {} })),
        'absent-root',
      ),
    ).toBe(false);
  });

  it('false when the backend has not shipped the sidecar (count-only by design)', () => {
    // No `reply_summaries_by_root` field at all → never refetch on every reply.
    expect(
      replyClusterNeedsSummarySeed(cache(page()), 'root1'),
    ).toBe(false);
  });

  it('TRUE when the sidecar is shipped but this root has no entry yet (the bug)', () => {
    // Root loaded with zero replies → present-but-empty sidecar. The first live
    // reply must trigger a refetch so the server returns the summary + unread.
    expect(
      replyClusterNeedsSummarySeed(
        cache(page({ reply_summaries_by_root: {} })),
        'root1',
      ),
    ).toBe(true);
  });

  it('false when a summary already exists (keep optimistic patch + WS reconcile)', () => {
    expect(
      replyClusterNeedsSummarySeed(
        cache(page({ reply_summaries_by_root: { root1: summary() } })),
        'root1',
      ),
    ).toBe(false);
  });

  it('TRUE when the root is in one page and the sidecar (on that page) lacks it', () => {
    // Multi-page: root lives in a page whose shipped sidecar has no entry.
    const c = {
      pages: [
        page({
          messages: [message({ id: 'other', seq: 5 })],
          reply_summaries_by_root: { other: summary() },
        }),
        page({
          messages: [message({ id: 'root1', seq: 1 })],
          reply_summaries_by_root: {},
        }),
      ],
      pageParams: [undefined, { kind: 'before' as const, seq: 5 }],
    };
    expect(replyClusterNeedsSummarySeed(c, 'root1')).toBe(true);
  });
});

describe('replyClusterNeedsSummaryReconcile (#task:1226 surface 3 has-summary path)', () => {
  it('false when the cache is undefined', () => {
    expect(replyClusterNeedsSummaryReconcile(undefined, 'root1')).toBe(false);
  });

  it('false when the root is not in any loaded page', () => {
    expect(
      replyClusterNeedsSummaryReconcile(
        cache(page({ reply_summaries_by_root: { root1: summary() } })),
        'absent-root',
      ),
    ).toBe(false);
  });

  it('false on the SEED state (sidecar shipped but this root has no entry)', () => {
    // Seed is the other helper's job; reconcile only fires once a summary exists.
    expect(
      replyClusterNeedsSummaryReconcile(
        cache(page({ reply_summaries_by_root: {} })),
        'root1',
      ),
    ).toBe(false);
  });

  it('false when the sidecar was never shipped (count-only by design)', () => {
    expect(replyClusterNeedsSummaryReconcile(cache(page()), 'root1')).toBe(
      false,
    );
  });

  it('TRUE when the root already has a summary (the back-and-forth bug)', () => {
    // 2nd reply onward: patchReplySummary keeps the prior server-scored unread,
    // so the chip would freeze at the old "N new" — the caller must refetch.
    expect(
      replyClusterNeedsSummaryReconcile(
        cache(page({ reply_summaries_by_root: { root1: summary() } })),
        'root1',
      ),
    ).toBe(true);
  });

  it('TRUE when the summary lives on a later page than page one', () => {
    const c = {
      pages: [
        page({
          messages: [message({ id: 'other', seq: 5 })],
          reply_summaries_by_root: { other: summary() },
        }),
        page({
          messages: [message({ id: 'root1', seq: 1 })],
          reply_summaries_by_root: { root1: summary({ unread_count: 3 }) },
        }),
      ],
      pageParams: [undefined, { kind: 'before' as const, seq: 5 }],
    };
    expect(replyClusterNeedsSummaryReconcile(c, 'root1')).toBe(true);
  });
});
