// Read-model for the Activity list (#task:1227, docs/activity-lifecycle-v1.md
// §9.2 `listActivity`). Attention is a read-side bounded context: it owns NO
// activity/read/done state. Every item here is projected from an existing
// source — the per-stream cursor read-model (#1226 `conversation_reads` /
// `conversation_stream_heads`), `notifications` (`read_at`), and
// `messages.task_*` — and recomputed on each read. Dependency direction is
// one-way: routes → read-model. Nothing in this file writes.
//
// The list is assembled in three reads + a small TS merge so the §6/§7/§8 rules
// stay legible:
//   1. directed notifications  — `mention_self` + `agent_start_failed` (read_at
//      NULL), the directed @me / agent-failure claims (always enter, §6).
//   2. directed tasks          — tasks assigned to the viewer that need action.
//   3. positional streams      — per-(conversation, stream) ambient/DM unread,
//      already `enter()`-filtered in SQL (DM always; channel mainline iff the
//      viewer's ChannelAttentionPreference = 'all'; threads iff followed).
// Then TS: drop a `mention_self` whose stream cursor has already passed it (§7
// consistency — cursor-passed ⇒ directed cleared); subtract directed messages
// from each stream's ambient count (§8 `positional \ directed`); derive salience
// and sort (§13.2 directed tier first, most-recent-first within tier).
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

/** Task statuses that count as "needs my action" for the assignee (§5.1 row
 *  "task needs-my-action"). `in_review` waits on a reviewer, `done`/`closed`
 *  are terminal — neither is the assignee's action, so both are excluded. */
const TASK_NEEDS_ACTION_STATUSES = ['todo', 'in_progress'] as const;

function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return null;
  return compact.length > PREVIEW_MAX
    ? `${compact.slice(0, PREVIEW_MAX - 1)}…`
    : compact;
}

function streamKey(conversationId: string, threadRootId: string | null): string {
  return `${conversationId}::${threadRootId ?? ''}`;
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
  message_seq: number;
  stream_cursor: number;
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
  const statusPlaceholders = TASK_NEEDS_ACTION_STATUSES.map(() => '?').join(',');
  const taskRows = ctx.db
    .prepare<unknown[], TaskRow>(
      `SELECT
          m.conversation_id   AS conversation_id,
          m.id                AS message_id,
          m.thread_root_id    AS thread_root_id,
          m.seq               AS message_seq,
          COALESCE((
            SELECT cr.last_read_seq FROM conversation_reads cr
             WHERE cr.user_id = ?
               AND cr.conversation_id = m.conversation_id
               AND cr.thread_root_id IS m.thread_root_id
          ), 0)               AS stream_cursor,
          m.task_number       AS task_number,
          m.task_status       AS task_status,
          m.task_title        AS task_title,
          m.task_workspace_id AS workspace_id,
          m.created_at        AS created_at
        FROM messages m
       WHERE m.task_number IS NOT NULL
         AND m.task_assignee_user_id = ?
         AND m.task_status IN (${statusPlaceholders})
         AND (? IS NULL OR m.task_workspace_id = ?)
       ORDER BY m.task_number DESC`,
    )
    .all(viewerUserId, viewerUserId, ...TASK_NEEDS_ACTION_STATUSES, wsFilter, wsFilter);

  // ── 3. positional streams (ambient/DM unread), enter()-filtered in SQL ─────
  // Mirrors the #1226 per-stream scorer (window functions, first-unread + count
  // per (conversation, thread_root_id)); adds the enter() gate as a WHERE.
  const positionalRows = ctx.db
    .prepare<{ viewer: string; ws: string | null }, PositionalStreamRow>(
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
    .all({ viewer: viewerUserId, ws: wsFilter });

  // ── merge ─────────────────────────────────────────────────────────────────
  const items: ActivityItemDto[] = [];
  // Count of live directed-claimed messages per stream, for §8 subtraction.
  const directedInStream = new Map<string, number>();

  for (const n of notifRows) {
    if (n.kind === 'mention_self') {
      if (!n.conversation_id || !n.message_id) continue;
      // §7: if the viewer already read past this message in its stream, the
      // directed claim is cleared even though read_at is still NULL.
      if (n.message_seq !== null && n.message_seq <= n.stream_cursor) continue;
      directedInStream.set(
        streamKey(n.conversation_id, n.thread_root_id),
        (directedInStream.get(streamKey(n.conversation_id, n.thread_root_id)) ?? 0) + 1,
      );
      items.push({
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
      items.push({
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

  for (const t of taskRows) {
    // §7: a task-anchor message that is also positionally unread must not also
    // be counted as ambient — the task claim wins (directed). Subtract it from
    // its stream ONLY when it is actually unread (cursor not yet past it); a
    // task whose message was already read still shows as a task item
    // (resolve-cleared, §5.3) but is no longer in the ambient count.
    if (t.message_seq > t.stream_cursor) {
      directedInStream.set(
        streamKey(t.conversation_id, t.thread_root_id),
        (directedInStream.get(streamKey(t.conversation_id, t.thread_root_id)) ?? 0) + 1,
      );
    }
    items.push({
      id: `task:${t.task_number}`,
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

  for (const s of positionalRows) {
    // §8: ambient count is net of directed claims already shown for this stream
    // (avoids the same message counting as both a mention and ambient unread).
    const directed = directedInStream.get(streamKey(s.conversation_id, s.root)) ?? 0;
    const adjusted = s.unread_count - directed;
    if (adjusted <= 0) continue; // worked edge §8: only-unread-was-the-mention.
    // DM unread is positional by mechanism but directed-grade by salience.
    const salience: ActivitySalience =
      s.conversation_kind === 'dm_channel' ? 'directed' : 'ambient';
    items.push({
      id: `unread:${streamKey(s.conversation_id, s.root)}`,
      kind: 'unread',
      salience,
      workspace_id: s.workspace_id,
      conversation_id: s.conversation_id,
      thread_root_id: s.root,
      message_id: s.first_unread_message_id,
      title: s.conversation_title,
      preview: preview(s.first_unread_content),
      timestamp: s.first_unread_created_at,
      unread_count: adjusted,
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
