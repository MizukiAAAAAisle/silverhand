import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiPaths, type ConversationRef } from '@silverhand/shared';
import { ApiError, api } from '@/lib/api';
import { logRefHoverDebug } from '@/lib/refHoverDebug';

export type ConversationByIdStatus =
  | 'loading'
  | 'resolved'
  | 'unauthorized'
  | 'not_found';

export interface ConversationByIdResult {
  status: ConversationByIdStatus;
  /** Present iff `status === 'resolved'`. */
  ref: ConversationRef | null;
}

interface ConversationRefResponse {
  ref: ConversationRef;
}

const REF_GC_MS = 5 * 60 * 1000;
const REF_STALE_MS = 30 * 1000;

const conversationRefKey = (id: string) =>
  ['conversation-ref', id] as const;

/**
 * Pure mapping from a React Query result for the conversation-ref
 * fetch into the four-state ConversationByIdResult exposed to the
 * UI. Extracted so the status mapping is unit-testable without a
 * QueryClient + renderHook setup.
 *
 * Other (non-403/404) errors fall through to `loading`. The hook's
 * `retry` policy keeps trying those, so `loading` is the honest
 * status; surfacing "error" would force a fourth UI branch the
 * design explicitly rejects.
 */
export function mapConversationByIdResult(
  id: string | null,
  query: Pick<
    UseQueryResult<ConversationRefResponse, Error>,
    'data' | 'error' | 'isError'
  >,
): ConversationByIdResult {
  if (!id) return { status: 'loading', ref: null };
  if (query.isError) {
    const err = query.error;
    if (err instanceof ApiError) {
      if (err.status === 404) return { status: 'not_found', ref: null };
      if (err.status === 403) return { status: 'unauthorized', ref: null };
    }
    return { status: 'loading', ref: null };
  }
  if (query.data) return { status: 'resolved', ref: query.data.ref };
  return { status: 'loading', ref: null };
}

/**
 * Resolve a conversation by id (channel / dm_channel / thread) so the
 * secondary pane can render a conversation that lives in a different
 * workspace than the primary pane.
 *
 * Status mapping (see `mapConversationByIdResult`):
 *   - `loading`      → React Query is still fetching (initial load)
 *                       OR `id === null` OR a non-403/404 error is
 *                       being retried.
 *   - `resolved`     → 200, `ref` populated.
 *   - `not_found`    → 404 from the backend (conversation doesn't
 *                       exist or has been hard-deleted).
 *   - `unauthorized` → 403 from the backend (caller can't see this
 *                       workspace). v1 user permission model never
 *                       returns 403, but we map it here so the
 *                       backend stays the source of truth.
 */
export function useConversationById(
  id: string | null,
): ConversationByIdResult {
  const query = useQuery<ConversationRefResponse, Error>({
    queryKey: id ? conversationRefKey(id) : ['conversation-ref', 'none'],
    enabled: !!id,
    staleTime: REF_STALE_MS,
    gcTime: REF_GC_MS,
    queryFn: async () => {
      logRefHoverDebug('conversation-query:start', { id });
      try {
        const res = await api<ConversationRefResponse>(
          apiPaths.conversationRef(id!),
        );
        logRefHoverDebug('conversation-query:success', {
          id,
          kind: res.ref.kind,
          workspaceId: res.ref.workspace_id,
        });
        return res;
      } catch (err) {
        logRefHoverDebug('conversation-query:error', {
          id,
          status: err instanceof ApiError ? err.status : null,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    // Don't auto-retry 403/404 — they are terminal states for this hook.
    retry: (failureCount, err) => {
      if (err instanceof ApiError) {
        if (err.status === 403 || err.status === 404) return false;
      }
      return failureCount < 2;
    },
  });

  return mapConversationByIdResult(id, query);
}
