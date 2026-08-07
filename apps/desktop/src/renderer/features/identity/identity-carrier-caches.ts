import type { QueryClient } from '@tanstack/react-query';
import { activityKey } from '@/features/attention/hooks';
import { messageReactorsKeyPrefix } from '@/features/channels/reaction-hooks';
import { CONVERSATION_MEMBERS_KEY_PREFIX } from '@/features/conversations/useConversationMembers';
import { favoritesKey } from '@/features/favorites/hooks';
import { hostResourcesKeyPrefix, hostStatusKeyPrefix } from '@/features/hosts/hooks';
import { savedKey } from '@/features/saved/hooks';
import { searchKey } from '@/features/search/hooks';
import { usersKey } from '@/features/users/hooks';
import { isWorkspaceMembersQueryKey } from '@/features/workspaces/hooks';

/**
 * The channel-scoped read models whose cached rows now embed a send-time
 * {@link MessageAuthorDto} snapshot (`display_name` + the `?v=updated_at` avatar
 * url), so a rename / avatar change / hard-delete must reseat them (#task:1792):
 *   - `['channels', cid, 'messages']`            mainline window (+ its inline
 *                                                `reply_previews_by_root` authors)
 *   - `['channels', cid, 'cluster', root, …]`    one reply cluster's window
 *   - `['channels', cid, 'thread-root', root]`   the thread pane's root row
 *   - `['channels', cid, 'threads-list', …]`     Threads All + followed-unread
 *                                                (root_author + repliers)
 *   - `['channels', cid, 'attachments-list', …]` attachment source author
 *
 * A structural match rather than a factory import because the channel families
 * vary by `cid` (no static left-anchored prefix reaches them). The boundary
 * test builds every key from its real factory (`messagesKey` / `clusterMessagesKey`
 * / `threadRootKey` / `channelThreadsKey` / `channelAttachmentsKey`), so a segment
 * rename fails the test instead of silently dropping a family. The cluster arm
 * matches only its `…, root, 'messages'` window, NOT the `fetch-epoch` / `live-gap`
 * siblings that share the `'cluster'` segment; other non-author channel caches
 * (`agents` / `thread-followers` / mainline `live-gap`) carry no snapshot.
 */
export function isChannelAuthorCarrierKey(key: readonly unknown[]): boolean {
  if (key[0] !== 'channels') return false;
  const family = key[2];
  // The cluster window is `['channels', cid, 'cluster', rootId, 'messages']`;
  // its `fetch-epoch` / `live-gap` siblings share the `'cluster'` segment but
  // carry no author, so gate on the trailing `'messages'`.
  if (family === 'cluster') return key[4] === 'messages';
  return (
    family === 'messages' ||
    family === 'thread-root' ||
    family === 'threads-list' ||
    family === 'attachments-list'
  );
}

/**
 * Whose profile changed. The two actor kinds are isomorphic in the domain but
 * NOT in what they stale: an agent's `display_name` is denormalized into host
 * status and DM favorites, a human's into the user directory, and both into
 * every roster / Activity / reaction / task read model.
 */
export type IdentitySubjectKind = 'agent' | 'human';

/** The filter shape `QueryClient.invalidateQueries` accepts. */
type InvalidateFilter = NonNullable<
  Parameters<QueryClient['invalidateQueries']>[0]
>;

interface IdentityCarrier {
  /** Stable slug — the review handle for "is this carrier covered?". */
  id: string;
  /** Which subject kinds' profile writes can stale this cache. Scoping is the
   *  point of the registry: a human avatar change must not refetch host status
   *  or DM favorites, and an agent rename must not refetch the human
   *  directory (Cindy #task:1703 boundary). */
  kinds: readonly IdentitySubjectKind[];
  filter: InvalidateFilter;
}

