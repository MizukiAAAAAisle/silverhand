import type { Database as Db } from 'better-sqlite3';
import type { SessionReadRow } from '@silverhand/shared';

export interface MessageUnreadBySession {
  by_session: Record<string, number>;
  total: number;
}

export class SessionReadRepo {
  constructor(private readonly db: Db) {}

  markRead(params: {
    viewerUserId: string;
    sessionId: string;
    seq?: number | null;
  }): SessionReadRow {
    const targetSeq = params.seq ?? this.latestSeq(params.sessionId);
    const now = Date.now();
    this.db
      .prepare<[string, string, number, number]>(
        `INSERT INTO session_reads
         (user_id, session_id, last_read_seq, read_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, session_id) DO UPDATE SET
           last_read_seq = max(session_reads.last_read_seq, excluded.last_read_seq),
           read_at = excluded.read_at`,
      )
      .run(params.viewerUserId, params.sessionId, targetSeq, now);

    const row = this.db
      .prepare<[string, string], SessionReadRow>(
        `SELECT * FROM session_reads WHERE user_id = ? AND session_id = ?`,
      )
      .get(params.viewerUserId, params.sessionId);
    if (!row) throw new Error('session read upsert failed');
    return row;
  }

  unreadCountsBySessionForChannel(
    channelId: string,
    viewerUserId: string,
  ): MessageUnreadBySession {
    const rows = this.db
      .prepare<[string, string, string], { session_id: string; c: number }>(
        `SELECT s.id AS session_id, COUNT(m.id) AS c
           FROM sessions s
           JOIN messages m
             ON m.session_id = s.id
            AND m.seq > COALESCE(
              (
                SELECT sr.last_read_seq
                  FROM session_reads sr
                 WHERE sr.user_id = ?
                   AND sr.session_id = s.id
              ),
              0
            )
            AND NOT (
              m.from_kind = 'user'
              AND (m.from_user_id = ? OR m.from_user_id IS NULL)
            )
          WHERE s.channel_id = ?
          GROUP BY s.id`,
      )
      .all(viewerUserId, viewerUserId, channelId);

    const bySession: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      bySession[row.session_id] = row.c;
      total += row.c;
    }
    return { by_session: bySession, total };
  }

  unreadCountsByChannel(viewerUserId: string): Record<string, number> {
    const rows = this.db
      .prepare<[string, string], { channel_id: string; c: number }>(
        `SELECT s.channel_id AS channel_id, COUNT(m.id) AS c
           FROM sessions s
           JOIN messages m
             ON m.session_id = s.id
            AND m.seq > COALESCE(
              (
                SELECT sr.last_read_seq
                  FROM session_reads sr
                 WHERE sr.user_id = ?
                   AND sr.session_id = s.id
              ),
              0
            )
            AND NOT (
              m.from_kind = 'user'
              AND (m.from_user_id = ? OR m.from_user_id IS NULL)
            )
          GROUP BY s.channel_id`,
      )
      .all(viewerUserId, viewerUserId);

    const byChannel: Record<string, number> = {};
    for (const row of rows) byChannel[row.channel_id] = row.c;
    return byChannel;
  }

  private latestSeq(sessionId: string): number {
    const row = this.db
      .prepare<[string], { seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE session_id = ?`,
      )
      .get(sessionId);
    return row?.seq ?? 0;
  }
}
