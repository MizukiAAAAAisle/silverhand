import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  AgentDto,
  AgentRow,
  AgentRuntimeSession,
  ChannelKind,
  CreateAgentInput,
  SessionAgentStatus,
  UpdateAgentInput,
} from '@silverhand/shared';

function newId(): string {
  return randomBytes(12).toString('base64url');
}

function rowToDto(row: AgentRow): AgentDto {
  return { ...row };
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

  create(input: CreateAgentInput, defaultHostId: string): AgentDto {
    const id = newId();
    const now = Date.now();
    // display_name defaults to the handle so the UI doesn't have to
    // collect both at create time. Users edit display_name later via
    // the agent profile page.
    this.db
      .prepare(
        `INSERT INTO agents
         (id, name, display_name, runtime, model, reasoning_effort,
          host_id, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.name,
        input.runtime,
        input.model ?? null,
        input.reasoning_effort ?? null,
        input.host_id ?? defaultHostId,
        input.description ?? null,
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
    const values: (string | null)[] = [];
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
   * Every (session, agent) pair this agent participates in, joined to
   * channel + session metadata. Single SQL — drives both the agent
   * profile "where it runs" table and the delete-impact preview.
   * Includes closed sessions so the UI can show full history; the
   * caller filters by `closed_at` if needed.
   */
  listRuntimeSessions(agentId: string): AgentRuntimeSession[] {
    type Row = {
      session_id: string;
      channel_id: string;
      channel_name: string;
      channel_kind: ChannelKind;
      session_title: string;
      status: SessionAgentStatus;
      pid: number | null;
      closed_at: number | null;
    };
    const rows = this.db
      .prepare<[string], Row>(
        `SELECT
           sa.session_id   AS session_id,
           c.id            AS channel_id,
           c.name          AS channel_name,
           c.kind          AS channel_kind,
           s.title         AS session_title,
           sa.status       AS status,
           sa.pid          AS pid,
           s.closed_at     AS closed_at
         FROM session_agents sa
         JOIN sessions s ON s.id = sa.session_id
         JOIN channels c ON c.id = s.channel_id
         WHERE sa.agent_id = ?
         ORDER BY s.closed_at IS NULL DESC, s.updated_at DESC`,
      )
      .all(agentId);
    return rows;
  }
}
