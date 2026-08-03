// Read-model for the Activity list (#task:1227, docs/activity-lifecycle-v1.md
// §9.2 `listActivity`). Attention is a read-side bounded context: it owns NO
// activity/read/done state. Every item here is projected from an existing
// source — the per-stream cursor read-model (#1226 `conversation_reads` /
// `conversation_stream_heads`) and `notifications` (`read_at`) — and recomputed
// on each read. Dependency direction is one-way: routes → read-model. Nothing
// in this file writes.
//
// NOTE — `kind=task` is intentionally NOT projected in v1. An
// `in_review && member` projection of `messages.task_*` mirrored the task
// panel's In-review column as a permanent, non-eliminable Activity item (its
// only clearance was `task_status`, never observation) — a standing duplicate
// of another bounded context's inventory, the one Activity kind that wasn't a
// read-cleared attention event. Tasks live in the task panel; a task-related
// message still reaches Activity via the mention/unread paths. A task source
// re-enters Activity only when it is event-shaped & notification-backed — a
// `task_needs_review(viewer)` notification with a real reviewer relation,
// read-cleared like a mention (docs/activity-lifecycle-v1.md §5.1, v2).
//
// Assembly (§6/§7/§8):
//   1. directed notifications — `mention_self` + `agent_start_failed` (read_at
//      NULL); a mention whose stream cursor already passed it is treated as
//      cleared (§7: cursor-passed ⇒ directed cleared), no stored state.
//   2. The §7 per-(viewer, message) de-dupe runs in TS: at most one directed
//      claim per message. The DISTINCT set of directed message ids is then
//      excluded from the positional query, so §8 (`positional \ directed`) is
//      computed in SQL — the ambient row's count AND its first-unread
//      anchor/preview/timestamp are the first NON-directed unread message,
//      never a message already shown as a mention. Because the positional base
//      already drops system / the viewer's own messages, a directed message
//      that wouldn't be ambient is simply absent (no spurious subtraction).
//   3. positional streams — per-(conversation, stream) ambient/DM unread,
//      `enter()`-filtered in SQL (DM always; channel mainline iff the viewer's
//      effective ChannelAttentionPreference = 'all'; threads iff followed AND
//      the parent channel's effective ChannelAttentionPreference = 'all' —
//      follow is a delivery precondition, necessary not sufficient, #task:1268).
// Then salience is derived (DM = directed-grade) and the list sorted §13.2:
// directed tier first, most-recent-first within a tier.
import type { BackendContext } from '../context.js';
import { prepareObserved } from '../observability/observed-statement.js';
import {
  apiPaths,
  DEFAULT_CHANNEL_ATTENTION_MODE,
  resolveMessageAuthor,
  type ActivityItemDto,
  type ActivitySalience,
  type ListActivityDto,
  type MessageAuthorDto,
  type MessageAuthorLiveActor,
  type RuntimeKind,
} from '@silverhand/shared';

export interface ListActivityParams {
  viewerUserId: string;
  /** Optional workspace filter. The data model and v1 Activity UI are global,
   *  so the normal caller omits this filter. This param stays as an opt-in
   *  scope for callers that want one workspace; absent = every workspace the
   *  viewer can see. */
  workspaceId?: string;
}

const PREVIEW_MAX = 140;

/**
 * The single lifecycle gate every Activity source composes: an item is visible
 * ONLY while its conversation is live — the row EXISTS and is NOT archived.
 * Defining it once (instead of re-typing `c.archived_at IS NULL` per query) is
 * the structural fix behind #task:1409 — that bug was one assembly path (the
 * directed query) silently missing the filter the other path (positional) had.
 * A new Activity source that references the conversation as `c` interpolates
 * THIS, and `activity-lifecycle-conformance.test.ts` fails the archived/orphan
 * matrix if any source omits it.
 *
 * `c.id IS NOT NULL` is load-bearing only for a LEFT JOIN (the directed query):
 * it drops notifications whose conversation was deleted → `conversation_id` set
 * NULL by `ON DELETE SET NULL`, i.e. orphans. On an INNER JOIN (the positional
 * query) it is a harmless tautology, kept so both sources read ONE predicate.
 */
export const LIVE_CONVERSATION_PREDICATE = `c.id IS NOT NULL AND c.archived_at IS NULL`;

