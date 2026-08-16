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
import type { Database as Db } from 'better-sqlite3';
import {
  apiPaths,
  directPairEndpointsOf,
  directPairIsReadOnlyForSurvivor,
  principalAvatarUrl,
  type ConversationEndpointCoordinate,
  type ConversationEndpointIdentity,
  type DirectPairCounterpart,
  type DirectPairListItem,
  type DirectPairListResponse,
  type RuntimeKind,
} from '@silverhand/shared';
import { AgentRepo } from '../repos/agent-repo.js';
import { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import {
  ConversationRepo,
  type DirectPairListRow,
} from '../repos/conversation-repo.js';
import { UserRepo } from '../repos/user-repo.js';

export interface ListDirectPairsParams {
  viewerUserId: string;
}

/** The CURRENT display identity of a live principal named by an endpoint — the
 *  fields both counterpart arms carry. `runtime` is non-null exactly for an
 *  agent (`agents.runtime` is NOT NULL; a person has none), which is what makes
 *  the two active arms of {@link DirectPairCounterpart} constructable without a
 *  second kind test. Deliberately NOT a snapshot: an endpoint stores no name, so
 *  there is nothing to fall back to and nothing to go stale. */
interface LivePrincipal {
  name: string;
  display_name: string;
  avatar_url: string | null;
  runtime: RuntimeKind | null;
}

/**
 * Project the viewer's Direct Messages list. Pure read.
 *
 * Per row: the counterpart's identity (resolved HERE, in TypeScript, never as a
 * slot `CASE` in SQL — which slot the viewer occupies follows from the canonical
 * endpoint order, and a `CASE` would be a second place that order is spelled),
 * the same unread roll-up a channel badge shows, and the survivor read-only
 * state. Order is the enumeration's: creation order, oldest first — see
 * `DIRECT_PAIRS_FOR_VIEWER_SQL` for why "last activity" is not available to any
 * conversation list today.
 *
 * Principal lookups are point reads, memoized per (kind, id) across the list:
 * the viewer's OWN endpoint repeats on every row (it is the reason the row is
 * here), and both endpoints must be resolved anyway because `read_only` is a
 * property of the conversation rather than of the counterpart. The number of
 * lookups is therefore bounded by the distinct principals the viewer has lines
 * with, not by the row count.
 */
export function listDirectPairs(
  db: Db,
  params: ListDirectPairsParams,
): DirectPairListResponse {
  const { viewerUserId } = params;
  const rows = new ConversationRepo(db).listDirectPairsForViewer(viewerUserId);
  if (rows.length === 0) return { direct_pairs: [] };

  const agents = new AgentRepo(db);
  const users = new UserRepo(db);
  const reads = new ConversationReadRepo(db);

  // Memoized principal resolution. `undefined` = not looked up yet; `null` = a
  // lookup MISS, which is the authoritative form of "gone" (the stamp is only a
  // cheap early answer, and a delete path that forgot to stamp must not hand the
  // survivor a live row — see `directPairIsReadOnlyForSurvivor`).
  const resolved = new Map<string, LivePrincipal | null>();
  const resolve = (endpoint: ConversationEndpointIdentity): LivePrincipal | null => {
    const key = `${endpoint.kind}:${endpoint.id}`;
    const cached = resolved.get(key);
    if (cached !== undefined) return cached;
    const principal = lookupPrincipal(agents, users, endpoint);
    resolved.set(key, principal);
    return principal;
  };
  const exists = (endpoint: ConversationEndpointIdentity): boolean =>
    resolve(endpoint) !== null;

  const direct_pairs: DirectPairListItem[] = rows.map(row => ({
    conversation_id: row.id,
    counterpart: counterpartOf(row, viewerUserId, resolve),
    unread_count: reads.unreadCountForConversation(row.id, viewerUserId),
    read_only: directPairIsReadOnlyForSurvivor(row, exists),
    created_at: row.created_at,
  }));
  return { direct_pairs };
}

function lookupPrincipal(
  agents: AgentRepo,
  users: UserRepo,
  endpoint: ConversationEndpointIdentity,
): LivePrincipal | null {
  if (endpoint.kind === 'agent') {
    const agent = agents.get(endpoint.id);
    // AgentDto already derives `avatar_url` the one shared way, so the agent arm
    // adds no spelling of its own.
    return agent === null
      ? null
      : {
          name: agent.name,
          display_name: agent.display_name,
          avatar_url: agent.avatar_url,
          runtime: agent.runtime,
        };
  }
  const user = users.get(endpoint.id);
  return user === null
    ? null
    : {
        name: user.name,
        display_name: user.display_name,
        avatar_url: principalAvatarUrl(
          apiPaths.userAvatar(user.id),
          user.avatar_storage_key,
          user.updated_at,
        ),
        // A person has no runtime; the human arm pins null.
        runtime: null,
      };
}

/**
 * The endpoint that is NOT the viewer, resolved into the wire value object.
 *
 * The viewer is a `human` endpoint by construction (the enumeration selects rows
 * where they are one), and the two coordinates of a pair are distinct by the
 * v73 arc CHECK, so exactly one endpoint is the other side. A row where neither
 * endpoint is the viewer cannot come from this query, and drawing SOMEONE ELSE's
 * line in the viewer's sidebar is the one failure this face must never produce —
 * so it throws instead of guessing a side or silently dropping the row.
 */
function counterpartOf(
  row: DirectPairListRow,
  viewerUserId: string,
  resolve: (endpoint: ConversationEndpointIdentity) => LivePrincipal | null,
): DirectPairCounterpart {
  const endpoints = directPairEndpointsOf(row);
  if (endpoints === null) {
    throw new Error(
      `conversation ${row.id} is not a direct_pair: the direct-pair enumeration cannot produce this row`,
    );
  }
  const other = endpoints.find(
    endpoint => !(endpoint.kind === 'human' && endpoint.id === viewerUserId),
  );
  if (other === undefined) {
    throw new Error(
      `direct_pair ${row.id} names no endpoint other than viewer ${viewerUserId}: the arc CHECK forbids equal endpoints`,
    );
  }
  return counterpartDto(other, resolve(other));
}

function counterpartDto(
  endpoint: ConversationEndpointCoordinate,
  principal: LivePrincipal | null,
): DirectPairCounterpart {
  // Gone if the stamp says so OR the lookup missed — the same disjunction the
  // write gate uses, so the row's `read_only` and its counterpart `status` can
  // never disagree about whether the other side is still there.
  if (endpoint.deletedAt !== null || principal === null) {
    return { status: 'deleted', kind: endpoint.kind, id: endpoint.id };
  }
  if (endpoint.kind === 'agent') {
    if (principal.runtime === null) {
      // `agents.runtime` is NOT NULL, so this is a loader/consistency fault
      // rather than a state. Fail closed to `deleted` — the same choice
      // `resolveMessageAuthor` makes for an active actor with no runtime:
      // never fabricate a runtime, and never crash a read path.
      return { status: 'deleted', kind: 'agent', id: endpoint.id };
    }
    return {
      status: 'active',
      kind: 'agent',
      id: endpoint.id,
      name: principal.name,
      display_name: principal.display_name,
      avatar_url: principal.avatar_url,
      runtime: principal.runtime,
    };
  }
  return {
    status: 'active',
    kind: 'human',
    id: endpoint.id,
    name: principal.name,
    display_name: principal.display_name,
    avatar_url: principal.avatar_url,
    runtime: null,
  };
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
