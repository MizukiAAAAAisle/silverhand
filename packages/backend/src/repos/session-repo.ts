import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  ChildSessionLimits,
  SessionAgentDto,
  SessionAgentRow,
  SessionDto,
  SessionRow,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function rowToDto(row: SessionRow): SessionDto {
  return { ...row };
}

export interface SpawnLimitContext {
  limits: ChildSessionLimits;
  /** Last spawn timestamps per agent — maintained in-process. */
  lastSpawnAtByAgent: Map<string, number>;
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  list(): SessionDto[] {
    const rows = this.db
      .prepare<[], SessionRow>('SELECT * FROM sessions ORDER BY updated_at DESC')
      .all();
    return rows.map(rowToDto);
  }

  listForChannel(channelId: string): SessionDto[] {
    const rows = this.db
      .prepare<[string], SessionRow>(
        `SELECT * FROM sessions
         WHERE channel_id = ?
         ORDER BY (parent_session_id IS NULL) DESC,
                  parent_session_id,
                  created_at ASC`,
      )
      .all(channelId);
    return rows.map(rowToDto);
  }

  listChildren(parentId: string): SessionDto[] {
    const rows = this.db
      .prepare<[string], SessionRow>(
        `SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC`,
      )
      .all(parentId);
    return rows.map(rowToDto);
  }