/**
 * Every renderer cache that carries a DENORMALIZED identity snapshot
 * (`display_name` / `avatar_url` resolved server-side into someone else's read
 * model), grouped by whose profile can stale it.
 *
 * Why a registry instead of per-consumer invalidation: the actor-scoped signals
 * (`agent_changed`, and #task:1702's user-profile event) carry only an id.
 * These caches are keyed by conversation / workspace / host / message — never
 * by the actor — so no key prefix derived from the event can reach them. The
 * enumeration IS the contract; a new read model that embeds a name or an avatar
 * belongs here, in the group matching whose name it embeds.
 *
 * Invalidate, never patch: the identity fields are backend-derived (the avatar
 * `?v=updated_at` cache-buster among them), so re-reading is the only honest
 * convergence. Inactive queries are just marked stale — they refetch on next
 * mount — so a broad prefix costs nothing while the surface is closed.
 *
 * Deliberately NOT here:
 *   - `['me']` — the viewer's own record is IPC-backed (`getAuthState()`), and
 *     main answers from its in-memory session snapshot, so invalidation replays
 *     the same stale dto. The self arm needs a fresh `GET /api/me` (which also
 *     reseats main's snapshot on its way through the proxy —
 *     `main/profile-session-sync.ts`). Local writes already reseat both
 *     (#task:1701); only a REMOTE edit needs that read (#task:1702).
 *   - `SavedMessageDto.agent_name` / `SearchResultDto.agent_name` — the backend
 *     joins the IMMUTABLE `@handle` (`a.name`), not `display_name`, so that
 *     field alone cannot stale. (The rows STILL carry a mutable `message.author`
 *     snapshot, so Saved / Search are registered below via their message payload,
 *     not this handle.)
 *   - history `system_message` metadata and notification `trigger_name` —
 *     event-time snapshots by design; they must keep reading as of the event.
 */