function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return null;
  return compact.length > PREVIEW_MAX
    ? `${compact.slice(0, PREVIEW_MAX - 1)}…`
    : compact;
}

/** Row fields carrying the anchor message's author, server-resolved so the
 *  global list never client-stitches a cross-workspace sender. Carries BOTH the
 *  message's provenance FKs + send-time snapshot (the {@link MessageAuthorRow}
 *  evidence) AND the joined LIVE actor columns, so {@link buildPreviewSender}
 *  can feed the SAME pure {@link resolveMessageAuthor} the message/thread reads
 *  use — a hard-deleted sender resolves to `deleted` (snapshot name) instead of
 *  collapsing to a NULL byline. A `system` anchor or a missing anchor leaves
 *  `from_kind` outside user/agent → NULL author. */
interface SenderColumns {
  from_kind: string | null;
  from_user_id: string | null;
  from_agent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  author_display_name: string | null;
  /** LIVE actor columns (NULL once the FK is nulled by ON DELETE SET NULL). */
  live_name: string | null;
  live_display_name: string | null;
  live_avatar_key: string | null;
  live_updated_at: number | null;
  /** LIVE agent runtime (NULL for a user actor or once the FK is nulled). */
  live_runtime: string | null;
}

/** Build the item's `preview_sender` ({@link MessageAuthorDto}) from the resolved
 *  author columns via the SAME pure resolver every author surface shares. The
 *  live actor (name/display_name/avatar) is passed only when the provenance FK
 *  still resolves; otherwise the resolver falls back to the send-time snapshot
 *  (`deleted`) or, absent one, `unresolved`. `avatar_url` mirrors
 *  `UserDto`/`AgentDto`: the relative avatar path with the `?v=updated_at`
 *  cache-buster, or NULL when the actor has no avatar. */
function buildPreviewSender(row: SenderColumns): MessageAuthorDto | null {
  const fromKind = row.from_kind;
  // system anchor / missing anchor (LEFT JOIN miss → NULL) has no author.
  if (fromKind !== 'user' && fromKind !== 'agent') return null;
  const fkId = fromKind === 'user' ? row.from_user_id : row.from_agent_id;
  const live: MessageAuthorLiveActor | null =
    fkId !== null && row.live_name !== null
      ? {
          name: row.live_name,
          display_name: row.live_display_name ?? row.live_name,
          avatar_url: row.live_avatar_key
            ? `${
                fromKind === 'user'
                  ? apiPaths.userAvatar(fkId)
                  : apiPaths.agentAvatar(fkId)
              }?v=${row.live_updated_at ?? 0}`
            : null,
          // Agent → its current runtime (agents.runtime, NOT NULL); user → null.
          // The DB value is a validated RuntimeKind; the resolver fails closed if
          // an agent's runtime is somehow absent.
          runtime: row.live_runtime as RuntimeKind | null,
        }
      : null;
  return resolveMessageAuthor(
    {
      from_kind: fromKind,
      from_user_id: row.from_user_id,
      from_agent_id: row.from_agent_id,
      author_id: row.author_id,
      author_name: row.author_name,
      author_display_name: row.author_display_name,
    },
    live,
  );
}

/** SQL fragment resolving an anchor message `m`'s author into the
 *  {@link SenderColumns}. Requires `LEFT JOIN users su ON su.id = m.from_user_id`
 *  and `LEFT JOIN agents sa ON sa.id = m.from_agent_id` in the same query. Emits
 *  the message's provenance FKs + send-time snapshot + the joined LIVE actor
 *  columns raw; {@link buildPreviewSender} discriminates active/deleted/unresolved
 *  via the shared resolver (no COALESCE here — the renderer owns display
 *  fallback uniformly across every `MessageAuthorDto` surface). */
const SENDER_SELECT = `
          m.from_kind                                                  AS from_kind,
          m.from_user_id                                               AS from_user_id,
          m.from_agent_id                                              AS from_agent_id,
          m.author_id                                                  AS author_id,
          m.author_name                                                AS author_name,
          m.author_display_name                                        AS author_display_name,
          CASE m.from_kind WHEN 'user' THEN su.name
                           WHEN 'agent' THEN sa.name END                AS live_name,
          CASE m.from_kind WHEN 'user' THEN su.display_name
                           WHEN 'agent' THEN sa.display_name END        AS live_display_name,
          CASE m.from_kind WHEN 'user' THEN su.avatar_storage_key
                           WHEN 'agent' THEN sa.avatar_storage_key END  AS live_avatar_key,
          CASE m.from_kind WHEN 'user' THEN su.updated_at
                           WHEN 'agent' THEN sa.updated_at END          AS live_updated_at,
          CASE m.from_kind WHEN 'agent' THEN sa.runtime END             AS live_runtime`;

