import type { Database as Db } from 'better-sqlite3';
import type {
  AgentRuntimeControlEventRow,
  AgentRuntimeEventKind,
  AgentRuntimeEventRow,
  AgentRuntimeSlotRow,
  ConversationAgentStatus,
} from '@silverhand/shared';

/** Runtime identity is a discriminated value, never a nullable tuple in callers. */
export type RuntimeSlotScope =
  | { kind: 'agent'; agentId: string }
  | { kind: 'conversation'; conversationId: string; agentId: string };

/**
 * ONE RUNTIME SEAT of an agent: one `agent_runtime_slots` row, as the CONTROL
 * PLANE unit (runtime switch, stop-all, teardown capture, the delete-impact
 * pre-flight, session management).
 *
 * IDENTITY IS THE SCOPE, and the scope is the ONLY carrier of the coordinate —
 * there is deliberately no second `conversation_id` field beside it. A control
 * plane that acts on a session must not be able to read a plausible coordinate
 * out of a seat that does not have one: for an AgentSlot the honest answer is
 * "this session is not placed in a conversation", and a nullable field next to a
 * discriminated union is two representations of that one fact, free to disagree.
 *
 * CUSTODY TRAVELS WITH THE SEAT (`generation`, `claimedByDaemonInstanceId`). A
 * stop or a session clear is only sound against the exact generation it was
 * decided on — the successor of a crashed-and-respawned session is a different
 * process behind the same identity — so a seat DTO that dropped these would force
 * every caller to re-read the slot and race.
 *
 * WHAT IT DOES NOT CARRY: any conversation metadata (workspace, title, archived
 * state). Every such field is a field a future edit could filter or join by, and
 * the workspace coordinate is precisely the join that used to make DM and inbox
 * seats vanish from these planes (@Cindy B3). The display face
 * (`AgentRepo.listRuntimeConversations`) is where coordinates belong.
 *
 * NOT A PARTICIPATION FACE, in either direction: it neither answers "is this
 * agent in that conversation" (`agentParticipates`, §4.2, the one authority) nor
 * is it derived from it. An agent-scoped session has ONE seat serving N
 * conversations, so a participation-driven seat list would report N seats and
 * stop the same process N times.
 */
export interface AgentRuntimeSeat {
  scope: RuntimeSlotScope;
  status: ConversationAgentStatus;
  pid: number | null;
  generation: number;
  claimedByDaemonInstanceId: string | null;
  cliSessionId: string | null;
}

/** The slot row's identity as a discriminated value: `conversation_id IS NULL`
 *  is what makes a row an AgentSlot, so that column is the discriminant and
 *  nothing else needs to be consulted. */
export function slotScopeOf(row: AgentRuntimeSlotRow): RuntimeSlotScope {
  return row.conversation_id === null
    ? { kind: 'agent', agentId: row.agent_id }
    : {
        kind: 'conversation',
        conversationId: row.conversation_id,
        agentId: row.agent_id,
      };
}

function rowToSeat(row: AgentRuntimeSlotRow): AgentRuntimeSeat {
  return {
    scope: slotScopeOf(row),
    status: row.observed_status,
    pid: row.observed_pid,
    generation: row.generation,
    claimedByDaemonInstanceId: row.claimed_by_daemon_instance_id,
    cliSessionId: row.cli_session_id,
  };
}

export interface RuntimeProjectionPatch {
  status?: ConversationAgentStatus;
  pid?: number | null;
  cliSessionId?: string | null;
  claimedByDaemonInstanceId?: string | null;
}

export interface ClaimRuntimeGenerationInput {
  scope: RuntimeSlotScope;
  daemonInstanceId: string;
  status?: ConversationAgentStatus;
  pid?: number | null;
}

export interface CompareAndSetRuntimeProjectionInput {
  scope: RuntimeSlotScope;
  expectedGeneration: number;
  expectedDaemonInstanceId: string;
  patch: Omit<RuntimeProjectionPatch, 'claimedByDaemonInstanceId'>;
}

export interface FinalizeRuntimeGenerationInput {
  scope: RuntimeSlotScope;
  expectedGeneration: number;
  expectedDaemonInstanceId: string;
  status: Extract<ConversationAgentStatus, 'idle' | 'crashed'>;
  clearCliSessionId?: boolean;
}

