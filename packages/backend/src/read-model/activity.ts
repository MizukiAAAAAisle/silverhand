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
import {
  apiPaths,
  DEFAULT_CHANNEL_ATTENTION_MODE,
  type ActivityItemDto,
  type ActivityPreviewSender,
  type ActivitySalience,
  type ListActivityDto,
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
 *  global list never client-stitches a cross-workspace sender. Both queries
 *  resolve `sender_*` via CASE on the message `from_kind` (a `system` author or
 *  a missing anchor leaves `sender_kind` outside user/agent → NULL sender). */
interface SenderColumns {
  sender_kind: string | null;
  sender_id: string | null;
  sender_display_name: string | null;
  sender_avatar_key: string | null;
  sender_updated_at: number | null;
}

/** Build the display-only `preview_sender` from the resolved author columns.
 *  `avatar_url` mirrors `UserDto`/`AgentDto`: the relative avatar path with the
 *  `?v=updated_at` cache-buster, or NULL when the author has no avatar. */
function buildPreviewSender(row: SenderColumns): ActivityPreviewSender | null {
  if (row.sender_kind !== 'user' && row.sender_kind !== 'agent') return null;
  if (!row.sender_id) return null;
  const avatar_url = row.sender_avatar_key
    ? `${
        row.sender_kind === 'user'
          ? apiPaths.userAvatar(row.sender_id)
          : apiPaths.agentAvatar(row.sender_id)
      }?v=${row.sender_updated_at ?? 0}`
    : null;
  return {
    kind: row.sender_kind,
    id: row.sender_id,
    // SQL already resolved display_name → name (both NOT NULL); the final → id
    // fallback only triggers on a join miss, so the label is never empty.
    display_name: row.sender_display_name?.trim()
      ? row.sender_display_name
      : row.sender_id,
    avatar_url,
  };
}

/** SQL fragment resolving an anchor message `m`'s author into `sender_*`
 *  columns. Requires `LEFT JOIN users su ON su.id = m.from_user_id` and
 *  `LEFT JOIN agents sa ON sa.id = m.from_agent_id` in the same query.
 *  `sender_display_name` falls back display_name → name (both NOT NULL) so it is
 *  never an empty label — `agents.display_name` is `NOT NULL DEFAULT ''` and the
 *  renderer is barred from re-deriving the name; `buildPreviewSender` adds the
 *  final → id fallback for a join miss. */
const SENDER_SELECT = `
          m.from_kind                                                  AS sender_kind,
          CASE m.from_kind WHEN 'user' THEN m.from_user_id
                           WHEN 'agent' THEN m.from_agent_id END        AS sender_id,
          CASE m.from_kind WHEN 'user' THEN COALESCE(NULLIF(su.display_name, ''), su.name)
                           WHEN 'agent' THEN COALESCE(NULLIF(sa.display_name, ''), sa.name) END AS sender_display_name,
          CASE m.from_kind WHEN 'user' THEN su.avatar_storage_key
                           WHEN 'agent' THEN sa.avatar_storage_key END  AS sender_avatar_key,
          CASE m.from_kind WHEN 'user' THEN su.updated_at
                           WHEN 'agent' THEN sa.updated_at END          AS sender_updated_at`;

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
 * Project the viewer's Activity list. Pure read; returns a DTO the client
 * renders as-is (already filtered, deduped, salience-sorted).
 */
export function listActivity(
  ctx: BackendContext,
  params: ListActivityParams,
): ListActivityDto {
  const { viewerUserId, workspaceId } = params;
  const wsFilter = workspaceId ?? null;

  // ── 1. directed notifications (mention_self + agent_start_failed) ──────────
  // `stream_cursor` lets us drop a mention the viewer has already read
  // positionally (§7: cursor-passed ⇒ directed cleared) without storing it.
  const notifRows = ctx.db
    .prepare<{ viewer: string; ws: string | null }, DirectedNotificationRow>(
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

  // ── 3. positional streams (ambient/DM unread), enter()-filtered in SQL ─────
  // Mirrors the #1226 per-stream scorer (window functions, first-unread + count
  // per (conversation, thread_root_id)). §8 `positional \ directed` is done IN
  // this query by excluding the distinct directed message ids, so both the count
  // and the first-unread anchor are over NON-directed messages (no anchoring an
  // ambient row to a message already shown as a mention). The positional base
  // already drops system / the viewer's own messages, so excluding a directed
  // message that wouldn't be ambient is a harmless no-op.
  const excludedJson = JSON.stringify([...directedByMessage.keys()]);
  const positionalRows = ctx.db
    .prepare<
      {
        viewer: string;
        ws: string | null;
        excluded: string;
        channelDefaultMode: string;
      },
      PositionalStreamRow
    >(
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
         vu.from_kind                                                  AS sender_kind,
         CASE vu.from_kind WHEN 'user' THEN vu.from_user_id
                           WHEN 'agent' THEN vu.from_agent_id END       AS sender_id,
         CASE vu.from_kind WHEN 'user' THEN COALESCE(NULLIF(su.display_name, ''), su.name)
                           WHEN 'agent' THEN COALESCE(NULLIF(sa.display_name, ''), sa.name) END AS sender_display_name,
         CASE vu.from_kind WHEN 'user' THEN su.avatar_storage_key
                           WHEN 'agent' THEN sa.avatar_storage_key END  AS sender_avatar_key,
         CASE vu.from_kind WHEN 'user' THEN su.updated_at
                           WHEN 'agent' THEN sa.updated_at END          AS sender_updated_at
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

  // ── assemble ────────────────────────────────────────────────────────────
  const items: ActivityItemDto[] = [
    ...directedByMessage.values(),
    ...agentFailedItems,
  ];

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