interface DirectedNotificationRow extends SenderColumns {
  id: string;
  kind: 'mention_self' | 'agent_start_failed';
  conversation_id: string | null;
  conversation_kind: 'channel' | 'dm_channel' | null;
  message_id: string | null;
  thread_root_id: string | null;
  root_content: string | null;
  message_seq: number | null;
  message_content: string | null;
  stream_cursor: number;
  conversation_title: string | null;
  workspace_id: string | null;
  payload: string | null;
  created_at: number;
}

interface PositionalStreamRow extends SenderColumns {
  conversation_id: string;
  root: string | null;
  root_content: string | null;
  conversation_kind: 'channel' | 'dm_channel';
  conversation_title: string;
  workspace_id: string;
  first_unread_message_id: string;
  first_unread_seq: number;
  first_unread_content: string | null;
  first_unread_created_at: number;
  unread_count: number;
}

/**
 * The ORDERED registry of Activity sources — the chokepoint (#task:1410, Cindy
 * review). Every visible Activity item is produced by exactly one of these
 * sources, and `listActivity` assembles the list by looping THIS list: a source
 * not registered here emits nothing, so a new SQL source cannot reach the output
 * without a registry id. `activity-lifecycle-conformance.test.ts` derives its
 * lifecycle matrix from these ids via `satisfies Record<ActivitySourceId, …>`,
 * so a new id with no live/archived/orphan case fails to compile.
 *
 * Ordering is LOAD-BEARING: a source may read what earlier sources claimed via
 * the shared `ActivityAssemblyContext` (positional subtracts the directed
 * message ids, §8 `positional \ directed`), so `directed_notification` MUST
 * precede `positional_stream`.
 */
export const ACTIVITY_SOURCE_IDS = [
  'directed_notification',
  'positional_stream',
] as const;
export type ActivitySourceId = (typeof ACTIVITY_SOURCE_IDS)[number];

/** Threaded through the ordered sources so a later source can react to what an
 *  earlier one claimed. The only shared state today is `directedMessageIds`
 *  (§8): directed sources ADD the message ids they claim; positional sources
 *  SUBTRACT them so an ambient row never anchors on a message already shown as a
 *  mention. */
interface ActivityAssemblyContext {
  ctx: BackendContext;
  viewerUserId: string;
  wsFilter: string | null;
  directedMessageIds: Set<string>;
}

/** An Activity source: given the assembly context, produce this source's items.
 *  A source that reads a conversation MUST express liveness through
 *  LIVE_CONVERSATION_PREDICATE (the single gate) — never a hand-written
 *  `archived_at` / existence filter, or the #1409 drift reopens. */
type ActivitySource = (ac: ActivityAssemblyContext) => ActivityItemDto[];

/** Directed notifications (mention_self + agent_start_failed). Claims at most one
 *  item per message (§7) and records the claimed message ids into the shared
 *  context so the positional source can subtract them. */
