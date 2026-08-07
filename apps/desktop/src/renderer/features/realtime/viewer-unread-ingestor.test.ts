import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { decodeMessageSeq } from '@silverhand/shared';
import type {
  FavoriteRowDto,
  ListFavoritesDto,
  MessageUnreadByConversationDto,
  MessageUnreadPointerDto,
  MessageUnreadSummaryDto,
  ServerFrame,
  UnreadUpdatedMessagePayload,
} from '@silverhand/shared';

// isCurrentViewerScope is stubbed to a fixed viewer so the dispatcher's scope
// gate is deterministic; every other ws-client export stays real (the patch
// functions never invoke the transport).
vi.mock('@/lib/ws-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ws-client')>();
  return {
    ...actual,
    isCurrentViewerScope: (scope: string) => scope === 'viewer:u-1',
  };
});

import {
  messageUnreadByConversationKey,
  messageUnreadSummaryKey,
  patchMessageUnreadByConversation,
  patchMessageUnreadSummary,
} from '@/features/channels/hooks';
import { favoritesKey, patchFavoritesUnread } from '@/features/favorites/hooks';
import { ingestViewerUnreadFrame } from './viewer-unread-ingestor';

function pointer(messageId: string, seq: number): MessageUnreadPointerDto {
  return {
    conversation_id: 'c-1',
    message_id: messageId,
    seq: decodeMessageSeq(seq),
    thread_root_id: null,
  };
}

/** An enriched message-variant `unread_updated` payload. */
function payload(
  over: Partial<UnreadUpdatedMessagePayload> = {},
): UnreadUpdatedMessagePayload {
  return {
    conversation_id: 'c-1',
    workspace_id: 'w-1',
    conversation_unread_count: 1,
    workspace_unread_count: 1,
    latest_unread: pointer('m-1', 10),
    ...over,
  };
}

function frame(over: Partial<Extract<ServerFrame, { type: 'event' }>> = {}): ServerFrame {
  return {
    type: 'event',
    scope: 'viewer:u-1',
    kind: 'unread_updated',
    seq: decodeMessageSeq(1),
    epoch: 1,
    payload: payload(),
    ...over,
  } as ServerFrame;
}

const emptyViewerSort: ListFavoritesDto['viewer_sort'] = {
  list_key: 'favorites',
  modes: {},
  entries: [],
};

/** A favorite row is a CONVERSATION since #task:1888 — matched by `entity_id`
 *  against the frame's `conversation_id`; `workspace_id` is its PARENT. */
function favRow(
  conversationId: string,
  unread: number | null,
  workspaceId = 'w-1',
): FavoriteRowDto {
  return {
    kind: 'channel',
    favorite_key: `channel:${conversationId}`,
    entity_id: conversationId,
    workspace_id: workspaceId,
    title: conversationId,
    parent_title: workspaceId,
    parent_icon_url: null,
    parent_runtime: null,
    starred_at: 0,
    created_at: 0,
    unread_count: unread,
  };
}

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient();
});

