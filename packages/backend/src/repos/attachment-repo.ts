import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  AttachmentCreatorKind,
  AttachmentDto,
  AttachmentListItem,
  AttachmentListItemSource,
  AttachmentRow,
  AttachmentSenderFacet,
  AttachmentSnapshot,
  FromKind,
  StorageKind,
} from '@silverhand/shared';
import { decodeMessageSeq } from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

export interface InsertAttachmentInput {
  /** Channel-like conversation id (channel/dm_channel) — access boundary. */
  channelId: string;
  /** The conversation that originated this upload (channel or thread). */
  sourceConversationId: string | null;
  filename: string;
  size: number;
  contentType: string;
  storage: StorageKind;
  storageKey: string;
  createdByKind: AttachmentCreatorKind;
  createdById: string;
}

// ── Channel Attachments listing (#task:1481) ──────────────────────────────
//
// Cursor and typed-error idiom mirrors `MessageRepo.listChannelThreads`: an
// opaque base64url-JSON tuple `[appeared_at, attachment_id]`, decoded into a
// typed error so a tampered / stale-format token yields a clean 400 rather
// than a 500. Callers that surface the route are responsible for translating.

export interface AttachmentListCursor {
  appearedAt: number;
  attachmentId: string;
}

export class InvalidAttachmentListCursorError extends Error {
  constructor(public readonly cursor: string) {
    super(`invalid attachment list cursor: ${cursor}`);
    this.name = 'InvalidAttachmentListCursorError';
  }
}

export function encodeAttachmentListCursor(
  cursor: AttachmentListCursor,
): string {
  return Buffer.from(
    JSON.stringify([cursor.appearedAt, cursor.attachmentId]),
    'utf8',
  ).toString('base64url');
}

export function decodeAttachmentListCursor(raw: string): AttachmentListCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'number' &&
      Number.isFinite(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      parsed[1].length > 0
    ) {
      return { appearedAt: parsed[0], attachmentId: parsed[1] };
    }
  } catch {
    // fall through to the typed throw
  }
  throw new InvalidAttachmentListCursorError(raw);
}

/** SELECT-row shape from `listChannelReferences` before it's turned into the
 *  wire DTO. Attachment columns are prefixed `a_` so the row stays flat while
 *  SQLite unions the JOIN without a projection layer. */
interface ChannelAttachmentRefRow {
  attachment_id: string;
  message_id: string;
  message_conversation_id: string;
  thread_root_id: string | null;
  message_seq: number;
  from_kind: FromKind;
  from_user_id: string | null;
  from_agent_id: string | null;
  appeared_at: number;
  a_id: string;
  a_channel_id: string;
  a_source_conversation_id: string | null;
  a_filename: string;
  a_size: number;
  a_content_type: string;
  a_storage: StorageKind;
  a_created_by_kind: AttachmentCreatorKind;
  a_created_by_id: string;
  a_created_at: number;
}

function refRowToListItem(row: ChannelAttachmentRefRow): AttachmentListItem {
  const attachment: AttachmentDto = {
    id: row.a_id,
    channel_id: row.a_channel_id,
    source_conversation_id: row.a_source_conversation_id,
    filename: row.a_filename,
    size: row.a_size,
    content_type: row.a_content_type,
    storage: row.a_storage,
    created_by_kind: row.a_created_by_kind,
    created_by_id: row.a_created_by_id,
    created_at: row.a_created_at,
  };
  const source: AttachmentListItemSource = {
    message_id: row.message_id,
    conversation_id: row.message_conversation_id,
    thread_root_id: row.thread_root_id,
    message_seq: decodeMessageSeq(row.message_seq),
    from_kind: row.from_kind,
    from_user_id: row.from_user_id,
    from_agent_id: row.from_agent_id,
    appeared_at: row.appeared_at,
  };
  return { attachment, source };
}

