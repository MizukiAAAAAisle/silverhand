import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  apiPaths,
  type AgentDto,
  type AgentRow,
  type AgentRuntimeConversation,
  type ConversationAgentStatus,
  type ConversationKind,
  type CreateAgentInput,
  type UpdateAgentInput,
  type WorkspaceKind,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

export function agentRowToDto(row: AgentRow): AgentDto {
  // SQLite stores booleans as 0/1; coerce back to boolean | null.
  const fast = row.fast_mode as unknown as number | boolean | null;
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    runtime: row.runtime,
    model: row.model,
    reasoning_effort: row.reasoning_effort,
    fast_mode:
      fast === null || fast === undefined ? null : Boolean(fast),
    host_id: row.host_id,
    description: row.description,
    created_by_user_id: row.created_by_user_id,
    // Mirror UserDto: present when the row has an avatar blob set;
    // cache-busted via `updated_at` so the renderer's HTTP cache
    // refreshes whenever AgentService.uploadAvatar / clearAvatar runs
    // (both bump updated_at via `setAvatar`/`clearAvatar`).
    avatar_url: row.avatar_storage_key
      ? `${apiPaths.agentAvatar(row.id)}?v=${row.updated_at}`
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToDto(row: AgentRow): AgentDto {
  return agentRowToDto(row);
}

export class AgentRepo {
  constructor(private readonly db: Db) {}

  list(): AgentDto[] {
    const rows = this.db
      .prepare<[], AgentRow>('SELECT * FROM agents ORDER BY created_at ASC')
      .all();
    return rows.map(rowToDto);
  }

  get(id: string): AgentDto | null {
    const row = this.db
      .prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  getByName(name: string): AgentDto | null {
    const row = this.db
      .prepare<[string], AgentRow>('SELECT * FROM agents WHERE name = ?')
      .get(name);
    return row ? rowToDto(row) : null;
  }

  create(
    input: CreateAgentInput,
    defaultHostId: string,
    createdByUserId: string,
  ): AgentDto {
    const id = newId();
    const now = Date.now();
    // display_name defaults to the handle so the UI doesn't have to
    // collect both at create time. Users edit display_name later via
    // the agent profile page.
    //
    // `created_by_user_id` is required (NOT NULL since v26). Callers
    // must thread the creator's user id from their auth principal —
    // routes pass `getUserPrincipal(c).userId`; tests pass an explicit
    // fixture user id. The cross-namespace name-collision trigger
    // (v21) and FK to `users(id)` (v26) both fire here on bad input.
    this.db
      .prepare(
        `INSERT INTO agents
         (id, name, display_name, runtime, model, reasoning_effort, fast_mode,
          host_id, description, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.name,
        input.runtime,
        input.model ?? null,
        input.reasoning_effort ?? null,
        input.fast_mode === undefined ? null : input.fast_mode ? 1 : 0,
        input.host_id ?? defaultHostId,
        input.description ?? null,
        createdByUserId,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error('insert failed');
    return row;
  }

  /**
   * Partial update. Only keys present in `input` are written. Returns
   * the updated row, or null if the agent does not exist. Caller is
   * responsible for higher-level invariants such as "no runtime change
   * while a session_agent is active" — this repo just persists.
   */
  update(id: string, input: UpdateAgentInput): AgentDto | null {
    if (!this.get(id)) return null;
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (input.display_name !== undefined) {
      sets.push('display_name = ?');
      values.push(input.display_name);
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      values.push(input.description);
    }
    if (input.runtime !== undefined) {
      sets.push('runtime = ?');
      values.push(input.runtime);
    }
    if (input.model !== undefined) {
      sets.push('model = ?');
      values.push(input.model);
    }
    if (input.reasoning_effort !== undefined) {
      sets.push('reasoning_effort = ?');
      values.push(input.reasoning_effort);
    }
    if (input.fast_mode !== undefined) {
      sets.push('fast_mode = ?');
      values.push(input.fast_mode === null ? null : input.fast_mode ? 1 : 0);
    }
    if (sets.length === 0) return this.get(id);
    sets.push('updated_at = ?');
    const now = Date.now();
    this.db
      .prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, now, id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  /**
   * Set avatar storage_key + content_type as a unit. Caller (the
   * AgentService) must have already persisted the blob via
   * `BlobFileStorage.put`. Mirrors `UserRepo.setAvatar`. Returns the
   * updated row, or null when the agent does not exist.
   *
   * Both columns are written together so the v26 CHECK pair
   * (`(key NULL AND ct NULL) OR (key NOT NULL AND ct NOT NULL)`)
   * holds across every commit boundary.
   */
  setAvatar(
    id: string,
    avatar: { storageKey: string; contentType: string },
  ): AgentDto | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(
        `UPDATE agents
            SET avatar_storage_key = ?,
                avatar_content_type = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(avatar.storageKey, avatar.contentType, Date.now(), id);
    return this.get(id);
  }

  /** Clear avatar (both storage_key + content_type to NULL together).
   *  Mirrors `UserRepo.clearAvatar`. */
  clearAvatar(id: string): AgentDto | null {
    if (!this.get(id)) return null;
    this.db
      .prepare(
        `UPDATE agents
            SET avatar_storage_key = NULL,
                avatar_content_type = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(Date.now(), id);
    return this.get(id);
  }

  /** Read raw row including avatar storage fields. The DTO drops the
   *  storage key (renderer fetches via `avatar_url`); routes that need
   *  the key (avatar download / cleanup) call this. */
  getRow(id: string): AgentRow | null {
    const row = this.db
      .prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  /**
   * Every (conversation, agent) pair this agent participates in, joined to
   * workspace/channel/thread metadata. Single SQL — drives both the agent
   * profile "where it runs" table and the delete-impact preview.
   * Includes closed conversations so the UI can show full history; the
   * caller filters by `closed_at` if needed.
   */
  listRuntimeConversations(agentId: string): AgentRuntimeConversation[] {
    type Row = {
      conversation_id: string;
      workspace_id: string;
      workspace_name: string;
      workspace_kind: WorkspaceKind;
      conversation_kind: ConversationKind;
      channel_id: string;
      thread_id: string | null;
      channel_title: string;
      thread_title: string | null;
      status: ConversationAgentStatus;
      pid: number | null;
      closed_at: number | null;
    };
    const rows = this.db
      .prepare<[string], Row>(
        `SELECT
           ca.conversation_id AS conversation_id,
           c.workspace_id     AS workspace_id,
           w.name             AS workspace_name,
           w.workspace_kind   AS workspace_kind,
           c.kind             AS conversation_kind,
           CASE WHEN c.kind = 'thread' THEN parent.id ELSE c.id END
                              AS channel_id,
           CASE WHEN c.kind = 'thread' THEN c.id ELSE NULL END
                              AS thread_id,
           CASE WHEN c.kind = 'thread' THEN parent.title ELSE c.title END
                              AS channel_title,
           CASE WHEN c.kind = 'thread' THEN c.title ELSE NULL END
                              AS thread_title,
           ca.status          AS status,
           ca.pid             AS pid,
           c.closed_at        AS closed_at
         FROM conversation_agents ca
         JOIN conversations c ON c.id = ca.conversation_id
         JOIN workspaces w ON w.id = c.workspace_id
         LEFT JOIN conversations parent ON parent.id = c.parent_conversation_id
         WHERE ca.agent_id = ?
         ORDER BY c.closed_at IS NULL DESC, c.updated_at DESC`,
      )
      .all(agentId);
    return rows;
  }
}
