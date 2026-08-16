// The ONE resolver of a `direct_pair`'s COUNTERPART — "the endpoint that is not
// me", turned into the wire value object every list of DM lines draws its rows
// from. Extracted from the viewer's DM list (#task:2035) when a SECOND reader
// appeared: the owner-audit chats list (#task:2036 part ②) enumerates an agent's
// direct_pairs and must name the OTHER side too, but from the AGENT's endpoint
// rather than a human viewer's.
//
// Keeping it in one module is the same discipline `directPairEndpointsOf` states:
// which slot is "the other one" follows from the canonical endpoint order, and a
// second copy of the "not me" test — one per reader — is exactly how one reader
// would silently name the wrong side the day the order gains a kind. The
// reference endpoint is therefore a PARAMETER, not a hard-coded human viewer: the
// DM list passes its human endpoint, the audit list passes the audited agent's.
//
// Nothing here writes and nothing decides authority; it only turns a stored
// endpoint coordinate into the CURRENT display identity of the principal it names
// (or the `deleted` state when that principal is gone).
import type { Database as Db } from 'better-sqlite3';
import {
  apiPaths,
  directPairEndpointsOf,
  principalAvatarUrl,
  type ConversationEndpointCoordinate,
  type ConversationEndpointIdentity,
  type ConversationEndpointRef,
  type DirectPairCounterpart,
  type RuntimeKind,
} from '@silverhand/shared';
import { AgentRepo } from '../repos/agent-repo.js';
import { UserRepo } from '../repos/user-repo.js';

/** The CURRENT display identity of a live principal named by an endpoint — the
 *  fields both counterpart arms carry. `runtime` is non-null exactly for an
 *  agent (`agents.runtime` is NOT NULL; a person has none), which is what makes
 *  the two active arms of {@link DirectPairCounterpart} constructable without a
 *  second kind test. Deliberately NOT a snapshot: an endpoint stores no name, so
 *  there is nothing to fall back to and nothing to go stale. */
export interface LivePrincipal {
  name: string;
  display_name: string;
  avatar_url: string | null;
  runtime: RuntimeKind | null;
}

/** Resolve an endpoint's live principal, or `null` for a MISS — the
 *  authoritative form of "gone" (the stamp is only a cheap early answer; a delete
 *  path that forgot to stamp must not hand a survivor a live row). */
export type PrincipalResolver = (
  endpoint: ConversationEndpointIdentity,
) => LivePrincipal | null;

export interface CounterpartResolution {
  /** Memoized per (kind, id): a reference endpoint repeats on every row, and both
   *  endpoints are resolved anyway because `read_only` is a property of the
   *  conversation, not of the counterpart. Lookups are bounded by the distinct
   *  principals in the list, not by the row count. */
  readonly resolve: PrincipalResolver;
  /** `resolve(...) !== null`, the shape `directPairIsReadOnlyForSurvivor` wants. */
  readonly exists: (endpoint: ConversationEndpointIdentity) => boolean;
}

/** Build a memoized principal resolver over one connection. Point reads only. */
export function createPrincipalResolver(db: Db): CounterpartResolution {
  const agents = new AgentRepo(db);
  const users = new UserRepo(db);
  const resolved = new Map<string, LivePrincipal | null>();
  const resolve: PrincipalResolver = endpoint => {
    const key = `${endpoint.kind}:${endpoint.id}`;
    const cached = resolved.get(key);
    if (cached !== undefined) return cached;
    const principal = lookupPrincipal(agents, users, endpoint);
    resolved.set(key, principal);
    return principal;
  };
  const exists = (endpoint: ConversationEndpointIdentity): boolean =>
    resolve(endpoint) !== null;
  return { resolve, exists };
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
 * The endpoint that is NOT the reference, resolved into the wire value object.
 *
 * The reference is one of the pair's two endpoints by construction (the caller
 * enumerated rows where it IS one), and the two coordinates are distinct by the
 * v73 arc CHECK, so exactly one endpoint is the other side. A row where neither
 * endpoint is the reference cannot come from such an enumeration, and drawing
 * SOMEONE ELSE's line is the one failure a counterpart face must never produce —
 * so it throws instead of guessing a side or silently dropping the row.
 *
 * The fail-loud contract is spelled against the reference EXPLICITLY: exactly one
 * of the two endpoints must equal it. `endpoints.find(e => e !== reference)` would
 * NOT enforce that — when the reference matches NEITHER endpoint it returns the
 * FIRST one, silently naming a stranger as the counterpart. So this counts the
 * matches and takes the other side only when the count is exactly one; both-match
 * (impossible under the arc CHECK) and neither-match (the caller enumerated the
 * wrong rows, or this is now a SECOND reader whose query drifted) collapse to the
 * same throw. The helper does not trust its callers' queries to stay correct.
 */
export function resolveCounterpart(
  row: ConversationEndpointRef & { id: string },
  reference: ConversationEndpointIdentity,
  resolve: PrincipalResolver,
): DirectPairCounterpart {
  const endpoints = directPairEndpointsOf(row);
  if (endpoints === null) {
    throw new Error(
      `conversation ${row.id} is not a direct_pair: a counterpart cannot be resolved for this row`,
    );
  }
  const [a, b] = endpoints;
  const aIsReference = a.kind === reference.kind && a.id === reference.id;
  const bIsReference = b.kind === reference.kind && b.id === reference.id;
  if (aIsReference === bIsReference) {
    // Both true is unrepresentable (the arc CHECK forbids equal endpoints); both
    // false means the reference is not an endpoint of this row at all. Either way
    // there is no well-defined "other side", so refuse rather than guess one.
    throw new Error(
      `direct_pair ${row.id} does not name ${reference.kind}:${reference.id} as exactly one endpoint: a counterpart cannot be resolved against a reference this row does not contain`,
    );
  }
  const other = aIsReference ? b : a;
  return counterpartDto(other, resolve(other));
}

function counterpartDto(
  endpoint: ConversationEndpointCoordinate,
  principal: LivePrincipal | null,
): DirectPairCounterpart {
  // Gone if the stamp says so OR the lookup missed — the same disjunction the
  // write gate uses, so a row's `read_only` and its counterpart `status` can
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
