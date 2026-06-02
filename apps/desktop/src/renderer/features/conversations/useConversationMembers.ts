import { useEffect } from 'react';
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  apiPaths,
  type ConversationMembersResponse,
  type MemberDto,
} from '@silverhand/shared';
import { ApiError, api } from '@/lib/api';
import { onWsFrame, subscribeWsScope } from '@/lib/ws-client';

export type ConversationMembersStatus =
  | 'loading'
  | 'resolved'
  | 'unauthorized'
  | 'not_found';

export interface ConversationMembersResult {
  status: ConversationMembersStatus;
  /** Present iff `status === 'resolved'`. Empty array is a valid resolution. */
  members: MemberDto[];
}

const MEMBERS_GC_MS = 5 * 60 * 1000;
const MEMBERS_STALE_MS = 30 * 1000;

const conversationMembersKey = (id: string) =>
  ['conversation-members', id] as const;

/**
 * Pure mapping from a React Query result into the renderer-facing
 * 4-state shape. Mirrors `mapConversationByIdResult` so the UI never
 * has to branch on raw error fields.
 *
 * Non-403/404 errors fall through to `loading`; the hook's `retry`
 * policy keeps trying those, so `loading` is honest.
 */
export function mapConversationMembersResult(
  id: string | null,
  query: Pick<
    UseQueryResult<ConversationMembersResponse, Error>,
    'data' | 'error' | 'isError'
  >,
): ConversationMembersResult {
  if (!id) return { status: 'loading', members: [] };
  if (query.isError) {
    const err = query.error;
    if (err instanceof ApiError) {
      if (err.status === 404) return { status: 'not_found', members: [] };
      if (err.status === 403) return { status: 'unauthorized', members: [] };
    }
    return { status: 'loading', members: [] };
  }
  if (query.data) return { status: 'resolved', members: query.data.members };
  return { status: 'loading', members: [] };
}

/**
 * Fetch the resolved member list (agents + humans) for a conversation
 * by id. Backs the chat-header member-chip strip (PR-C). Called once
 * per opened conversation; React Query caches per id so channel ↔
 * thread navigation does not refetch within `staleTime`.
 *
 * The backend route is the single source of truth shared with the
 * platform prompt's "Members in this conversation:" block — divergence
 * between what the agent talks about and what the chip strip shows is
 * structurally impossible.
 *
 * Self filtering is the caller's job: the renderer drops the current
 * human viewer (UI-self) by `kind === 'human' && user_id === viewer.id`.
 * This hook does not filter — it returns the full list so other
 * surfaces (popovers, "+N more" overlays) can render every member.
 *
 * Realtime invalidation: subscribes to `conversation:{id}` and
 * invalidates the cache on `conversation_members_changed`. This means
 * the renderer reseats the strip when a member is added by ANY route
 * — the local renderer mutation, an agent's `silverhand member add`,
 * or another window doing the same. `snapshot_required` for the same
 * scope also triggers a refetch (epoch mismatch / replay gap).
 */
export function useConversationMembers(
  id: string | null,
): ConversationMembersResult {
  const qc = useQueryClient();
  const query = useQuery<ConversationMembersResponse, Error>({
    queryKey: id ? conversationMembersKey(id) : ['conversation-members', 'none'],
    enabled: !!id,
    staleTime: MEMBERS_STALE_MS,
    gcTime: MEMBERS_GC_MS,
    queryFn: () =>
      api<ConversationMembersResponse>(apiPaths.conversationMembers(id!)),
    // Don't auto-retry 403/404 — terminal for this hook.
    retry: (failureCount, err) => {
      if (err instanceof ApiError) {
        if (err.status === 403 || err.status === 404) return false;
      }
      return failureCount < 2;
    },
  });

  useEffect(() => {
    if (!id) return;
    const scope = `conversation:${id}`;
    const sub = subscribeWsScope(scope);
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event') {
        if (frame.scope !== scope) return;
        if (frame.kind !== 'conversation_members_changed') return;
        void qc.invalidateQueries({ queryKey: conversationMembersKey(id) });
      } else if (frame.type === 'snapshot_required' && frame.scope === scope) {
        void qc.invalidateQueries({ queryKey: conversationMembersKey(id) });
      }
    });
    return () => {
      unsub();
      sub.unsubscribe();
    };
  }, [id, qc]);

  return mapConversationMembersResult(id, query);
}