/**
 * Persistence boundary for P0-d's scoped runtime authority.
 *
 * The slot row is the only current authority. Events are append-only history;
 * no read in this repository derives current state from the event table.
 */
export class RuntimeSlotRepo {
  constructor(private readonly db: Db) {}

  get(scope: RuntimeSlotScope): AgentRuntimeSlotRow | null {
    const row = scope.kind === 'agent'
      ? this.db
          .prepare<[string], AgentRuntimeSlotRow>(
            `SELECT * FROM agent_runtime_slots
              WHERE agent_id = ? AND conversation_id IS NULL`,
          )
          .get(scope.agentId)
      : this.db
          .prepare<[string, string], AgentRuntimeSlotRow>(
            `SELECT * FROM agent_runtime_slots
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(scope.conversationId, scope.agentId);
    return row ?? null;
  }

  getConversation(
    conversationId: string,
    agentId: string,
  ): AgentRuntimeSlotRow | null {
    return this.get({ kind: 'conversation', conversationId, agentId });
  }

  getAgent(agentId: string): AgentRuntimeSlotRow | null {
    return this.get({ kind: 'agent', agentId });
  }

  /**
   * EVERY SEAT this agent holds — the row set of the slot table for one agent,
   * unjoined and unfiltered, which is the whole point of the face (@Cindy B3).
   *
   * Unjoined is the load-bearing part: there is no conversation table here to
   * resolve a coordinate through, so no edit can reintroduce the projection that
   * used to delete DM and inbox seats from every control plane. Unfiltered
   * likewise — "which statuses count as running" is a domain rule and belongs to
   * the caller, where a test of the use case can see it.
   *
   * At most one row has `kind: 'agent'` (`uniq_agent_runtime_slots_agent_scope`),
   * and an agent-scoped agent has exactly that one row and no others, so the
   * aggregate slot cannot fan out into N seats no matter how many conversations
   * the agent participates in.
   */
  listSeats(agentId: string): AgentRuntimeSeat[] {
    return this.db
      .prepare<[string], AgentRuntimeSlotRow>(
        'SELECT * FROM agent_runtime_slots WHERE agent_id = ?',
      )
      .all(agentId)
      .map(rowToSeat);
  }

  /**
   * Compatibility projection for the still-conversation-scoped runtime path.
   * It is deliberately restricted to dormant, unclaimed generation 0. Once
   * custody is activated, only the full generation+daemon token may write.
   * This method still writes only slot authority and never mutates membership.
   */
  updateCurrentProjection(
    scope: RuntimeSlotScope,
    patch: RuntimeProjectionPatch,
  ): AgentRuntimeSlotRow | null {
    if (!hasPatch(patch)) return this.get(scope);
    return this.db.transaction(() => {
      const current = this.get(scope);
      if (!current) return null;
      if (
        current.generation !== 0
        || current.claimed_by_daemon_instance_id !== null
      ) return null;
      if (projectionMatches(current, patch)) return current;
      const updated = this.updateSlotById(current.id, patch);
      if (!updated) return null;
      this.insertEvent(updated, 'projection_updated');
      return updated;
    })();
  }

  updateCurrentConversationProjection(
    conversationId: string,
    agentId: string,
    patch: RuntimeProjectionPatch,
  ): AgentRuntimeSlotRow | null {
    return this.updateCurrentProjection(
      { kind: 'conversation', conversationId, agentId },
      patch,
    );
  }

  /**
   * Human/admin session management authority. This is deliberately not a
   * runtime projection: it clears only the resumable CLI session and never
   * changes status, pid, generation, or daemon custody. The generation CAS
   * prevents a clear racing a fresh claim from mutating the successor.
   */
  clearCliSession(input: {
    scope: RuntimeSlotScope;
    expectedGeneration: number;
  }): AgentRuntimeSlotRow | null {
    return this.db.transaction(() => {
      const current = this.get(input.scope);
      if (!current) return null;
      if (current.generation !== input.expectedGeneration) return null;
      if (current.cli_session_id === null) return current;
      const result = this.db
        .prepare(
          `UPDATE agent_runtime_slots
              SET cli_session_id = NULL
            WHERE id = ? AND generation = ?`,
        )
        .run(current.id, input.expectedGeneration);
      if (result.changes !== 1) return null;
      const updated = this.get(input.scope);
      if (!updated) return null;
      this.insertEvent(updated, 'projection_updated');
      return updated;
    })();
  }

  /**
   * Claim the stable slot for a new custody generation. The slot identity does
   * not change and daemon identity never participates in uniqueness.
   */
  claimGeneration(
    input: ClaimRuntimeGenerationInput,
  ): AgentRuntimeSlotRow | null {
    if (this.db.inTransaction) {
      throw new Error('claimGeneration requires a root transaction');
    }
    return this.db.transaction(() => {
      const current = this.get(input.scope);
      if (!current) return null;
      const nextGeneration = current.generation + 1;
      const result = this.db
        .prepare(
          `UPDATE agent_runtime_slots
              SET generation = ?,
                  claimed_by_daemon_instance_id = ?,
                  observed_status = ?,
                  observed_pid = ?
            WHERE id = ? AND generation = ?`,
        )
        .run(
          nextGeneration,
          input.daemonInstanceId,
          input.status ?? 'starting',
          input.pid ?? null,
          current.id,
          current.generation,
        );
      if (result.changes !== 1) return null;
      const claimed = this.get(input.scope);
      if (!claimed) throw new Error('runtime slot disappeared after generation claim');
      this.insertEvent(claimed, 'generation_claimed');
      return claimed;
    }).immediate();
  }

  /**
   * Generation-bound projector/finalizer. A stale writer changes zero rows and
   * appends no event, so it cannot overwrite a successor generation.
   */
  compareAndSetProjection(
    input: CompareAndSetRuntimeProjectionInput,
  ): AgentRuntimeSlotRow | null {
    if (!hasPatch(input.patch)) {
      const current = this.get(input.scope);
      return current?.generation === input.expectedGeneration
        && current.claimed_by_daemon_instance_id
          === input.expectedDaemonInstanceId
        ? current
        : null;
    }
    return this.db.transaction(() => {
      const current = this.get(input.scope);
      if (
        !current
        || current.generation !== input.expectedGeneration
        || current.claimed_by_daemon_instance_id
          !== input.expectedDaemonInstanceId
      ) return null;
      if (projectionMatches(current, input.patch)) return current;
      const updated = this.updateSlotById(
        current.id,
        input.patch,
        {
          expectedGeneration: input.expectedGeneration,
          expectedDaemonInstanceId: input.expectedDaemonInstanceId,
        },
      );
      if (!updated) return null;
      this.insertEvent(updated, 'projection_updated');
      return updated;
    })();
  }

  /**
   * End one exact custody token. Clearing the daemon claim is part of this
   * fixed operation, so the same generation can never project again afterward.
   */
  finalizeGeneration(
    input: FinalizeRuntimeGenerationInput,
  ): AgentRuntimeSlotRow | null {
    return this.db.transaction(() => {
      const current = this.get(input.scope);
      if (
        !current
        || current.generation !== input.expectedGeneration
        || current.claimed_by_daemon_instance_id
          !== input.expectedDaemonInstanceId
      ) return null;
      const finalized = this.updateSlotById(
        current.id,
        {
          status: input.status,
          pid: null,
          claimedByDaemonInstanceId: null,
          ...(input.clearCliSessionId ? { cliSessionId: null } : {}),
        },
        {
          expectedGeneration: input.expectedGeneration,
          expectedDaemonInstanceId: input.expectedDaemonInstanceId,
        },
      );
      if (!finalized) return null;
      this.insertEvent(finalized, 'generation_finalized');
      return finalized;
    })();
  }

  listLiveSlotsForHost(hostId: string): AgentRuntimeSlotRow[] {
    return this.db
      .prepare<[string], AgentRuntimeSlotRow>(
        `SELECT s.*
           FROM agent_runtime_slots s
           JOIN agents a ON a.id = s.agent_id
          WHERE a.host_id = ?
            AND s.observed_status IN ('active', 'starting')`,
      )
      .all(hostId);
  }

  listEvents(slotId: number): AgentRuntimeEventRow[] {
    return this.db
      .prepare<[number], AgentRuntimeEventRow>(
        `SELECT * FROM agent_runtime_events
          WHERE slot_id = ?
          ORDER BY id ASC`,
      )
      .all(slotId);
  }

  /**
   * Record a user control fact for the Agent/Runtime aggregate. Unlike
   * `agent_runtime_events`, this answers who requested the control action and
   * why; unlike the ConversationSlot system message, it has no conversation
   * coordinate. The caller owns the transaction pairing it with the exact
   * generation's session clear.
   */
  insertControlEvent(input: {
    agentId: string;
    generation: number;
    actorUserId: string;
    reason: 'session_cleared';
    wasRunning: boolean;
    previousCliSessionIdPrefix: string | null;
    occurredAt: number;
  }): AgentRuntimeControlEventRow {
    return this.db.prepare<[
      string,
      number,
      string,
      'session_cleared',
      number,
      string | null,
      number,
    ], AgentRuntimeControlEventRow>(
      `INSERT INTO agent_runtime_control_events (
         agent_id, generation, actor_user_id, reason, was_running,
         previous_cli_session_id_prefix, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).get(
      input.agentId,
      input.generation,
      input.actorUserId,
      input.reason,
      input.wasRunning ? 1 : 0,
      input.previousCliSessionIdPrefix,
      input.occurredAt,
    )!;
  }

  listControlEvents(agentId: string): AgentRuntimeControlEventRow[] {
    return this.db.prepare<[string], AgentRuntimeControlEventRow>(
      `SELECT * FROM agent_runtime_control_events
        WHERE agent_id = ?
        ORDER BY id`,
    ).all(agentId);
  }

  private updateSlotById(
    slotId: number,
    patch: RuntimeProjectionPatch,
    custody?: {
      expectedGeneration: number;
      expectedDaemonInstanceId: string;
    },
  ): AgentRuntimeSlotRow | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      sets.push('observed_status = ?');
      values.push(patch.status);
    }
    if (patch.pid !== undefined) {
      sets.push('observed_pid = ?');
      values.push(patch.pid);
    }
    if (patch.cliSessionId !== undefined) {
      sets.push('cli_session_id = ?');
      values.push(patch.cliSessionId);
    }
    if (patch.claimedByDaemonInstanceId !== undefined) {
      sets.push('claimed_by_daemon_instance_id = ?');
      values.push(patch.claimedByDaemonInstanceId);
    }
    if (sets.length === 0) return this.getById(slotId);
    values.push(slotId);
    if (custody) {
      values.push(
        custody.expectedGeneration,
        custody.expectedDaemonInstanceId,
      );
    }
    const result = this.db
      .prepare(
        `UPDATE agent_runtime_slots
            SET ${sets.join(', ')}
          WHERE id = ?${
            custody === undefined
              ? ''
              : ' AND generation = ? AND claimed_by_daemon_instance_id = ?'
          }`,
      )
      .run(...values);
    return result.changes === 1 ? this.getById(slotId) : null;
  }

  private getById(slotId: number): AgentRuntimeSlotRow | null {
    return this.db
      .prepare<[number], AgentRuntimeSlotRow>(
        'SELECT * FROM agent_runtime_slots WHERE id = ?',
      )
      .get(slotId) ?? null;
  }

  private insertEvent(
    slot: AgentRuntimeSlotRow,
    eventKind: AgentRuntimeEventKind,
  ): void {
    this.db
      .prepare(
        `INSERT INTO agent_runtime_events (
           slot_id, agent_id, conversation_id,
           generation, event_kind, daemon_instance_id,
           observed_status, observed_pid, cli_session_id, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slot.id,
        slot.agent_id,
        slot.conversation_id,
        slot.generation,
        eventKind,
        slot.claimed_by_daemon_instance_id,
        slot.observed_status,
        slot.observed_pid,
        slot.cli_session_id,
        Date.now(),
      );
  }
}

function hasPatch(patch: RuntimeProjectionPatch): boolean {
  return patch.status !== undefined
    || patch.pid !== undefined
    || patch.cliSessionId !== undefined
    || patch.claimedByDaemonInstanceId !== undefined;
}

function projectionMatches(
  slot: AgentRuntimeSlotRow,
  patch: RuntimeProjectionPatch,
): boolean {
  return (patch.status === undefined || patch.status === slot.observed_status)
    && (patch.pid === undefined || patch.pid === slot.observed_pid)
    && (patch.cliSessionId === undefined
      || patch.cliSessionId === slot.cli_session_id)
    && (patch.claimedByDaemonInstanceId === undefined
      || patch.claimedByDaemonInstanceId
        === slot.claimed_by_daemon_instance_id);
}