const assembleDirectedNotifications: ActivitySource = ac => {
  const { ctx, viewerUserId, wsFilter } = ac;
  // `stream_cursor` lets us drop a mention the viewer has already read
  // positionally (§7: cursor-passed ⇒ directed cleared) without storing it.
  const notifRows = prepareObserved<{ viewer: string; ws: string | null }, DirectedNotificationRow>(
      ctx.db,
      'activity.directed_notifications',
      `SELECT
          n.id                AS id,
          n.kind              AS kind,
          n.conversation_id   AS conversation_id,
          c.kind              AS conversation_kind,
          n.message_id        AS message_id,
          m.thread_root_id    AS thread_root_id,
          root.content        AS root_content,
          m.seq               AS message_seq,
          m.content           AS message_content,
          COALESCE((
            SELECT cr.last_read_seq FROM conversation_reads cr
             WHERE cr.user_id = n.user_id
               AND cr.conversation_id = n.conversation_id
               AND cr.thread_root_id IS m.thread_root_id
          ), 0)               AS stream_cursor,
          c.title             AS conversation_title,
          COALESCE(n.workspace_id, c.workspace_id) AS workspace_id,
          n.payload           AS payload,
          n.created_at        AS created_at,${SENDER_SELECT}
        FROM notifications n
        LEFT JOIN messages m ON m.id = n.message_id
        LEFT JOIN messages root ON root.id = m.thread_root_id
        LEFT JOIN conversations c ON c.id = n.conversation_id
        LEFT JOIN users su ON su.id = m.from_user_id
        LEFT JOIN agents sa ON sa.id = m.from_agent_id
       WHERE n.user_id = @viewer
         AND n.read_at IS NULL
         AND n.kind IN ('mention_self', 'agent_start_failed')
         -- Directed Activity items are conversation-backed: mentions need a
         -- message anchor and agent failures are message-anchorless, but still
         -- emitted for a concrete conversation. Lifecycle-ended conversations
         -- (archived/deleted) are not visible Activity — see
         -- LIVE_CONVERSATION_PREDICATE (the shared gate).
         AND ${LIVE_CONVERSATION_PREDICATE}
         AND (@ws IS NULL OR COALESCE(n.workspace_id, c.workspace_id) = @ws)
       ORDER BY n.created_at DESC`,
    )
    .all({ viewer: viewerUserId, ws: wsFilter });

  // ── §7 de-dupe directed claims: at most one item per message. Only mentions
  // are message-anchored directed claims (the task projection was removed in v1,
  // see the file header); agent_start_failed has no anchor message, so it never
  // participates in the per-message map (and never excludes an ambient message).
  const directedByMessage = new Map<string, ActivityItemDto>();
  const agentFailedItems: ActivityItemDto[] = [];

  for (const n of notifRows) {
    if (n.kind === 'mention_self') {
      if (!n.conversation_id || !n.message_id) continue;
      // §7: cursor already past it ⇒ the directed claim is cleared (read_at may
      // still be NULL pre-observe-collapse — the predicate is the derivation).
      if (n.message_seq !== null && n.message_seq <= n.stream_cursor) continue;
      // already claimed this message (e.g. a duplicate mention notification).
      if (directedByMessage.has(n.message_id)) continue;
      directedByMessage.set(n.message_id, {
        id: `mention:${n.id}`,
        kind: 'mention',
        salience: 'directed',
        workspace_id: n.workspace_id ?? '',
        conversation_id: n.conversation_id,
        conversation_kind: n.conversation_kind ?? 'channel',
        thread_root_id: n.thread_root_id,
        message_id: n.message_id,
        notification_id: n.id,
        title: n.conversation_title ?? '',
        thread_root_preview: preview(n.root_content),
        preview: preview(n.message_content),
        preview_sender: buildPreviewSender(n),
        timestamp: n.created_at,
        unread_count: null,
      });
    } else {
      // agent_start_failed: no anchor message; preview from the payload.
      let agentPreview: string | null = null;
      if (n.payload) {
        try {
          const p = JSON.parse(n.payload) as { agent_name?: string; error?: string };
          agentPreview = preview(
            [p.agent_name, p.error].filter(Boolean).join(' — ') || null,
          );
        } catch {
          agentPreview = null;
        }
      }
      agentFailedItems.push({
        id: `agent_failed:${n.id}`,
        kind: 'agent_failed',
        salience: 'directed',
        workspace_id: n.workspace_id ?? '',
        conversation_id: n.conversation_id ?? '',
        conversation_kind: n.conversation_kind ?? 'channel',
        thread_root_id: null,
        message_id: null,
        notification_id: n.id,
        title: n.conversation_title ?? '',
        thread_root_preview: null,
        preview: agentPreview,
        preview_sender: null,
        timestamp: n.created_at,
        unread_count: null,
      });
    }
  }

  // Record the claimed message ids so the positional source can subtract them
  // (§8 `positional \ directed`). agent_start_failed has no anchor message, so
  // only mentions (the directed-by-message map) contribute.
  for (const mid of directedByMessage.keys()) ac.directedMessageIds.add(mid);

  return [...directedByMessage.values(), ...agentFailedItems];
};

/** Positional streams (ambient channel / DM / followed-thread unread),
 *  enter()-filtered in SQL. Subtracts the directed message ids the directed
 *  source claimed (§8), so both the count and the first-unread anchor are over
 *  NON-directed messages. */