  countActiveChildren(parentId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c
         FROM sessions
         WHERE parent_session_id = ? AND closed_at IS NULL`,
      )
      .get(parentId);
    return row?.c ?? 0;
  }

  /**
   * Find an existing un-closed thread child session anchored to the
   * given source message, so the UI can reuse it instead of creating
   * a new one when the user clicks Thread on the same message twice.
   *
   * Identifies the link via the `thread_anchor` system message metadata
   * written by the thread route; SQLite's `json_extract` reads it
   * straight out of the TEXT column.
   */
  findOpenThreadChild(parentId: string, anchorMessageId: string): SessionDto | null {
    const row = this.db
      .prepare<[string, string], SessionRow>(
        `SELECT s.*
         FROM sessions s
         JOIN messages m ON m.session_id = s.id
         WHERE s.parent_session_id = ?
           AND s.closed_at IS NULL
           AND m.from_kind = 'system'
           AND json_extract(m.metadata, '$.subtype') = 'thread_anchor'
           AND json_extract(m.metadata, '$.quoted_message_id') = ?
         ORDER BY s.created_at DESC
         LIMIT 1`,
      )
      .get(parentId, anchorMessageId);
    return row ? rowToDto(row) : null;
  }

  /**
   * Bulk lookup of OPEN threads under a parent session, used to render
   * the per-message "{count} Reply" badge on the parent's chat view.
   *
   * Returns one row per open child + its anchor message id + the count
   * of non-system messages in the child (so anchor + onboarding seeds
   * don't inflate the badge — count == 0 means "thread exists, no
   * actual replies yet").
   *
   * Single SQL: outer join the child sessions to their thread_anchor
   * system message (1:1 by construction) and a correlated COUNT
   * subquery. Both joins/scans hit existing indexes
   * (`idx_sessions_parent`, `idx_messages_session`), so this stays
   * cheap even for parents with many threads.
   */
  listOpenThreadsForParent(
    parentId: string,
  ): Array<{ child_session_id: string; anchor_message_id: string; reply_count: number }> {
    return this.db
      .prepare<
        [string],
        { child_session_id: string; anchor_message_id: string; reply_count: number }
      >(
        `SELECT
           s.id AS child_session_id,
           json_extract(m.metadata, '$.quoted_message_id') AS anchor_message_id,
           (SELECT COUNT(*)
              FROM messages
              WHERE session_id = s.id
                AND from_kind != 'system') AS reply_count
         FROM sessions s
         JOIN messages m ON m.session_id = s.id
         WHERE s.parent_session_id = ?
           AND s.closed_at IS NULL
           AND m.from_kind = 'system'
           AND json_extract(m.metadata, '$.subtype') = 'thread_anchor'`,
      )
      .all(parentId);
  }

  get(id: string): SessionDto | null {
    const row = this.db
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  /**
   * Create a session row. `parent_session_id`, `spawned_by_agent_id`
   * are optional; when present, depth is enforced to 1 (cannot nest)
   * and concurrency / cooldown are checked against `spawnCtx`.
   *
   * Throws an Error with a discriminating `code` field on validation
   * failure (so HTTP layer can map to 4xx).
   */
  insert(params: {
    channelId: string;
    title: string;
    parentSessionId?: string | null;
    spawnedByAgentId?: string | null;
    spawnCtx?: SpawnLimitContext;
  }): SessionDto {
    if (params.parentSessionId) {
      const parent = this.get(params.parentSessionId);
      if (!parent) throw repoError('parent_not_found', 'parent session not found');
      if (parent.parent_session_id) {
        throw repoError(
          'max_depth_exceeded',
          'cannot nest child sessions (max_depth = 1)',
        );
      }
      if (parent.closed_at !== null) {
        throw repoError('parent_closed', 'parent session is closed');
      }
      if (parent.channel_id !== params.channelId) {
        throw repoError(
          'cross_channel_parent',
          'child session must live in the same channel as its parent',
        );
      }
      if (params.spawnCtx) {
        const { limits, lastSpawnAtByAgent } = params.spawnCtx;
        if (limits.max_concurrent_per_parent !== null) {
          const active = this.countActiveChildren(params.parentSessionId);
          if (active >= limits.max_concurrent_per_parent) {
            throw repoError(
              'concurrent_limit',
              `child session limit reached: ${active}/${limits.max_concurrent_per_parent} active under this parent`,
            );
          }
        }
        if (
          limits.spawn_cooldown_seconds !== null &&
          params.spawnedByAgentId
        ) {
          const last = lastSpawnAtByAgent.get(params.spawnedByAgentId);
          if (
            last !== undefined &&
            Date.now() - last < limits.spawn_cooldown_seconds * 1000
          ) {
            throw repoError(
              'spawn_cooldown',
              `spawn cooldown active: must wait ${limits.spawn_cooldown_seconds}s between spawns`,
            );
          }
        }
      }
    }

    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, channel_id, title, status, parent_session_id,
          spawned_by_agent_id, closed_at, close_summary,
          created_at, updated_at)
         VALUES (?, ?, ?, 'idle', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        params.channelId,
        params.title,
        params.parentSessionId ?? null,
        params.spawnedByAgentId ?? null,
        now,
        now,
      );

    if (params.spawnCtx && params.spawnedByAgentId) {
      params.spawnCtx.lastSpawnAtByAgent.set(params.spawnedByAgentId, now);
    }

    const row = this.get(id);
    if (!row) throw new Error('insert failed');
    return row;
  }

  /**
   * Mark a session as closed. Caller must have already validated that
   * this session has no active children (use `countActiveChildren`).
   */
  close(id: string, summary: string): SessionDto | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE sessions
         SET closed_at = ?, close_summary = ?, status = 'archived', updated_at = ?
         WHERE id = ? AND closed_at IS NULL`,
      )
      .run(now, summary, now, id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // ── session_agents ──────────────────────────────────────────────
  addAgent(sessionId: string, agentId: string): SessionAgentDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_agents
         (session_id, agent_id, cli_session_id, pid, status, joined_at)
         VALUES (?, ?, NULL, NULL, 'idle', ?)`,
      )
      .run(sessionId, agentId, now);
    const row = this.db
      .prepare<[string, string], SessionAgentRow>(
        `SELECT * FROM session_agents WHERE session_id = ? AND agent_id = ?`,
      )
      .get(sessionId, agentId);
    if (!row) throw new Error('session_agents insert failed');
    return { ...row };
  }

  listAgents(sessionId: string): SessionAgentDto[] {
    const rows = this.db
      .prepare<[string], SessionAgentRow>(
        `SELECT * FROM session_agents WHERE session_id = ? ORDER BY joined_at ASC`,
      )
      .all(sessionId);
    return rows.map(r => ({ ...r }));
  }

  removeAgent(sessionId: string, agentId: string): void {
    this.db
      .prepare(`DELETE FROM session_agents WHERE session_id = ? AND agent_id = ?`)
      .run(sessionId, agentId);
  }

  /**
   * Mutate runtime fields on a session_agents row. Caller is responsible
   * for status state-machine semantics; this just persists.
   */
  updateAgentRuntime(
    sessionId: string,
    agentId: string,
    fields: {
      status?: 'starting' | 'active' | 'idle' | 'crashed';
      pid?: number | null;
      cliSessionId?: string | null;
    },
  ): SessionAgentDto | null {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (fields.status !== undefined) {
      sets.push('status = ?');
      values.push(fields.status);
    }
    if (fields.pid !== undefined) {
      sets.push('pid = ?');
      values.push(fields.pid);
    }
    if (fields.cliSessionId !== undefined) {
      sets.push('cli_session_id = ?');
      values.push(fields.cliSessionId);
    }
    if (sets.length === 0) return this.getAgent(sessionId, agentId);
    values.push(sessionId, agentId);
    this.db
      .prepare(
        `UPDATE session_agents SET ${sets.join(', ')}
         WHERE session_id = ? AND agent_id = ?`,
      )
      .run(...values);
    return this.getAgent(sessionId, agentId);
  }

  getAgent(sessionId: string, agentId: string): SessionAgentDto | null {
    const row = this.db
      .prepare<[string, string], SessionAgentRow>(
        `SELECT * FROM session_agents WHERE session_id = ? AND agent_id = ?`,
      )
      .get(sessionId, agentId);
    return row ? { ...row } : null;
  }

  /** All session_agents rows whose status implies "should be running"
   *  (`starting` or `active`). Used by SessionManager.reconcileOnBoot
   *  to detect stale rows from a crashed prior backend. */
  listLiveStatusAgents(): SessionAgentDto[] {
    const rows = this.db
      .prepare<[], SessionAgentRow>(
        `SELECT * FROM session_agents WHERE status IN ('starting', 'active')`,
      )
      .all();
    return rows.map(r => ({ ...r }));
  }
}

export interface RepoError extends Error {
  code: string;
}

function repoError(code: string, message: string): RepoError {
  const e = new Error(message) as RepoError;
  e.code = code;
  return e;
}
