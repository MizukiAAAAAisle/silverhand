import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { decodeMessageSeq } from '@silverhand/shared';
import type {
  ConversationPlacementKind,
  MessageRow,
  SavedMessageRow,
  SavedMessageDto,
  SavedPlace,
  MessageAuthorDto,
  MessageAuthorRow,
} from '@silverhand/shared';
import {
  LINKED_TASK_JOINS,
  LINKED_TASK_SELECT,
  linkedTaskFromRow,
  type LinkedTaskProjectionRow,
} from './message-repo.js';
import { userParticipates } from './conversation-placement-sql.js';
import { loadMessageAuthors } from './message-author.js';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

/** A saved artifact can only exist for a placement a HUMAN participates in:
 *  a workspace channel or a direct_pair. `agent_inbox` has no human participant
 *  (contract §1), so a saved row there is impossible — this is the fail-closed
 *  third arm. It deliberately does NOT reuse `ConversationPlacementError`
 *  ("not workspace-placed"), which is now wrong: `direct_pair` IS saveable, so
 *  the refusal is specifically "non-participatory placement", not "no workspace".
 */
export class SavedPlacementError extends Error {
  constructor(
    readonly conversationId: string,
    readonly placementKind: ConversationPlacementKind,
  ) {
    super(
      `conversation ${conversationId} has placement_kind=${placementKind}, ` +
        `which is not a saveable placement: only workspace | direct_pair carry a ` +
        `human saved message (a human is never a participant of an agent_inbox)`,
    );
    this.name = 'SavedPlacementError';
  }
}

interface JoinedRow extends SavedMessageRow, LinkedTaskProjectionRow {
  // Message columns (prefixed in SELECT alias)
  m_id: string;
  m_conversation_id: string;
  m_from_kind: MessageRow['from_kind'];
  m_from_agent_id: string | null;
  m_from_user_id: string | null;
  m_author_id: string | null;
  m_author_name: string | null;
  m_author_display_name: string | null;
  m_content: string;
  m_metadata: string | null;
  m_seq: number;
  m_created_at: number;
  m_thread_root_id: string | null;
  // Place-projection columns. `workspace_*` and `channel_name` are NULL on the
  // pair arm by construction (LEFT JOIN workspaces + a placement-guarded CASE);
  // `placeFromRow` narrows on `placement_kind` and never reads them off the
  // pair arm.
  placement_kind: ConversationPlacementKind;
  workspace_id: string | null;
  workspace_kind: 'regular' | 'agent_space' | null;
  channel_name: string | null;
  agent_name: string | null;
}

/** Build the `SavedPlace` union from a joined row, narrowing on the canonical
 *  `placement_kind` — NOT on `workspace_id` presence, which would mislabel an
 *  `agent_inbox` (whose `workspace_id IS NULL`) as a `direct_pair`. */
function placeFromRow(row: JoinedRow): SavedPlace {
  switch (row.placement_kind) {
    case 'workspace': {
      // The arc CHECK guarantees a workspace-placed conversation has a workspace
      // row (hence a kind) and a title. After the LEFT JOIN a NULL here can
      // therefore only be a query mistake — fail loud, never fake-fill. The
      // workspace NAME is intentionally NOT projected (F1): it is joined live
      // from `['workspaces']` in the renderer, mirroring the shipped `TaskPlace`.
      if (
        row.workspace_id === null ||
        row.workspace_kind === null ||
        row.channel_name === null
      ) {
        throw new Error(
          `saved place: workspace-placed conversation ${row.conversation_id} ` +
            `is missing workspace projection columns (workspace_id/kind/channel_name)`,
        );
      }
      return {
        kind: 'workspace_channel',
        conversation_id: row.conversation_id,
        workspace_id: row.workspace_id,
        workspace_kind: row.workspace_kind,
        channel_name: row.channel_name,
      };
    }
    case 'direct_pair':
      return { kind: 'direct_pair', conversation_id: row.conversation_id };
    default:
      // agent_inbox (or any future non-participatory placement): save() refuses
      // it at the write gate, so a row reaching this projection is a routing/query
      // bug, not an outcome to render.
      throw new SavedPlacementError(row.conversation_id, row.placement_kind);
  }
}