export interface ListChannelAttachmentsOpts {
  /** Page size after dedup; caller-clamped to [1, 100]. */
  limit: number;
  cursor?: AttachmentListCursor | null;
  /** Optional sender filter, applied to the CANONICAL row (post-dedup). A
   *  discriminated identity: `user`/`agent` carry a non-null `id`, `system`
   *  carries `id: null`. Route validates the shape; the repo trusts it. */
  sender?: AttachmentSenderFilter | null;
  /** Half-open canonical-`appeared_at` window: `since` inclusive, `until`
   *  exclusive. Either bound may be null (open on that side). */
  since?: number | null;
  until?: number | null;
}

/** Discriminated sender identity for the list filter. `id` is the user id for
 *  `user`, the agent id for `agent`, and null for `system`. */
export interface AttachmentSenderFilter {
  kind: FromKind;
  id: string | null;
}

export interface ChannelAttachmentsPage {
  items: AttachmentListItem[];
  next_cursor: AttachmentListCursor | null;
}

/**
 * Shared canonical-refs CTE. Produces `refs`: one row per persisted attachment
 * reference in the channel, tagged with `rn` that is 1 on the canonical
 * (earliest) reference — chosen deterministically by (appeared_at ASC,
 * message_id ASC). BOTH the list query and the sender-facets query embed this
 * SAME fragment, so "the facets reflect the exact set the list filters over" is
 * a structural fact rather than a comment maintained across two copies of the
 * scan; a future correctness fix to the JSON guard or the dedup lands in one
 * place for both.
 *
 * Binds `@channelId`. Thread replies live under the parent channel's
 * conversation_id, so the single `m.conversation_id = @channelId` predicate
 * covers main-line + thread references.
 *
 * Fail-closed JSON. `messages.metadata` has no `json_valid` CHECK, so a
 * historical or tampered row could hold malformed JSON or a non-array
 * `attachments` value. Every extraction is wrapped in an OUTER `CASE` that
 * yields `'[]'` when the shape is not `attachments: [{id}, ...]` — nested
 * `CASE`, not an `AND`-chain, so correctness does not depend on SQLite's
 * predicate / short-circuit order. The item guard
 * (`typeof(attachment_id)='text' AND <> ''`) then drops malformed items in the
 * `refs` projection. A single malformed row never faults the whole scan.
 */
const CANONICAL_REFS_CTE = `raw AS (
           SELECT
             m.id                            AS message_id,
             m.conversation_id               AS message_conversation_id,
             m.thread_root_id                AS thread_root_id,
             m.seq                           AS message_seq,
             m.from_kind                     AS from_kind,
             m.from_user_id                  AS from_user_id,
             m.from_agent_id                 AS from_agent_id,
             m.created_at                    AS appeared_at,
             CASE
               WHEN je.type = 'object'
                 THEN json_extract(je.value, '$.id')
               ELSE NULL
             END                             AS attachment_id
           FROM messages m,
                json_each(
                  CASE
                    WHEN json_valid(m.metadata) THEN
                      CASE
                        WHEN json_type(m.metadata, '$.attachments') = 'array'
                          THEN json_extract(m.metadata, '$.attachments')
                        ELSE '[]'
                      END
                    ELSE '[]'
                  END
                ) je
          WHERE m.conversation_id = @channelId
         ),
         refs AS (
           SELECT
             attachment_id, message_id, message_conversation_id, thread_root_id,
             message_seq, from_kind, from_user_id, from_agent_id, appeared_at,
             ROW_NUMBER() OVER (
               PARTITION BY attachment_id
               ORDER BY appeared_at ASC, message_id ASC
             ) AS rn
           FROM raw
          WHERE typeof(attachment_id) = 'text'
            AND attachment_id <> ''
         )`;

export class AttachmentRepo {
  constructor(private readonly db: Db) {}

  insert(input: InsertAttachmentInput): AttachmentDto {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO attachments
         (id, channel_id, source_conversation_id, filename, size, content_type,
          storage, storage_key, created_by_kind, created_by_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.sourceConversationId,
        input.filename,
        input.size,
        input.contentType,
        input.storage,
        input.storageKey,
        input.createdByKind,
        input.createdById,
        now,
      );
    const row = this.requireRow(id);
    return rowToDto(row);
  }