const IDENTITY_CARRIERS: readonly IdentityCarrier[] = [
  // ── both kinds ────────────────────────────────────────────────────────────
  {
    // `AgentMemberDto` / `HumanMemberDto` both embed name + avatar; every
    // cached roster, not just the visible channel's (#task:1701).
    id: 'conversation-members',
    kinds: ['agent', 'human'],
    filter: { queryKey: CONVERSATION_MEMBERS_KEY_PREFIX },
  },
  {
    // `WorkspaceMembersResponse` = AgentDto[] + WorkspaceHumanMemberDto[]
    // (a UserDto extension), cached per workspace.
    id: 'workspace-members',
    kinds: ['agent', 'human'],
    filter: { predicate: q => isWorkspaceMembersQueryKey(q.queryKey) },
  },
  {
    // `ActivityPreviewSender{kind,id,display_name,avatar_url}` — resolved
    // server-side by design (the list is cross-workspace, so the renderer has
    // no directory that covers every sender).
    id: 'activity',
    kinds: ['agent', 'human'],
    filter: { queryKey: activityKey() },
  },
  {
    // Every channel-scoped read model that embeds a `MessageAuthorDto` snapshot
    // (see {@link isChannelAuthorCarrierKey}): mainline + reply previews, reply
    // clusters, the thread-pane root row, the Threads list, and the attachments
    // list. The snapshot outlives the actor (`author_id` has no FK), so a rename
    // / avatar / hard-delete only reflects on these cached authors by refetch.
    id: 'channel-author-projections',
    kinds: ['agent', 'human'],
    filter: { predicate: q => isChannelAuthorCarrierKey(q.queryKey) },
  },
  {
    // `SavedMessageDto.message.author` — the saved row embeds the whole message,
    // so it carries the same mutable author snapshot as the byline. (Its own
    // `agent_name` is the immutable @handle; the mutable part is the author dto.)
    id: 'saved',
    kinds: ['agent', 'human'],
    filter: { queryKey: savedKey },
  },
  {
    // `SearchResultDto.message.author` — a message hit embeds the full message,
    // hence the same author snapshot. Workspace-global key, so a plain prefix.
    id: 'search',
    kinds: ['agent', 'human'],
    filter: { queryKey: searchKey },
  },
  {
    // `ReactionReactorDto.display_name`. Fetched only while a chip is hovered,
    // but with `staleTime: 10_000` a reopen inside that window replays the old
    // name. Not re-resolved by id: reactors can include actors outside the
    // viewer's own directories, and the server join is the only complete
    // source.
    id: 'message-reactors',
    kinds: ['agent', 'human'],
    filter: { queryKey: messageReactorsKeyPrefix },
  },
  // Task DTOs carry THREE identity snapshots — `assignee.name`, `creator.name`
  // and `last_editor.name` in the detail. All three are live joins re-resolved on
  // read, so invalidating the task caches converges them together; re-resolving
  // only the assignee by id would leave two freshness classes inside one dto
  // (Cindy #task:1703).
  //
  // `['tasks']` is the ROOT, so this one entry covers all three board faces —
  // column pages, counts, facets. It got MORE load-bearing when the board became
  // the only task read (#task:1885/#task:1892): the person filter options are now
  // a server facet read that carries its own `name` snapshots, where they used to
  // be aggregated client-side off the rows in hand.
  { id: 'task-lists', kinds: ['agent', 'human'], filter: { queryKey: ['tasks'] } },
  { id: 'task-detail', kinds: ['agent', 'human'], filter: { queryKey: ['task-detail'] } },
  {
    id: 'task-by-number',
    kinds: ['agent', 'human'],
    filter: { queryKey: ['task-by-number'] },
  },

  // ── agent-only ────────────────────────────────────────────────────────────
  {
    // The agent directory + every per-agent detail subtree. Avatars come along
    // for free: the object-url effect keys on the `?v=updated_at` url.
    id: 'agents',
    kinds: ['agent'],
    filter: { queryKey: ['agents'] },
  },
  {
    // A DM favorite row IS an agent identity snapshot: `read-model/favorites.ts`
    // joins `agents.display_name / avatar_storage_key / runtime / updated_at`
    // into `title` / `icon_url` / `runtime`, and `FavoritesPanel` renders those
    // fields directly instead of re-resolving by id (Cindy #task:1703).
    id: 'favorites',
    kinds: ['agent'],
    filter: { queryKey: favoritesKey },
  },
  {
    // `AgentOnHostDto.display_name` in each computer's status snapshot.
    id: 'host-status',
    kinds: ['agent'],
    filter: { queryKey: hostStatusKeyPrefix },
  },
  {
    // `HostAgentResource.display_name` in each computer's ownership list.
    // `HostDto` itself carries no agent identity, so `['hosts']` / `['host',id]`
    // are intentionally absent.
    id: 'host-resources',
    kinds: ['agent'],
    filter: { queryKey: hostResourcesKeyPrefix },
  },

  // ── human-only ────────────────────────────────────────────────────────────
  {
    // The global human directory. Also the resolver behind chat authors,
    // mention chips and sender filters, so this one entry converges every
    // surface that resolves humans by id.
    id: 'users',
    kinds: ['human'],
    filter: { queryKey: usersKey },
  },
];

/** Carrier slugs that apply to one subject kind. Exported for the boundary
 *  test — the registry's value is its scoping, so that is what gets pinned. */
export function identityCarrierIdsFor(
  kind: IdentitySubjectKind,
): readonly string[] {
  return IDENTITY_CARRIERS.filter(c => c.kinds.includes(kind)).map(c => c.id);
}

/**
 * Reseat every denormalized copy of one actor kind's identity.
 *
 * Called from the WS consumers that own each axis — `useAgentSync` for
 * `agent_changed`, and #task:1702's user-profile consumer for the human axis —
 * so both axes share one enumeration and neither pays for the other's caches.
 */
export function invalidateIdentityCarrierCaches(
  qc: QueryClient,
  kind: IdentitySubjectKind,
): void {
  for (const carrier of IDENTITY_CARRIERS) {
    if (!carrier.kinds.includes(kind)) continue;
    void qc.invalidateQueries(carrier.filter);
  }
}