function rowToDto(row: JoinedRow, author: MessageAuthorDto | null): SavedMessageDto {
  return {
    id: row.id,
    saved_at: row.saved_at,
    place: placeFromRow(row),
    agent_name: row.agent_name,
    message: {
      id: row.m_id,
      conversation_id: row.m_conversation_id,
      from_kind: row.m_from_kind,
      from_agent_id: row.m_from_agent_id,
      from_user_id: row.m_from_user_id,
      author,
      content: row.m_content,
      metadata: row.m_metadata
        ? (JSON.parse(row.m_metadata) as Record<string, unknown>)
        : null,
      attachments: extractAttachmentSnapshots(row.m_metadata),
      reactions: null,
      seq: decodeMessageSeq(row.m_seq),
      created_at: row.m_created_at,
      thread_root_id: row.m_thread_root_id,
      linked_task: linkedTaskFromRow(row),
    },
  };
}

function extractAttachmentSnapshots(
  rawMetadata: string | null,
): SavedMessageDto['message']['attachments'] {
  if (!rawMetadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const list = (parsed as { attachments?: unknown }).attachments;
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: NonNullable<SavedMessageDto['message']['attachments']> = [];
  for (const item of list) {
    if (
      item
      && typeof item === 'object'
      && typeof (item as { id?: unknown }).id === 'string'
      && typeof (item as { filename?: unknown }).filename === 'string'
      && typeof (item as { size?: unknown }).size === 'number'
      && typeof (item as { content_type?: unknown }).content_type === 'string'
    ) {
      const a = item as { id: string; filename: string; size: number; content_type: string };
      out.push({
        id: a.id,
        filename: a.filename,
        size: a.size,
        content_type: a.content_type,
      });
    }
  }
  return out.length > 0 ? out : null;
}

/** The joined saved-message projection.
 *
 *  Placement (§4.1/§6): `workspaces` is a LEFT JOIN — a `direct_pair` save has
 *  no workspace, and an INNER JOIN would silently drop the whole row (the §1
 *  "INNER JOIN row vanishes" failure family). The row carries the placement
 *  columns `placeFromRow` narrows on; `workspace_*`/`channel_name` are NULL on
 *  the pair arm by construction. The write side (`save()`) is the fail-closed
 *  gate that keeps a non-participatory `agent_inbox` from ever producing a row
 *  here, and the read side (`listForUser`) re-derives live human participation
 *  from the canonical authority — this projection is display/namespace only. */
const SELECT_JOINED = `
  SELECT
    sm.id              AS id,
    sm.user_id         AS user_id,
    sm.message_id      AS message_id,
    sm.conversation_id AS conversation_id,
    sm.saved_at        AS saved_at,
    m.id               AS m_id,
    m.conversation_id  AS m_conversation_id,
    m.from_kind        AS m_from_kind,
    m.from_agent_id    AS m_from_agent_id,
    m.from_user_id     AS m_from_user_id,
    m.author_id           AS m_author_id,
    m.author_name         AS m_author_name,
    m.author_display_name AS m_author_display_name,
    m.content          AS m_content,
    m.metadata         AS m_metadata,
    m.seq              AS m_seq,
    m.created_at       AS m_created_at,
    m.thread_root_id   AS m_thread_root_id,
    ${LINKED_TASK_SELECT},
    conv.placement_kind AS placement_kind,
    conv.workspace_id   AS workspace_id,
    CASE WHEN w.workspace_kind = 'agent_home' THEN 'agent_space'
         WHEN w.workspace_kind = 'regular'    THEN 'regular'
         ELSE NULL
     END                AS workspace_kind,
    CASE WHEN conv.placement_kind = 'workspace'
         THEN conv.title
         ELSE NULL
     END                AS channel_name,
    a.name             AS agent_name
  FROM saved_messages sm
  JOIN messages m ON m.id = sm.message_id
  JOIN conversations conv ON conv.id = sm.conversation_id
  LEFT JOIN workspaces w ON w.id = conv.workspace_id
  LEFT JOIN agents a  ON a.id  = m.from_agent_id
  ${LINKED_TASK_JOINS}
`;

export class SavedMessageRepo {
  constructor(private readonly db: Db) {}

  /** Resolve `MessageAuthorDto` for each joined row (batch, two queries) and
   *  return authors aligned to the input order, so callers can zip with
   *  `rows.map((r, i) => rowToDto(r, authors[i]))`. */
  private resolveAuthors(rows: JoinedRow[]): (MessageAuthorDto | null)[] {
    const authorRows: MessageAuthorRow[] = rows.map(r => ({
      from_kind: r.m_from_kind,
      from_agent_id: r.m_from_agent_id,
      from_user_id: r.m_from_user_id,
      author_id: r.m_author_id,
      author_name: r.m_author_name,
      author_display_name: r.m_author_display_name,
    }));
    const map = loadMessageAuthors(this.db, authorRows);
    return authorRows.map(ar => map.get(ar) ?? null);
  }

  /**
   * The viewer's saved messages, newest-saved first. Filters (`workspaceId` /
   * `since`) are applied in the WHERE clause — BEFORE `ORDER BY saved_at DESC
   * LIMIT` — so they narrow the whole saved history, not just the capped window
   * a client would otherwise filter (#task:1258, mirrors archived-channels).
   * `since` is `saved_at >= since` (save-time window, epoch ms).
   *
   * Visibility is re-derived from LIVE participation via the canonical authority
   * (`userParticipates`), NOT a hand-written `EXISTS(conversation_users)`: a
   * roster seat is inert on a non-workspace conversation, so an EXISTS-on-seat
   * gate returns false for every `direct_pair` and would silently drop DM saves
   * from the list even though they persist and read by id (contract §6b/§7).
   * The workspace arm of `userParticipates` is STRICTER than a bare seat — it
   * additionally requires live `workspace_users` membership (v25) — so a user
   * removed from a workspace but holding a stale seat no longer sees their saved
   * rows there. That is the intended fail-closed semantics, not a regression.
   * The `workspaceId` filter runs on the derived `conv.workspace_id` (the row no
   * longer carries its own copy), so an unknown/hidden id simply yields no rows
   * on top of the participation gate.
   *
   * `sender` (#task:2059) narrows by author. It matches the STABLE send-time
   * snapshot — `m.from_kind` + `m.author_id` — NOT the live FK
   * (`from_agent_id`/`from_user_id`), which `ON DELETE SET NULL` clears when the
   * actor is hard-deleted: an FK predicate would silently drop every saved
   * message from a since-deleted sender. This is the same author-identity rule
   * `MessageRepo`'s distinct-replier grouping already uses (#task:1791). Rows
   * with no stable identity at all (legacy pre-snapshot deletes, `author_id
   * IS NULL` → `unresolved`) are unfilterable by construction and are simply not
   * matched by any sender. An unknown sender id matches nothing rather than
   * erroring, so the filter is not an existence oracle.
   */
  listForUser(
    userId: string,
    opts: {
      workspaceId?: string;
      since?: number;
      limit?: number;
      sender?: { kind: 'user' | 'agent'; id: string };
    } = {},
  ): SavedMessageDto[] {
    const { workspaceId, since, limit = 200, sender } = opts;
    const participation = userParticipates('conv', userId);
    const conds = ['sm.user_id = ?', participation.sql];
    const params: (string | number)[] = [userId, ...participation.params];
    if (workspaceId !== undefined) {
      conds.push('conv.workspace_id = ?');
      params.push(workspaceId);
    }
    if (sender !== undefined) {
      conds.push('m.from_kind = ?');
      conds.push('m.author_id = ?');
      params.push(sender.kind, sender.id);
    }
    if (since !== undefined) {
      conds.push('sm.saved_at >= ?');
      params.push(since);
    }
    params.push(limit);
    const rows = this.db
      .prepare<(string | number)[], JoinedRow>(
        `${SELECT_JOINED}
         WHERE ${conds.join('\n           AND ')}
         ORDER BY sm.saved_at DESC
         LIMIT ?`,
      )
      .all(...params);
    const authors = this.resolveAuthors(rows);
    return rows.map((r, i) => rowToDto(r, authors[i] ?? null));
  }


  /** Returns the existing row when the message was already saved
   *  (UNIQUE(user_id, message_id) makes this idempotent on the client). */
  save(messageId: string, userId: string): SavedMessageDto | null {
    // Resolve the canonical conversation + placement from the message; workspace
    // is no longer copied onto the saved row (v81 dropped `workspace_id` — it is
    // derived from `conv.workspace_id` at read). INSERT OR IGNORE keeps save()
    // idempotent (returns the existing row on duplicate).
    const ctx = this.db
      .prepare<
        [string],
        {
          conversation_id: string;
          placement_kind: ConversationPlacementKind;
        }
      >(
        `SELECT
           m.conversation_id AS conversation_id,
           conv.placement_kind AS placement_kind
         FROM messages m
         JOIN conversations conv ON conv.id = m.conversation_id
         WHERE m.id = ?`,
      )
      .get(messageId);
    if (!ctx) return null;
    // Placement (§4.1): Saved is a HUMAN artifact, so it can only exist for a
    // placement a human participates in — a `workspace` channel or a
    // `direct_pair`. `agent_inbox` (or any future non-participatory placement)
    // has no human participant, so the route's ACL (`canViewConversation`) has
    // already refused; reaching this line means the ACL was bypassed, a routing
    // bug. Assert loudly rather than lean on a storage constraint: `INSERT OR
    // IGNORE` would suppress a violation exactly as it suppresses the duplicate
    // it is there for, silently returning `null` (indistinguishable from
    // "message not found"). This is the fail-closed write gate the read
    // projection relies on to never see a non-saveable placement.
    if (ctx.placement_kind !== 'workspace' && ctx.placement_kind !== 'direct_pair') {
      throw new SavedPlacementError(ctx.conversation_id, ctx.placement_kind);
    }
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO saved_messages
         (id, user_id, message_id, conversation_id, saved_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        messageId,
        ctx.conversation_id,
        now,
      );
    return this.getByMessageIdForUser(messageId, userId);
  }

  /** Fetch-by-(message,user) used ONLY as `save()`'s post-write echo, behind the
   *  route's `canViewConversation` ACL. It self-limits on `sm.user_id` but does
   *  NOT re-derive live participation the way `listForUser` does — deliberately:
   *  the sole caller has already been ACL'd and is reading back the row it just
   *  wrote, so there is no reachable path where a no-longer-participant reads a
   *  stale row here (contract §4-B, decision ②). Any FUTURE standalone reader of
   *  saved rows MUST add the `userParticipates` gate before relying on this. */
  getByMessageIdForUser(messageId: string, userId: string): SavedMessageDto | null {
    const row = this.db
      .prepare<[string, string], JoinedRow>(
        `${SELECT_JOINED}
         WHERE sm.message_id = ?
           AND sm.user_id = ?`,
      )
      .get(messageId, userId);
    if (!row) return null;
    return rowToDto(row, this.resolveAuthors([row])[0] ?? null);
  }

  /** Returns true when a row was deleted; false when nothing to unsave. */
  remove(messageId: string, userId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM saved_messages WHERE message_id = ? AND user_id = ?')
      .run(messageId, userId);
    return result.changes > 0;
  }

  /** Bulk lookup so MessageList can mark which messages are saved
   *  without one round-trip per row. Returns the set of saved message_ids
   *  among the input. */
  filterSaved(messageIds: string[], userId: string): Set<string> {
    if (messageIds.length === 0) return new Set();
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<string[], { message_id: string }>(
        `SELECT message_id
           FROM saved_messages
          WHERE user_id = ?
            AND message_id IN (${placeholders})`,
      )
      .all(userId, ...messageIds);
    return new Set(rows.map(r => r.message_id));
  }
}
