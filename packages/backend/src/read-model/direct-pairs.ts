// Read-model for the viewer's Direct Messages list — `GET /api/direct-pairs`
// (#task:2035). A `direct_pair` conversation has NO workspace coordinate, so it
// can never ride the per-workspace channel list: there is no `:id` it belongs
// to. That is not a routing inconvenience, it is the placement's definition
// (docs/agent-scoped-session-v1.md §4), and it is why this list is a face of its
// own, viewer-scoped and workspace-free.
//
// MEMBERSHIP is the transpose of participation: fix the principal, produce the
// conversations. The enumeration itself lives in the single placement authority
// (`DIRECT_PAIR_IDS_FOR_USER_SQL` → `ConversationRepo.listDirectPairsForViewer`),
// so this module never re-states which slot a person may occupy. It holds EXISTING
// pairs only (@shiki's ruling): an agent the viewer has never messaged does not
// appear, because the entry point for opening a new line is the agent's own page.
//
// A gone counterpart does NOT remove the row. Endpoint coordinates outlive their
// principals (v73 stamps `endpoint_*_deleted_at` from a BEFORE DELETE trigger),
// and the pair stays the survivor's pair — readable, unpostable. So "deleted" is
// a STATE of the counterpart here, and `read_only` is derived from the endpoints
// through the one shared definition rather than stored.
//
// Nothing here writes, and nothing here decides authority: the ACL that admits
// the viewer to a pair is the same placement authority the enumeration came from,
// and the authoritative refusal to post lives on the send path. This projection
// only says what the viewer's open lines are and how they should be drawn.
//
// COMPLETE SET (#task:2038): this projection returns EVERY pair the viewer is an
// endpoint of — it takes no limit/offset/cursor and the enumeration SQL carries
// none. That is a named contract of the read face
// (`DirectPairListResponseSchema`), not an implementation detail, because it is
// the only face that can resolve a private line's identity: `ConversationRef` is
// the workspace arm only, so a `#conv:<pair>` miss is read as "not an endpoint".
// Do not add pagination here — a truncating list would make that inference
// silently wrong. `tests/routes/direct-pairs.test.ts` asserts it both
// behaviourally and against the SQL text.
import type { Database as Db } from 'better-sqlite3';
import {
  directPairIsReadOnlyForSurvivor,
  type DirectPairListItem,
  type DirectPairListResponse,
} from '@silverhand/shared';
import { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { createPrincipalResolver, resolveCounterpart } from './direct-pair-counterpart.js';

export interface ListDirectPairsParams {
  viewerUserId: string;
}

/**
 * Project the viewer's Direct Messages list. Pure read.
 *
 * Per row: the counterpart's identity (resolved by the shared
 * {@link resolveCounterpart} — which slot the viewer occupies follows from the
 * canonical endpoint order, owned in ONE place so no reader re-spells it), the
 * same unread roll-up a channel badge shows, and the survivor read-only state.
 * Order is the enumeration's: creation order, oldest first — see
 * `DIRECT_PAIRS_FOR_VIEWER_SQL` for why "last activity" is not available to any
 * conversation list today.
 *
 * The principal resolver is memoized per (kind, id): the viewer's OWN endpoint
 * repeats on every row (it is the reason the row is here), and both endpoints
 * must be resolved anyway because `read_only` is a property of the conversation
 * rather than of the counterpart.
 */
export function listDirectPairs(
  db: Db,
  params: ListDirectPairsParams,
): DirectPairListResponse {
  const { viewerUserId } = params;
  const rows = new ConversationRepo(db).listDirectPairsForViewer(viewerUserId);
  if (rows.length === 0) return { direct_pairs: [] };

  const reads = new ConversationReadRepo(db);
  const { resolve, exists } = createPrincipalResolver(db);
  // The viewer is a `human` endpoint by construction (the enumeration selects
  // rows where they are one); the counterpart is the OTHER side.
  const reference = { kind: 'human' as const, id: viewerUserId };

  const direct_pairs: DirectPairListItem[] = rows.map(row => ({
    conversation_id: row.id,
    counterpart: resolveCounterpart(row, reference, resolve),
    unread_count: reads.unreadCountForConversation(row.id, viewerUserId),
    read_only: directPairIsReadOnlyForSurvivor(row, exists),
    created_at: row.created_at,
  }));
  return { direct_pairs };
}

/**
 * The direct-pairs read surface a caller receives, handle already bound
 * (#task:1983 W2). Route modules declare THIS in their deps.
 */
export interface DirectPairsReadModel {
  readonly list: (params: ListDirectPairsParams) => DirectPairListResponse;
}

export function createDirectPairsReadModel(db: Db): DirectPairsReadModel {
  return { list: params => listDirectPairs(db, params) };
}
