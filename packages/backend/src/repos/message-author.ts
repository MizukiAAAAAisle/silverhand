import type { Database as Db } from 'better-sqlite3';
import {
  apiPaths,
  resolveMessageAuthor,
  type MessageAuthorDto,
  type MessageAuthorLiveActor,
  type MessageAuthorRow,
  type RuntimeKind,
} from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';

/** The columns the resolver needs from a LIVE `agents`/`users` row to build an
 *  `active` author. `avatar_url` is derived here from the SAME relative,
 *  cache-busted API URL as AgentDto/UserDto (never a storage key on the wire).
 *  `runtime` is the agent's current runtime (agents.runtime, NOT NULL); the
 *  users query selects `NULL AS runtime`, so a user actor carries null. */
interface LiveActorRow {
  id: string;
  name: string;
  display_name: string;
  avatar_storage_key: string | null;
  updated_at: number;
  runtime: RuntimeKind | null;
}

function liveActorFrom(
  row: LiveActorRow,
  avatarPath: (id: string) => string,
): MessageAuthorLiveActor {
  return {
    name: row.name,
    display_name: row.display_name,
    avatar_url: row.avatar_storage_key
      ? `${avatarPath(row.id)}?v=${row.updated_at}`
      : null,
    runtime: row.runtime,
  };
}

// A stable prepared-statement source (json_each keeps the SQL text constant for
// any id-set size, so the observed-statement cache is not blown by an inline
// IN-list). Mirrors the json_each pattern already used in activity/attachment.
// The agents query carries `runtime` (feeds the active-agent arm); the users
// query pins `NULL AS runtime` (a user actor has none), so LiveActorRow is one
// shape across both kinds.
const LIVE_AGENTS_SQL =
  `SELECT id, name, display_name, avatar_storage_key, updated_at, runtime FROM agents
     WHERE id IN (SELECT value FROM json_each(?))`;
const LIVE_USERS_SQL =
  `SELECT id, name, display_name, avatar_storage_key, updated_at, NULL AS runtime FROM users
     WHERE id IN (SELECT value FROM json_each(?))`;

function fetchLiveActors(
  db: Db,
  queryName: string,
  source: string,
  ids: Set<string>,
  avatarPath: (id: string) => string,
): Map<string, MessageAuthorLiveActor> {
  const map = new Map<string, MessageAuthorLiveActor>();
  if (ids.size === 0) return map;
  const rows = prepareObserved<[string], LiveActorRow>(db, queryName, source)
    .all(JSON.stringify([...ids]));
  for (const row of rows) map.set(row.id, liveActorFrom(row, avatarPath));
  return map;
}

/** Batch-resolve `MessageAuthorDto` for a set of author-bearing rows in two
 *  queries (one per actor kind), then discriminate active/deleted/unresolved
 *  per row via the pure {@link resolveMessageAuthor}. Returned map is keyed by
 *  the row reference the caller passed, so it composes with `rows.map(...)`.
 *  Use this for every list/window read; see {@link resolveOneMessageAuthor} for
 *  point reads / fresh inserts. */
export function loadMessageAuthors<T extends MessageAuthorRow>(
  db: Db,
  rows: readonly T[],
): Map<T, MessageAuthorDto | null> {
  const agentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.from_kind === 'agent' && row.from_agent_id !== null) {
      agentIds.add(row.from_agent_id);
    } else if (row.from_kind === 'user' && row.from_user_id !== null) {
      userIds.add(row.from_user_id);
    }
  }
  const agents = fetchLiveActors(
    db, 'messages.author_live_agents', LIVE_AGENTS_SQL, agentIds, apiPaths.agentAvatar,
  );
  const users = fetchLiveActors(
    db, 'messages.author_live_users', LIVE_USERS_SQL, userIds, apiPaths.userAvatar,
  );
  const out = new Map<T, MessageAuthorDto | null>();
  for (const row of rows) {
    const live =
      row.from_kind === 'agent'
        ? (row.from_agent_id !== null ? agents.get(row.from_agent_id) ?? null : null)
        : row.from_kind === 'user'
          ? (row.from_user_id !== null ? users.get(row.from_user_id) ?? null : null)
          : null;
    out.set(row, resolveMessageAuthor(row, live));
  }
  return out;
}

/** Resolve a single author-bearing row (point read / freshly-inserted message).
 *  A one-row lookup of the live actor is enough; lists must use
 *  {@link loadMessageAuthors} to stay at two queries total. */
export function resolveOneMessageAuthor(
  db: Db,
  row: MessageAuthorRow,
): MessageAuthorDto | null {
  return loadMessageAuthors(db, [row]).get(row) ?? null;
}