describe('patchMessageUnreadByConversation — sparse-map authoritative upsert', () => {
  const key = messageUnreadByConversationKey('w-1', 'regular');

  it('is a no-op (cold) when the query is not loaded', () => {
    expect(patchMessageUnreadByConversation(qc, payload())).toBe('cold');
    expect(qc.getQueryData(key)).toBeUndefined(); // never creates the cache
  });

  it('updates an existing conversation count + total + pointer (patched)', () => {
    qc.setQueryData<MessageUnreadByConversationDto>(key, {
      by_conversation: { 'c-1': 1, 'c-2': 3 },
      latest_by_conversation: { 'c-1': pointer('old', 5), 'c-2': pointer('x', 9) },
      total: 4,
    });
    expect(
      patchMessageUnreadByConversation(
        qc,
        payload({ conversation_unread_count: 2, workspace_unread_count: 5, latest_unread: pointer('m-2', 20) }),
      ),
    ).toBe('patched');
    const next = qc.getQueryData<MessageUnreadByConversationDto>(key)!;
    expect(next.by_conversation).toEqual({ 'c-1': 2, 'c-2': 3 });
    expect(next.latest_by_conversation['c-1']?.message_id).toBe('m-2');
    expect(next.total).toBe(5); // absolute workspace rollup, written directly
  });

  it('INSERTS a key for a conversation not yet in the map (map membership is authoritative)', () => {
    qc.setQueryData<MessageUnreadByConversationDto>(key, {
      by_conversation: { 'c-2': 3 },
      latest_by_conversation: { 'c-2': pointer('x', 9) },
      total: 3,
    });
    expect(patchMessageUnreadByConversation(qc, payload({ workspace_unread_count: 4 }))).toBe(
      'patched',
    );
    const next = qc.getQueryData<MessageUnreadByConversationDto>(key)!;
    expect(next.by_conversation).toEqual({ 'c-1': 1, 'c-2': 3 }); // c-1 inserted
    expect(next.latest_by_conversation['c-1']?.message_id).toBe('m-1');
  });

  it('CLEAR (count 0) DELETES the key — patched map is structurally identical to a refetched one', () => {
    qc.setQueryData<MessageUnreadByConversationDto>(key, {
      by_conversation: { 'c-1': 2, 'c-2': 3 },
      latest_by_conversation: { 'c-1': pointer('old', 5), 'c-2': pointer('x', 9) },
      total: 5,
    });
    expect(
      patchMessageUnreadByConversation(
        qc,
        payload({ conversation_unread_count: 0, workspace_unread_count: 3, latest_unread: null }),
      ),
    ).toBe('cleared');
    const next = qc.getQueryData<MessageUnreadByConversationDto>(key)!;
    // Deep-equal to what a REFETCH would return: c-1 is ABSENT (not a phantom 0),
    // no dangling pointer. This is the §8 structural-diff guarantee.
    const refetched: MessageUnreadByConversationDto = {
      by_conversation: { 'c-2': 3 },
      latest_by_conversation: { 'c-2': pointer('x', 9) },
      total: 3,
    };
    expect(next).toEqual(refetched);
    expect('c-1' in next.by_conversation).toBe(false);
    expect('c-1' in next.latest_by_conversation).toBe(false);
  });

  it('is idempotent — an unchanged patch writes nothing (same reference)', () => {
    qc.setQueryData<MessageUnreadByConversationDto>(key, {
      by_conversation: { 'c-1': 1 },
      latest_by_conversation: { 'c-1': pointer('m-1', 10) },
      total: 1,
    });
    const before = qc.getQueryData(key);
    expect(patchMessageUnreadByConversation(qc, payload())).toBe('unchanged');
    expect(qc.getQueryData(key)).toBe(before); // identical ref → no re-render
  });
});

describe('patchMessageUnreadSummary — sparse by_workspace map', () => {
  it('is a no-op (cold) when the summary is not loaded', () => {
    expect(patchMessageUnreadSummary(qc, payload())).toBe('cold');
    expect(qc.getQueryData(messageUnreadSummaryKey)).toBeUndefined();
  });

  it('sets the workspace count (patched)', () => {
    qc.setQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey, {
      by_workspace: { 'w-2': 5 },
    });
    expect(patchMessageUnreadSummary(qc, payload({ workspace_unread_count: 7 }))).toBe(
      'patched',
    );
    expect(qc.getQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey)).toEqual({
      by_workspace: { 'w-1': 7, 'w-2': 5 },
    });
  });

  it('CLEAR (0) deletes the workspace key — deep-equal to a refetched map', () => {
    qc.setQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey, {
      by_workspace: { 'w-1': 3, 'w-2': 5 },
    });
    expect(patchMessageUnreadSummary(qc, payload({ workspace_unread_count: 0 }))).toBe(
      'cleared',
    );
    expect(qc.getQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey)).toEqual({
      by_workspace: { 'w-2': 5 }, // w-1 absent, not 0
    });
  });

  it('is idempotent', () => {
    qc.setQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey, {
      by_workspace: { 'w-1': 1 },
    });
    const before = qc.getQueryData(messageUnreadSummaryKey);
    expect(patchMessageUnreadSummary(qc, payload())).toBe('unchanged');
    expect(qc.getQueryData(messageUnreadSummaryKey)).toBe(before);
  });
});

