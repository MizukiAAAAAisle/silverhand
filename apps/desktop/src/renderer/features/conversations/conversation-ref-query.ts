import { apiPaths, type ConversationRef } from '@silverhand/shared';
import { api } from '@/lib/api';
import { recordChannelWorkspace } from '@/features/channels/channel-workspace-index';

export interface ConversationRefResponse {
  ref: ConversationRef;
}

const REF_GC_MS = 5 * 60 * 1000;
const REF_STALE_MS = 30 * 1000;

/** NOT exported, deliberately. A key factory that leaves this module is a hole in
 *  the fences below: `setQueryData(conversationRefQueryKey(id), …)` mentions
 *  neither `apiPaths.conversationRef` nor the raw key literal, so it would fill
 *  this cache with no write-through and every scan would stay green. Consumers
 *  take the options; nobody needs the key alone. */
const conversationRefQueryKey = (id: string) =>
  ['conversation-ref', id] as const;

/**
 * THE conversation-ref read point (#task:1689).
 *
 * WHY IT IS SINGULAR. `GET /conversations/:id/ref` is the only carrier that
 * states a cross-workspace conversation's workspace, so it is where the
 * channel → workspace attribution write-through has to happen (see
 * `channel-workspace-index.ts`). A second module that built the same request or
 * fetched the same key on its own would silently produce a cached ref with NO
 * binding recorded — which is exactly the hole that existed while
 * `useConversationById` and the notification jump resolver each fetched it. So
 * the fetcher and the key live here, together, and every consumer spreads these
 * options instead of restating them.
 *
 * Pinned mechanically by `viewer-channel-removal.test.ts`, scanning the whole
 * renderer `src/**` (a producer may live outside `features/**`): this module must
 * be the ONLY non-test module that mentions `apiPaths.conversationRef` or names
 * the key factory, and any other module mentioning the raw `['conversation-ref',
 * …]` key may only invalidate or remove it, never fill it. That enumeration runs
 * from the request/key side, so a new read point that forgot the write-through
 * goes red instead of going unnoticed.
 */
export function conversationRefQueryOptions(id: string) {
  return {
    queryKey: conversationRefQueryKey(id),
    staleTime: REF_STALE_MS,
    gcTime: REF_GC_MS,
    queryFn: async (): Promise<ConversationRefResponse> => {
      const res = await api<ConversationRefResponse>(apiPaths.conversationRef(id));
      // Attribution write-through: the ref carries identity AND workspace for an
      // id the viewer may hold channel-keyed caches for. `workspace_id` on a
      // conversation is immutable, so this is a permanent identity fact — never
      // a statement about whether the viewer may still see the channel.
      recordChannelWorkspace(res.ref.id, res.ref.workspace_id);
      return res;
    },
  };
}
