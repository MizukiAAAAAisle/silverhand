import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { ReactorKind } from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * Persistence for `message_reactions` (docs/reactions-design.md §3.1 / §4).
 *
 * Pure data layer: insert / delete / count on the reactions table ONLY.
 * It deliberately knows nothing about message seq, `conversations
 * .latest_message_seq`, or `conversation_stream_heads` — a reaction write
 * must never advance any of them (the CAS-exclusion invariant §12.A). Keeping
 * those writes physically absent from this repo is the structural guarantee;
 * the S1 test asserts it from the outside.
 *
 * Aggregate / detail READS live in `read-model/message-reactions.ts`, not
 * here (§12.B): viewer-scoped projection is a read-model concern.
 */
export class MessageReactionRepo {
  constructor(private readonly db: Db) {}

  /** Idempotent add. ON CONFLICT DO NOTHING over the unique four-tuple, so a
   *  double-click / CLI retry of the same (reactor, emoji) is a safe no-op.
   *  Returns whether a new row was actually created (drives whether an `add`
   *  event is published — re-adding an existing reaction emits nothing). */
  add(
    messageId: string,
    reactorKind: ReactorKind,
    reactorId: string,
    emoji: string,
    now: number,
  ): { created: boolean } {
    const result = this.db
      .prepare(
        `INSERT INTO message_reactions
           (id, message_id, reactor_kind, reactor_id, emoji, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id, reactor_kind, reactor_id, emoji)
           DO NOTHING`,
      )
      .run(newId(), messageId, reactorKind, reactorId, emoji, now);
    return { created: result.changes > 0 };
  }

  /** Idempotent remove. Deleting a non-existent reaction is a no-op.
   *  Returns whether a row was actually removed (drives whether a `remove`
   *  event is published). */
  remove(
    messageId: string,
    reactorKind: ReactorKind,
    reactorId: string,
    emoji: string,
  ): { removed: boolean } {
    const result = this.db
      .prepare(
        `DELETE FROM message_reactions
          WHERE message_id = ?
            AND reactor_kind = ?
            AND reactor_id = ?
            AND emoji = ?`,
      )
      .run(messageId, reactorKind, reactorId, emoji);
    return { removed: result.changes > 0 };
  }

  /** Post-change authoritative count for one (message, emoji) — the count
   *  carried on the `message_reaction_changed` event so the renderer can set
   *  it absolutely rather than +/- by op (§5.2). */
  countForEmoji(messageId: string, emoji: string): number {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n
           FROM message_reactions
          WHERE message_id = ? AND emoji = ?`,
      )
      .get(messageId, emoji);
    return row?.n ?? 0;
  }
}