describe('patchFavoritesUnread — list-row present-only write', () => {
  function seed(rows: FavoriteRowDto[]): void {
    qc.setQueryData<ListFavoritesDto>(favoritesKey, {
      items: rows,
      viewer_sort: emptyViewerSort,
    });
  }

  it('is a no-op (cold) when the list is not loaded', () => {
    expect(patchFavoritesUnread(qc, payload())).toBe('cold');
    expect(qc.getQueryData(favoritesKey)).toBeUndefined();
  });

  it('is a no-op (absent) when no row matches — NEVER inserts a row', () => {
    seed([favRow('c-2', 3)]);
    const before = qc.getQueryData(favoritesKey);
    expect(patchFavoritesUnread(qc, payload({ conversation_id: 'c-1' }))).toBe('absent');
    expect(qc.getQueryData(favoritesKey)).toBe(before); // untouched, no insert
  });

  it('writes the CONVERSATION count on the matching row, not the parent roll-up', () => {
    seed([favRow('c-1', 1), favRow('c-2', 3)]);
    expect(
      patchFavoritesUnread(
        qc,
        payload({ conversation_unread_count: 9, workspace_unread_count: 40 }),
      ),
    ).toBe('patched');
    const items = qc.getQueryData<ListFavoritesDto>(favoritesKey)!.items;
    // 9, never 40 — a row whose parent has other unread conversations would
    // otherwise overstate its badge (#task:1888).
    expect(items.find(r => r.entity_id === 'c-1')?.unread_count).toBe(9);
    expect(items.find(r => r.entity_id === 'c-2')?.unread_count).toBe(3); // untouched
  });

  it('CLEAR writes 0 on the row (present-only) — never deletes the row', () => {
    seed([favRow('c-1', 4)]);
    expect(
      patchFavoritesUnread(
        qc,
        payload({ conversation_unread_count: 0, workspace_unread_count: 3 }),
      ),
    ).toBe('patched');
    const items = qc.getQueryData<ListFavoritesDto>(favoritesKey)!.items;
    expect(items).toHaveLength(1); // row still present
    expect(items[0]?.unread_count).toBe(0);
  });

  it('is idempotent', () => {
    seed([favRow('c-1', 1)]);
    const before = qc.getQueryData(favoritesKey);
    expect(patchFavoritesUnread(qc, payload())).toBe('unchanged');
    expect(qc.getQueryData(favoritesKey)).toBe(before);
  });
});

describe('ingestViewerUnreadFrame — routing + single-dispatch fan-out', () => {
  const byConvKey = messageUnreadByConversationKey('w-1', 'regular');
  function seedAll(): void {
    qc.setQueryData<MessageUnreadByConversationDto>(byConvKey, {
      by_conversation: { 'c-1': 1 },
      latest_by_conversation: { 'c-1': pointer('m-1', 10) },
      total: 1,
    });
    qc.setQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey, {
      by_workspace: { 'w-1': 1 },
    });
    qc.setQueryData<ListFavoritesDto>(favoritesKey, {
      items: [favRow('c-1', 1)],
      viewer_sort: emptyViewerSort,
    });
  }

  it('ignores non-event / non-unread_updated / foreign-scope frames', () => {
    seedAll();
    const before = qc.getQueryData(byConvKey);
    ingestViewerUnreadFrame(qc, {
      type: 'snapshot_required',
      scope: 'viewer:u-1',
      epoch: 1,
      reason: 'epoch',
      currentSeq: decodeMessageSeq(1),
    } as unknown as ServerFrame);
    ingestViewerUnreadFrame(qc, frame({ kind: 'notification' }));
    ingestViewerUnreadFrame(qc, frame({ scope: 'viewer:someone-else' }));
    expect(qc.getQueryData(byConvKey)).toBe(before); // nothing touched
  });

  it('ignores the BADGE variant (no conversation_id) — not this dispatcher’s frame', () => {
    seedAll();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const before = qc.getQueryData(byConvKey);
    ingestViewerUnreadFrame(qc, frame({ payload: {} }));
    expect(qc.getQueryData(byConvKey)).toBe(before); // no patch
    expect(spy).not.toHaveBeenCalled(); // and no fallback invalidate
    spy.mockRestore();
  });

  it('patches ALL THREE caches from ONE validated frame (single dispatch)', () => {
    seedAll();
    ingestViewerUnreadFrame(
      qc,
      frame({ payload: payload({ conversation_unread_count: 5, workspace_unread_count: 8, latest_unread: pointer('m-9', 90) }) }),
    );
    expect(qc.getQueryData<MessageUnreadByConversationDto>(byConvKey)!.by_conversation['c-1']).toBe(5);
    expect(qc.getQueryData<MessageUnreadByConversationDto>(byConvKey)!.total).toBe(8);
    expect(qc.getQueryData<MessageUnreadSummaryDto>(messageUnreadSummaryKey)!.by_workspace['w-1']).toBe(8);
    // The favorites row takes the CONVERSATION count (5), while the two
    // workspace-scoped caches take the roll-up (8) — one frame, three different
    // correct values.
    expect(
      qc.getQueryData<ListFavoritesDto>(favoritesKey)!.items[0]?.unread_count,
    ).toBe(5);
  });

  it('falls back to invalidate on a legacy/malformed message variant (missing counts)', () => {
    seedAll();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    // Has conversation_id (message variant) but lacks the enriched absolute fields.
    ingestViewerUnreadFrame(qc, frame({ payload: { conversation_id: 'c-1' } }));
    // The favorites fallback invalidate fires immediately; the message-unread one
    // is debounced but still routed through invalidateQueries eventually. Assert
    // the favorites fallback (synchronous) here.
    expect(
      spy.mock.calls.some(([arg]) => arg?.queryKey === favoritesKey),
    ).toBe(true);
    spy.mockRestore();
  });
});
