// Read-model for the Activity list (#task:1227, docs/activity-lifecycle-v1.md
// §9.2 `listActivity`). Attention is a read-side bounded context: it owns NO
// activity/read/done state. Every item here is projected from an existing
// source — the per-stream cursor read-model (#1226 `conversation_reads` /
// `conversation_stream_heads`), `notifications` (`read_at`), and
// `messages.task_*` — and recomputed on each read. Dependency direction is
// one-way: routes → read-model. Nothing in this file writes.
//
// Assembly (§6/§7/§8):
//   1. directed notifications — `mention_self` + `agent_start_failed` (read_at
//      NULL); a mention whose stream cursor already passed it is treated as
//      cleared (§7: cursor-passed ⇒ directed cleared), no stored state.
//   2. directed tasks — `todo`/`in_progress` assigned to the viewer, OR any
//      `in_review` task in a conversation the viewer belongs to (the implicit
//      "等你验证" queue). BOTH branches are membership-gated so a task never
//      leaks a conversation the viewer can't see.
//   3. The §7 per-(viewer, message) de-dupe runs in TS: at most one directed
//      claim per message (task wins over mention). The DISTINCT set of directed
//      message ids is then excluded from the positional query, so §8
//      (`positional \ directed`) is computed in SQL — the ambient row's count
//      AND its first-unread anchor/preview/timestamp are the first NON-directed
//      unread message, never a message already shown as a mention/task. Because
//      the positional base already drops system / the viewer's own messages, a
//      directed message that wouldn't be ambient is simply absent (no spurious
//      subtraction).
//   4. positional streams — per-(conversation, stream) ambient/DM unread,
//      `enter()`-filtered in SQL (DM always; channel mainline iff the viewer's
//      ChannelAttentionPreference = 'all'; threads iff followed).
// Then salience is derived (DM = directed-grade) and the list sorted §13.2:
// directed tier first, most-recent-first within a tier.
import type { BackendContext } from '../context.js';
import type {
  ActivityItemDto,
  ActivitySalience,
  ListActivityDto,
} from '@silverhand/shared';

export interface ListActivityParams {
  viewerUserId: string;
  /** Optional workspace filter. The data model is global; v1 UI scopes to one
   *  workspace. Absent = every workspace the viewer can see. */
  workspaceId?: string;
}

const PREVIEW_MAX = 140;

function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return null;
  return compact.length > PREVIEW_MAX
    ? `${compact.slice(0, PREVIEW_MAX - 1)}…`
    : compact;
}

interface DirectedNotificationRow {
  id: string;
  kind: 'mention_self' | 'agent_start_failed';
  conversation_id: string | null;
  message_id: string | null;
  thread_root_id: string | null;
  message_seq: number | null;
  message_content: string | null;
  stream_cursor: number;
  conversation_title: string | null;
  workspace_id: string | null;
  payload: string | null;
  created_at: number;
}

interface TaskRow {
  conversation_id: string;
  message_id: string;
  thread_root_id: string | null;
  task_number: number;
  task_status: string;
  task_title: string | null;
  workspace_id: string;
  created_at: number;
}

