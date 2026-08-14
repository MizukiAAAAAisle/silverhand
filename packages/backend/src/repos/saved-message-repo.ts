import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { decodeMessageSeq, requireWorkspacePlacement } from '@silverhand/shared';
import type {
  ConversationPlacementKind,
  MessageRow,
  SavedMessageRow,
  SavedMessageDto,
  MessageAuthorDto,
  MessageAuthorRow,
} from '@silverhand/shared';
import {
  LINKED_TASK_JOINS,
  LINKED_TASK_SELECT,
  linkedTaskFromRow,
  type LinkedTaskProjectionRow,
} from './message-repo.js';
import { loadMessageAuthors } from './message-author.js';

function newId(): string {
  return randomBytes(12).toString('base64url');
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
  workspace_name: string;
  conversation_title: string;
  channel_id: string;
  agent_name: string | null;
}

function rowToDto(row: JoinedRow, author: MessageAuthorDto | null): SavedMessageDto {
  return {
    id: row.id,
    saved_at: row.saved_at,
    workspace_id: row.workspace_id!,
    workspace_name: row.workspace_name,
    conversation_id: row.conversation_id!,
    conversation_title: row.conversation_title,
    channel_id: row.channel_id,
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
 *  Placement (§4.1/§6): Saved is a HUMAN artifact of a workspace-placed
 *  conversation, and the exclusion is enforced on the WRITE side, not by the
 *  `JOIN workspaces` here: `save()` asserts the workspace arm before inserting,
 *  so a message from a placement without a workspace is refused loudly instead
 *  of producing a row this projection would then silently drop. (The route's ACL
 *  refuses first: a human is never a participant of such a placement, §4.2.) */
const SELECT_JOINED = `
  SELECT
    sm.id              AS id,
    sm.user_id         AS user_id,
    sm.message_id      AS message_id,
    sm.conversation_id AS conversation_id,
    sm.workspace_id    AS workspace_id,
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
    w.name             AS workspace_name,
    conv.title         AS conversation_title,
    conv.id            AS channel_id,
    a.name             AS agent_name
  FROM saved_messages sm
  JOIN messages m ON m.id = sm.message_id
  JOIN conversations conv ON conv.id = sm.conversation_id
  JOIN workspaces w ON w.id = conv.workspace_id
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

  list(limit = 200): SavedMessageDto[] {
    const rows = this.db
      .prepare<[number], JoinedRow>(
        `${SELECT_JOINED}
         ORDER BY sm.saved_at DESC
         LIMIT ?`,
      )
      .all(limit);
    const authors = this.resolveAuthors(rows);
    return rows.map((r, i) => rowToDto(r, authors[i] ?? null));
  }

  /**
   * The viewer's saved messages, newest-saved first. Filters (`workspaceId` /
   * `since`) are applied in the WHERE clause — BEFORE `ORDER BY saved_at DESC
   * LIMIT` — so they narrow the whole saved history, not just the capped window
   * a client would otherwise filter (#task:1258, mirrors archived-channels).
   * `since` is `saved_at >= since` (save-time window, epoch ms). Membership is
   * always enforced (`sm.user_id` + `conversation_users`), so an unknown/hidden
   * `workspaceId` simply yields no rows on top of that gate.
   */
  listForUser(
    userId: string,
    opts: { workspaceId?: string; since?: number; limit?: number } = {},
  ): SavedMessageDto[] {
    const { workspaceId, since, limit = 200 } = opts;
    const conds = [
      'sm.user_id = ?',
      `EXISTS (
         SELECT 1
           FROM conversation_users cu
          WHERE cu.conversation_id = sm.conversation_id
            AND cu.user_id = ?
       )`,
    ];
    const params: (string | number)[] = [userId, userId];
    if (workspaceId !== undefined) {
      conds.push('sm.workspace_id = ?');
      params.push(workspaceId);
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
    // Resolve canonical conversation/workspace from the message; INSERT OR
    // IGNORE makes save() idempotent (returns the existing row on duplicate).
    const ctx = this.db
      .prepare<
        [string],
        {
          conversation_id: string;
          workspace_id: string | null;
          placement_kind: ConversationPlacementKind;
        }
      >(
        `SELECT
           m.conversation_id AS conversation_id,
           conv.workspace_id AS workspace_id,
           conv.placement_kind AS placement_kind
         FROM messages m
         JOIN conversations conv ON conv.id = m.conversation_id
         WHERE m.id = ?`,
      )
      .get(messageId);
    if (!ctx) return null;
    // Placement (§4.1): `saved_messages.workspace_id` is NOT NULL, but the
    // constraint CANNOT be the guard here — `INSERT OR IGNORE` suppresses a
    // NOT NULL violation exactly like it suppresses the duplicate it is there
    // for, so a workspace-less placement would skip the row silently and this
    // method would report "not saved" as `null`, indistinguishable from
    // "message not found". Assert instead: Saved is a workspace-scoped human
    // artifact, and a human is never a participant of a non-workspace
    // placement (§4.2), so the route's ACL has already refused — reaching this
    // line means the ACL was bypassed, which is a routing bug and not an
    // outcome to encode in the return type.
    const workspaceId = requireWorkspacePlacement({
      id: ctx.conversation_id,
      workspace_id: ctx.workspace_id,
      placement_kind: ctx.placement_kind,
    });
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO saved_messages
         (id, user_id, message_id, conversation_id, workspace_id, saved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        messageId,
        ctx.conversation_id,
        workspaceId,
        now,
      );
    return this.getByMessageIdForUser(messageId, userId);
  }

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
