// Read-model for message reactions (docs/reactions-design.md §6). The
// viewer-scoped aggregate projection + the lazy reactor detail live here as
// raw SQL, separate from the write repo (`repos/message-reaction-repo.ts`).
// Dependency direction is one-way: routes / read paths → read-model.
//
// #task:1983 W2 — the handle is bound at ASSEMBLY time (`createMessageReactionsReadModel`),
// not read out of a god-context per call: these queries only ever needed `db`,
// and taking the whole `BackendContext` is what made the read side look like it
// had ambient access to everything.
import type { Database as Db } from 'better-sqlite3';
import type {
  MessageReactionDetailDto,
  ReactionAggregateDto,
  ReactorKind,
} from '@silverhand/shared';

/** The principal a read is scoped to, for `viewer_reacted`. Null when the
 *  read has no human/agent viewer (e.g. a system-scoped read) — then
 *  `viewer_reacted` is always false. */
export type ReactionViewer = { kind: ReactorKind; id: string } | null;

interface AggregateRow {
  message_id: string;
  emoji: string;
  count: number;
  viewer_reacted: number;
}

/**
 * Bulk-load reaction aggregates for a window of messages in ONE query
 * (no N+1, §6). Returns a map from message id to its per-emoji aggregates;
 * a message with no reactions is simply absent from the map (callers map
 * absence to `reactions: null` on the DTO).
 *
 * Emoji order within a message is stable by first-reaction time so chips
 * don't reshuffle between reads.
 */
export function loadReactionAggregates(
  db: Db,
  messageIds: readonly string[],
  viewer: ReactionViewer,
): Map<string, ReactionAggregateDto[]> {
  const out = new Map<string, ReactionAggregateDto[]>();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => '?').join(',');
  // viewer match params: empty strings never match a real (kind,id) pair,
  // so a null viewer yields viewer_reacted = 0 everywhere.
  const viewerKind = viewer?.kind ?? '';
  const viewerId = viewer?.id ?? '';
  const rows = db
    .prepare<Array<string>, AggregateRow>(
      `SELECT
         message_id,
         emoji,
         COUNT(*) AS count,
         MAX(CASE WHEN reactor_kind = ? AND reactor_id = ? THEN 1 ELSE 0 END)
           AS viewer_reacted
       FROM message_reactions
       WHERE message_id IN (${placeholders})
       GROUP BY message_id, emoji
       ORDER BY message_id, MIN(created_at), emoji`,
    )
    .all(viewerKind, viewerId, ...messageIds);
  for (const row of rows) {
    let list = out.get(row.message_id);
    if (!list) {
      list = [];
      out.set(row.message_id, list);
    }
    list.push({
      emoji: row.emoji,
      count: row.count,
      viewer_reacted: row.viewer_reacted === 1,
    });
  }
  return out;
}

interface DetailRow {
  emoji: string;
  reactor_kind: ReactorKind;
  reactor_id: string;
  display_name: string;
  emoji_first_at: number;
  created_at: number;
}

/**
 * Lazy reactor detail for a single message (the hover "who reacted"
 * tooltip). Resolves each reactor's display name server-side via a join
 * (single-message scope — cheap), so the renderer needn't cross-reference
 * the directory. Per-emoji groups ordered by first-reaction time; reactors
 * within a group ordered by when they reacted.
 */
export function loadReactionDetail(
  db: Db,
  messageId: string,
): MessageReactionDetailDto[] {
  const rows = db
    .prepare<[string], DetailRow>(
      `SELECT
         mr.emoji AS emoji,
         mr.reactor_kind AS reactor_kind,
         mr.reactor_id AS reactor_id,
         COALESCE(
           NULLIF(u.display_name, ''), u.name,
           NULLIF(a.display_name, ''), a.name,
           mr.reactor_id
         ) AS display_name,
         MIN(mr.created_at) OVER (PARTITION BY mr.emoji) AS emoji_first_at,
         mr.created_at AS created_at
       FROM message_reactions mr
       LEFT JOIN users u
         ON mr.reactor_kind = 'user' AND u.id = mr.reactor_id
       LEFT JOIN agents a
         ON mr.reactor_kind = 'agent' AND a.id = mr.reactor_id
       WHERE mr.message_id = ?
       ORDER BY emoji_first_at, mr.emoji, mr.created_at`,
    )
    .all(messageId);

  const out: MessageReactionDetailDto[] = [];
  let current: MessageReactionDetailDto | null = null;
  for (const row of rows) {
    if (!current || current.emoji !== row.emoji) {
      current = { emoji: row.emoji, reactors: [] };
      out.push(current);
    }
    current.reactors.push({
      kind: row.reactor_kind,
      id: row.reactor_id,
      display_name: row.display_name,
    });
  }
  return out;
}

/**
 * The reaction read surface a caller receives, with the handle already bound
 * (#task:1983 W2). Route modules declare THIS in their deps instead of
 * importing the module and passing a context around: the only capability a
 * reaction read needs is its own two queries.
 */
export interface MessageReactionsReadModel {
  readonly loadAggregates: (
    messageIds: readonly string[],
    viewer: ReactionViewer,
  ) => Map<string, ReactionAggregateDto[]>;
  readonly loadDetail: (messageId: string) => MessageReactionDetailDto[];
}

export function createMessageReactionsReadModel(
  db: Db,
): MessageReactionsReadModel {
  return {
    loadAggregates: (messageIds, viewer) =>
      loadReactionAggregates(db, messageIds, viewer),
    loadDetail: messageId => loadReactionDetail(db, messageId),
  };
}