const assemblePositionalStreams: ActivitySource = ac => {
  const { ctx, viewerUserId, wsFilter } = ac;
  // Mirrors the #1226 per-stream scorer (window functions, first-unread + count
  // per (conversation, thread_root_id)). §8 `positional \ directed` is done IN
  // this query by excluding the distinct directed message ids, so both the count
  // and the first-unread anchor are over NON-directed messages (no anchoring an
  // ambient row to a message already shown as a mention). The positional base
  // already drops system / the viewer's own messages, so excluding a directed
  // message that wouldn't be ambient is a harmless no-op.
  const excludedJson = JSON.stringify([...ac.directedMessageIds]);
  const positionalRows = prepareObserved<
      {
        viewer: string;
        ws: string | null;
        excluded: string;
        channelDefaultMode: string;
      },
      PositionalStreamRow
    >(
      ctx.db,
      'activity.positional_streams',
      `WITH viewer_unread AS (
         SELECT
           m.conversation_id AS conversation_id,
           m.thread_root_id  AS root,
           m.id              AS message_id,
           m.seq             AS seq,
           m.content         AS content,
           m.created_at      AS created_at,
           m.from_kind       AS from_kind,
           m.from_user_id    AS from_user_id,
           m.from_agent_id   AS from_agent_id,
           m.author_id       AS author_id,
           m.author_name     AS author_name,
           m.author_display_name AS author_display_name,
           ROW_NUMBER() OVER (
             PARTITION BY m.conversation_id, m.thread_root_id ORDER BY m.seq ASC
           ) AS rn,
           COUNT(*) OVER (
             PARTITION BY m.conversation_id, m.thread_root_id
           ) AS cnt
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN conversation_users cu
           ON cu.conversation_id = c.id AND cu.user_id = @viewer
        WHERE c.kind IN ('channel', 'dm_channel')
          AND ${LIVE_CONVERSATION_PREDICATE}
          AND (@ws IS NULL OR c.workspace_id = @ws)
          AND m.from_kind != 'system'
          AND NOT (m.from_kind = 'user'
                   AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))
          AND m.id NOT IN (SELECT value FROM json_each(@excluded))
          AND m.seq > COALESCE(
            (SELECT cr.last_read_seq FROM conversation_reads cr
              WHERE cr.user_id = @viewer
                AND cr.conversation_id = m.conversation_id
                AND cr.thread_root_id IS m.thread_root_id),
            0
          )
       )
       SELECT
         vu.conversation_id              AS conversation_id,
         vu.root                         AS root,
         root.content                    AS root_content,
         c.kind                          AS conversation_kind,
         c.title                         AS conversation_title,
         c.workspace_id                  AS workspace_id,
         vu.message_id                   AS first_unread_message_id,
         vu.seq                          AS first_unread_seq,
         vu.content                      AS first_unread_content,
         vu.created_at                   AS first_unread_created_at,
         vu.cnt                          AS unread_count,
         vu.from_kind                                                  AS from_kind,
         vu.from_user_id                                               AS from_user_id,
         vu.from_agent_id                                              AS from_agent_id,
         vu.author_id                                                  AS author_id,
         vu.author_name                                                AS author_name,
         vu.author_display_name                                        AS author_display_name,
         CASE vu.from_kind WHEN 'user' THEN su.name
                           WHEN 'agent' THEN sa.name END                AS live_name,
         CASE vu.from_kind WHEN 'user' THEN su.display_name
                           WHEN 'agent' THEN sa.display_name END        AS live_display_name,
         CASE vu.from_kind WHEN 'user' THEN su.avatar_storage_key
                           WHEN 'agent' THEN sa.avatar_storage_key END  AS live_avatar_key,
         CASE vu.from_kind WHEN 'user' THEN su.updated_at
                           WHEN 'agent' THEN sa.updated_at END          AS live_updated_at,
         CASE vu.from_kind WHEN 'agent' THEN sa.runtime END             AS live_runtime
       FROM viewer_unread vu
       JOIN conversations c ON c.id = vu.conversation_id
       LEFT JOIN messages root ON root.id = vu.root
       LEFT JOIN users su ON su.id = vu.from_user_id
       LEFT JOIN agents sa ON sa.id = vu.from_agent_id
      WHERE vu.rn = 1
        AND (
          -- DM mainline: directed-grade, always enters (§5.1).
          (vu.root IS NULL AND c.kind = 'dm_channel')
          -- Channel mainline: enters when effective ambient pref = 'all'.
          OR (vu.root IS NULL AND c.kind = 'channel'
              AND COALESCE((
                SELECT cap.mode FROM channel_attention_preferences cap
                 WHERE cap.user_id = @viewer
                   AND cap.conversation_id = vu.conversation_id
              ), @channelDefaultMode) = 'all')
          -- Thread ambient: aggregate-floor (#task:1268). Requires BOTH the
          -- delivery precondition (viewer follows the cluster) AND the parent
          -- channel's ambient pref = 'all'. vu.conversation_id IS the parent
          -- channel for a reply-cluster, so the SAME preference gates mainline
          -- and its threads. follow is a delivery decision and must not force
          -- ambient on over the viewer's explicit mentions-only pref
          -- (delivery vs attention); thread @mentions still enter via directed.
          OR (vu.root IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM thread_followers tf
                 WHERE tf.thread_root_id = vu.root
                   AND tf.principal_kind = 'human'
                   AND tf.principal_id = @viewer
              )
              AND COALESCE((
                SELECT cap.mode FROM channel_attention_preferences cap
                 WHERE cap.user_id = @viewer
                   AND cap.conversation_id = vu.conversation_id
              ), @channelDefaultMode) = 'all')
        )`,
    )
    .all({
      viewer: viewerUserId,
      ws: wsFilter,
      excluded: excludedJson,
      channelDefaultMode: DEFAULT_CHANNEL_ATTENTION_MODE,
    });

  // ── map positional rows to items ──────────────────────────────────────────
  const items: ActivityItemDto[] = [];
  for (const s of positionalRows) {
    // DM unread is positional by mechanism but directed-grade by salience.
    const salience: ActivitySalience =
      s.conversation_kind === 'dm_channel' ? 'directed' : 'ambient';
    items.push({
      id: `unread:${s.conversation_id}::${s.root ?? ''}`,
      kind: 'unread',
      salience,
      workspace_id: s.workspace_id,
      conversation_id: s.conversation_id,
      conversation_kind: s.conversation_kind,
      thread_root_id: s.root,
      message_id: s.first_unread_message_id,
      notification_id: null,
      title: s.conversation_title,
      thread_root_preview: preview(s.root_content),
      preview: preview(s.first_unread_content),
      preview_sender: buildPreviewSender(s),
      timestamp: s.first_unread_created_at,
      unread_count: s.unread_count,
    });
  }
  return items;
};