interface PositionalStreamRow {
  conversation_id: string;
  root: string | null;
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
          n.message_id        AS message_id,
          m.thread_root_id    AS thread_root_id,
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
          n.created_at        AS created_at
        FROM notifications n
        LEFT JOIN messages m ON m.id = n.message_id
        LEFT JOIN conversations c ON c.id = n.conversation_id
       WHERE n.user_id = @viewer
         AND n.read_at IS NULL
         AND n.kind IN ('mention_self', 'agent_start_failed')
         AND (@ws IS NULL OR COALESCE(n.workspace_id, c.workspace_id) = @ws)
       ORDER BY n.created_at DESC`,
    )
    .all({ viewer: viewerUserId, ws: wsFilter });

  // ── 2. directed tasks needing the viewer's action ─────────────────────────
  // Membership-gated (mirrors TaskService.list for humans) so a task never
  // leaks a conversation the viewer can't see. Two branches (§5.1 row
  // "task needs-my-action", refined per shiki 2026-06-25): the viewer's own
  // open work, OR an `in_review` task awaiting human validation. A precise
  // per-reviewer in_review source needs a modeled reviewer relation → v2; in
  // single-human dogfood this membership-scoped in_review IS the validation
  // queue (the #1226-style "等你复验").
  const taskRows = ctx.db
    .prepare<{ viewer: string; ws: string | null }, TaskRow>(
      `SELECT
          m.conversation_id   AS conversation_id,
          m.id                AS message_id,
          m.thread_root_id    AS thread_root_id,
          m.task_number       AS task_number,
          m.task_status       AS task_status,
          m.task_title        AS task_title,
          m.task_workspace_id AS workspace_id,
          m.created_at        AS created_at
        FROM messages m
       WHERE m.task_number IS NOT NULL
         AND (@ws IS NULL OR m.task_workspace_id = @ws)
         AND EXISTS (
           SELECT 1 FROM conversation_users cu
            WHERE cu.conversation_id = m.conversation_id
              AND cu.user_id = @viewer
         )
         AND (
           (m.task_assignee_user_id = @viewer
            AND m.task_status IN ('todo', 'in_progress'))
           OR m.task_status = 'in_review'
         )
       ORDER BY m.task_number DESC`,
    )
    .all({ viewer: viewerUserId, ws: wsFilter });

  // ── §7 de-dupe directed claims: at most one item per message (task > mention).
  // agent_start_failed has no anchor message, so it never participates in the
  // per-message map (and never excludes an ambient message).
  const directedByMessage = new Map<string, ActivityItemDto>();
  const agentFailedItems: ActivityItemDto[] = [];

  for (const t of taskRows) {
    directedByMessage.set(t.message_id, {
      id: `task:${t.workspace_id}:${t.task_number}`,
      kind: 'task',
      salience: 'directed',
      workspace_id: t.workspace_id,
      conversation_id: t.conversation_id,
      thread_root_id: t.thread_root_id,
      message_id: t.message_id,
      title: t.task_title ?? '',
      preview: null,
      timestamp: t.created_at,
      unread_count: null,
      task_number: t.task_number,
      task_status: t.task_status,
    });
  }

  for (const n of notifRows) {
    if (n.kind === 'mention_self') {
      if (!n.conversation_id || !n.message_id) continue;
      // §7: cursor already past it ⇒ the directed claim is cleared (read_at may
      // still be NULL pre-observe-collapse — the predicate is the derivation).
      if (n.message_seq !== null && n.message_seq <= n.stream_cursor) continue;
      // task wins on the same message (already claimed).
      if (directedByMessage.has(n.message_id)) continue;
      directedByMessage.set(n.message_id, {
        id: `mention:${n.id}`,
        kind: 'mention',
        salience: 'directed',
        workspace_id: n.workspace_id ?? '',
        conversation_id: n.conversation_id,
        thread_root_id: n.thread_root_id,
        message_id: n.message_id,
        title: n.conversation_title ?? '',
        preview: preview(n.message_content),
        timestamp: n.created_at,
        unread_count: null,
        task_number: null,
        task_status: null,
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
        thread_root_id: null,
        message_id: null,
        title: n.conversation_title ?? '',
        preview: agentPreview,
        timestamp: n.created_at,
        unread_count: null,
        task_number: null,
        task_status: null,
      });
    }
  }

  // ── 3. positional streams (ambient/DM unread), enter()-filtered in SQL ─────
  // Mirrors the #1226 per-stream scorer (window functions, first-unread + count
  // per (conversation, thread_root_id)). §8 `positional \ directed` is done IN
  // this query by excluding the distinct directed message ids, so both the count
  // and the first-unread anchor are over NON-directed messages (no anchoring an
  // ambient row to a message already shown as a mention/task). The positional
  // base already drops system / the viewer's own messages, so excluding a
  // directed message that wouldn't be ambient is a harmless no-op.
  const excludedJson = JSON.stringify([...directedByMessage.keys()]);
  const positionalRows = ctx.db
    .prepare<
      { viewer: string; ws: string | null; excluded: string },
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
          AND c.archived_at IS NULL
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
         c.kind                          AS conversation_kind,
         c.title                         AS conversation_title,
         c.workspace_id                  AS workspace_id,
         vu.message_id                   AS first_unread_message_id,
         vu.seq                          AS first_unread_seq,
         vu.content                      AS first_unread_content,
         vu.created_at                   AS first_unread_created_at,
         vu.cnt                          AS unread_count
       FROM viewer_unread vu
       JOIN conversations c ON c.id = vu.conversation_id
      WHERE vu.rn = 1
        AND (
          -- DM mainline: directed-grade, always enters (§5.1).
          (vu.root IS NULL AND c.kind = 'dm_channel')
          -- Channel mainline: only when ambient pref = 'all' (§6 default off).
          OR (vu.root IS NULL AND c.kind = 'channel'
              AND COALESCE((
                SELECT cap.mode FROM channel_attention_preferences cap
                 WHERE cap.user_id = @viewer
                   AND cap.conversation_id = vu.conversation_id
              ), 'mentions') = 'all')
          -- Thread: ambient is follow-driven (§6 followed → on).
          OR (vu.root IS NOT NULL AND EXISTS (
                SELECT 1 FROM thread_followers tf
                 WHERE tf.thread_root_id = vu.root
                   AND tf.principal_kind = 'human'
                   AND tf.principal_id = @viewer
              ))
        )`,
    )
    .all({ viewer: viewerUserId, ws: wsFilter, excluded: excludedJson });

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
      thread_root_id: s.root,
      message_id: s.first_unread_message_id,
      title: s.conversation_title,
      preview: preview(s.first_unread_content),
      timestamp: s.first_unread_created_at,
      unread_count: s.unread_count,
      task_number: null,
      task_status: null,
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