  getById(id: string): AttachmentRow | null {
    const row = this.db
      .prepare<[string], AttachmentRow>('SELECT * FROM attachments WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  /** Many-row variant for resolving message snapshots in a single query. */
  listByIds(ids: string[]): AttachmentRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db
      .prepare<string[], AttachmentRow>(
        `SELECT * FROM attachments WHERE id IN (${placeholders})`,
      )
      .all(...ids);
  }

  /** All blobs owned by a channel — used at channel-delete time so the
   *  application layer can sweep physical files (DB rows go via CASCADE). */
  listByChannel(channelId: string): AttachmentRow[] {
    return this.db
      .prepare<[string], AttachmentRow>(
        'SELECT * FROM attachments WHERE channel_id = ?',
      )
      .all(channelId);
  }

  /** True if any persisted message snapshot references this attachment id.
   *  Uses SQLite JSON1 to walk `metadata.attachments[*].id`. */
  isReferencedByMessage(id: string): boolean {
    const row = this.db
      .prepare<[string], { hit: number }>(
        `SELECT 1 AS hit
           FROM messages, json_each(json_extract(messages.metadata, '$.attachments'))
          WHERE json_extract(value, '$.id') = ?
          LIMIT 1`,
      )
      .get(id);
    return row !== undefined;
  }

  /** True if a persisted message IN THIS CHANNEL references `attachmentId`.
   *
   *  This is the "in-message" boundary for a public non-member's byte read:
   *  the locked surface is "message-embedded attachment preview", NOT "every
   *  attachment row under a public channel". An unsent composer upload
   *  (orphan/draft) has no persisted reference, so it stays closed.
   *
   *  Differs from `isReferencedByMessage` on two axes that both matter here and
   *  are absent there — do NOT collapse them:
   *    - CHANNEL-SCOPED: `m.conversation_id = @channelId`. The metadata snapshot
   *      is untrusted content; a legacy or tampered row in another channel
   *      could carry this id, so the channel bound is the authoritative
   *      reassertion (mirrors the `attachments`-join guard in
   *      `CANONICAL_REFS_CTE` / `listChannelReferences`).
   *    - FAIL-CLOSED on untrusted JSON, order-independently. Two guard layers,
   *      both matching `CANONICAL_REFS_CTE`:
   *        (1) whole-metadata: `json_valid` + `json_type='array'` → a malformed
   *            `metadata`, or an `attachments` that isn't an array, contributes
   *            zero refs rather than faulting;
   *        (2) per-item: the id extraction lives INSIDE
   *            `CASE WHEN je.type='object' THEN json_extract(...) ELSE NULL END`,
   *            NOT as an `AND`-guarded predicate. A valid array may still hold a
   *            scalar element (`{"attachments":["oops",{"id":...}]}`);
   *            `json_extract('oops','$.id')` raises "malformed JSON", and SQL
   *            does NOT guarantee the `je.type` predicate short-circuits first.
   *            The CASE makes it a single expression so extraction never runs on
   *            a non-object — healthy refs in the same array still match.
   *      Either omission surfaces as a 500 on hostile/legacy content. */
  isReferencedByChannelMessage(attachmentId: string, channelId: string): boolean {
    const row = this.db
      .prepare<{ attachmentId: string; channelId: string }, { hit: number }>(
        `SELECT 1 AS hit
           FROM messages m,
                json_each(
                  CASE
                    WHEN json_valid(m.metadata) THEN
                      CASE
                        WHEN json_type(m.metadata, '$.attachments') = 'array'
                          THEN json_extract(m.metadata, '$.attachments')
                        ELSE '[]'
                      END
                    ELSE '[]'
                  END
                ) je
          WHERE m.conversation_id = @channelId
            AND CASE
                  WHEN je.type = 'object'
                    THEN json_extract(je.value, '$.id')
                  ELSE NULL
                END = @attachmentId
          LIMIT 1`,
      )
      .get({ attachmentId, channelId });
    return row !== undefined;
  }

  /**
   * Page channel attachments back through persisted message references. The
   * channel's authoritative view is "attachments that appear in persisted
   * messages", NOT "rows in the attachments table" — an unsent composer upload
   * is an orphan and would leak into the panel if we scanned the table directly
   * (see `attachmentService.deleteOrphan` for the mirror side of that
   * boundary). The orphan-exclusion + dedup + earliest-source selection all
   * live in the shared `CANONICAL_REFS_CTE`.
   *
   * The `attachments` join is on both `id` AND `channel_id` — the metadata
   * snapshot is untrusted content (a legacy or tampered row could reference an
   * attachment from another channel), so this join is the authoritative
   * channel-boundary reassertion. Route-level `canViewConversation` gates on
   * the message's channel; without this join filter the panel would hydrate
   * cross-channel blobs.
   *
   * Keyset paginates by `(appeared_at, attachment_id)` DESC, fetching limit+1
   * so the caller knows whether a next page exists.
   *
   * Filters (sender / time) are applied to the CANONICAL row, AFTER the dedup
   * (`WHERE r.rn = 1`) — never to raw refs. Filtering refs before the dedup
   * would let the same attachment's canonical source / jump target drift
   * between filter states; the canonical source is a stable property, so the
   * filter reads exactly the `from_*` / `appeared_at` the panel renders. The
   * time window is half-open `[since, until)` on the canonical `appeared_at`,
   * which is also the sort + cursor key, so it composes with the keyset page.
   */
  listChannelReferences(
    channelId: string,
    opts: ListChannelAttachmentsOpts,
  ): ChannelAttachmentsPage {
    const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit)));
    const cursor = opts.cursor ?? null;
    const sender = opts.sender ?? null;
    const rows = this.db
      .prepare<
        {
          channelId: string;
          cursorAt: number | null;
          cursorId: string | null;
          senderKind: FromKind | null;
          senderUserId: string | null;
          senderAgentId: string | null;
          since: number | null;
          until: number | null;
          limit: number;
        },
        ChannelAttachmentRefRow
      >(
        `WITH ${CANONICAL_REFS_CTE}
         SELECT
           r.attachment_id           AS attachment_id,
           r.message_id              AS message_id,
           r.message_conversation_id AS message_conversation_id,
           r.thread_root_id          AS thread_root_id,
           r.message_seq             AS message_seq,
           r.from_kind               AS from_kind,
           r.from_user_id            AS from_user_id,
           r.from_agent_id           AS from_agent_id,
           r.appeared_at             AS appeared_at,
           a.id                      AS a_id,
           a.channel_id              AS a_channel_id,
           a.source_conversation_id  AS a_source_conversation_id,
           a.filename                AS a_filename,
           a.size                    AS a_size,
           a.content_type            AS a_content_type,
           a.storage                 AS a_storage,
           a.created_by_kind         AS a_created_by_kind,
           a.created_by_id           AS a_created_by_id,
           a.created_at              AS a_created_at
           FROM refs r
           JOIN attachments a
             ON a.id = r.attachment_id
            AND a.channel_id = @channelId
          WHERE r.rn = 1
            AND (
              @senderKind IS NULL
              OR (
                r.from_kind = @senderKind
                AND (@senderUserId IS NULL OR r.from_user_id = @senderUserId)
                AND (@senderAgentId IS NULL OR r.from_agent_id = @senderAgentId)
              )
            )
            AND (@since IS NULL OR r.appeared_at >= @since)
            AND (@until IS NULL OR r.appeared_at < @until)
            AND (
              @cursorAt IS NULL
              OR r.appeared_at < @cursorAt
              OR (r.appeared_at = @cursorAt AND r.attachment_id < @cursorId)
            )
          ORDER BY r.appeared_at DESC, r.attachment_id DESC
          LIMIT @limit`,
      )
      .all({
        channelId,
        cursorAt: cursor?.appearedAt ?? null,
        cursorId: cursor?.attachmentId ?? null,
        senderKind: sender?.kind ?? null,
        senderUserId: sender?.kind === 'user' ? sender.id : null,
        senderAgentId: sender?.kind === 'agent' ? sender.id : null,
        since: opts.since ?? null,
        until: opts.until ?? null,
        limit: limit + 1,
      });
    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const items = trimmed.map(refRowToListItem);
    const tail = trimmed[trimmed.length - 1];
    const next_cursor: AttachmentListCursor | null =
      hasMore && tail
        ? {
            appearedAt: tail.appeared_at,
            attachmentId: tail.attachment_id,
          }
        : null;
    return { items, next_cursor };
  }

  /**
   * Distinct canonical-source actors for a channel's Attachments panel sender
   * filter. Embeds the SAME `CANONICAL_REFS_CTE` as `listChannelReferences`,
   * then projects the distinct `(from_kind, from_user_id, from_agent_id)` of the
   * canonical rows — so the facet set is, structurally, the exact set the list
   * filters over.
   *
   * It reflects only actors that are the EARLIEST reference of at least one
   * attachment — the set the list actually filters over. An actor who only ever
   * re-shared an existing blob is never a canonical source, so omitting them
   * keeps the dropdown from offering an option that yields zero rows.
   *
   * Wire-expressibility guard. `messages.from_{user,agent}_id` are ON DELETE
   * SET NULL, so a canonical source whose actor was hard-deleted survives as a
   * `from_kind` with a NULL id. Separately, `messages` has no actor-shape CHECK,
   * so a historical / tampered row could carry a cross-shaped actor (a `user`
   * with an agent id, a `system` with any id). Either way the row cannot be
   * named by the list's sender wire and is rejected by the discriminated
   * `AttachmentSenderFacet` — and the route only TS-annotates the response (no
   * runtime parse), so an illegal facet would reach the wire. The guard is
   * therefore the EXACT structural mirror of the union: a `user` carries a
   * non-empty user id and NO agent id, an `agent` a non-empty agent id and NO
   * user id, `system` neither. A dangling / cross-shaped actor is excluded from
   * the facet set (the attachment still appears in the unfiltered list; only
   * the unusable filter option is withheld).
   *
   * Identity only — no display_name / avatar. Deterministic order (`from_kind`,
   * then the actor id) so the payload never drifts with the query plan; the
   * renderer re-sorts by resolved label. Time-independent by design.
   */
  listChannelSenderFacets(channelId: string): AttachmentSenderFacet[] {
    return this.db
      .prepare<{ channelId: string }, AttachmentSenderFacet>(
        `WITH ${CANONICAL_REFS_CTE}
         SELECT DISTINCT
           r.from_kind      AS from_kind,
           r.from_user_id   AS from_user_id,
           r.from_agent_id  AS from_agent_id
           FROM refs r
           JOIN attachments a
             ON a.id = r.attachment_id
            AND a.channel_id = @channelId
          WHERE r.rn = 1
            AND (
              (r.from_kind = 'user'
                 AND r.from_user_id IS NOT NULL AND r.from_user_id <> ''
                 AND r.from_agent_id IS NULL)
              OR (r.from_kind = 'agent'
                 AND r.from_agent_id IS NOT NULL AND r.from_agent_id <> ''
                 AND r.from_user_id IS NULL)
              OR (r.from_kind = 'system'
                 AND r.from_user_id IS NULL AND r.from_agent_id IS NULL)
            )
          ORDER BY r.from_kind ASC,
                   COALESCE(r.from_user_id, r.from_agent_id) ASC`,
      )
      .all({ channelId });
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  }

  private requireRow(id: string): AttachmentRow {
    const row = this.getById(id);
    if (!row) throw new Error(`attachment row missing after insert: ${id}`);
    return row;
  }
}

export function rowToDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    channel_id: row.channel_id,
    source_conversation_id: row.source_conversation_id,
    filename: row.filename,
    size: row.size,
    content_type: row.content_type,
    storage: row.storage,
    created_by_kind: row.created_by_kind,
    created_by_id: row.created_by_id,
    created_at: row.created_at,
  };
}

export function rowToSnapshot(row: AttachmentRow): AttachmentSnapshot {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    content_type: row.content_type,
  };
}