/** The chokepoint registry. `satisfies` forces one assembler per declared
 *  ActivitySourceId, and `listActivity`'s loop is the ONLY assembly path — the
 *  structural guarantee that a new visible source must be registered here (and
 *  lifecycle-tested) rather than smuggled in as inline SQL. */
const ACTIVITY_SOURCES = {
  directed_notification: assembleDirectedNotifications,
  positional_stream: assemblePositionalStreams,
} satisfies Record<ActivitySourceId, ActivitySource>;

/**
 * Project the viewer's Activity list. Pure read; returns a DTO the client
 * renders as-is (already filtered, deduped, salience-sorted). Assembly loops
 * ACTIVITY_SOURCES in ACTIVITY_SOURCE_IDS order — every item comes from a
 * registered source, and later sources see what earlier ones claimed via the
 * shared context (§8).
 */
export function listActivity(
  ctx: BackendContext,
  params: ListActivityParams,
): ListActivityDto {
  const ac: ActivityAssemblyContext = {
    ctx,
    viewerUserId: params.viewerUserId,
    wsFilter: params.workspaceId ?? null,
    directedMessageIds: new Set(),
  };

  const items: ActivityItemDto[] = [];
  for (const id of ACTIVITY_SOURCE_IDS) {
    items.push(...ACTIVITY_SOURCES[id](ac));
  }

  // §13.2 v1 sort: directed tier first, most-recent-first within each tier.
  const tierRank: Record<ActivitySalience, number> = { directed: 0, ambient: 1 };
  items.sort((a, b) => {
    if (tierRank[a.salience] !== tierRank[b.salience]) {
      return tierRank[a.salience] - tierRank[b.salience];
    }
    return b.timestamp - a.timestamp;
  });

  return { items };
}
