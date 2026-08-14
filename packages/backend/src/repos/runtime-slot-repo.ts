import type { Database as Db } from 'better-sqlite3';
import type {
  AgentRuntimeEventKind,
  AgentRuntimeEventRow,
  AgentRuntimeSlotRow,
  ConversationAgentStatus,
} from '@silverhand/shared';

/** Runtime identity is a discriminated value, never a nullable tuple in callers. */
export type RuntimeSlotScope =
  | { kind: 'agent'; agentId: string }
  | { kind: 'conversation'; conversationId: string; agentId: string };

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
  clearCliSession(scope: RuntimeSlotScope): AgentRuntimeSlotRow | null {
    return this.db.transaction(() => {
      const current = this.get(scope);
      if (!current) return null;
      if (current.cli_session_id === null) return current;
      const result = this.db
        .prepare(
          `UPDATE agent_runtime_slots
              SET cli_session_id = NULL
            WHERE id = ? AND generation = ?`,
        )
        .run(current.id, current.generation);
      if (result.changes !== 1) return null;
      const updated = this.get(scope);
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

  listLiveConversationSlotsForHost(hostId: string): AgentRuntimeSlotRow[] {
    return this.db
      .prepare<[string], AgentRuntimeSlotRow>(
        `SELECT s.*
           FROM agent_runtime_slots s
           JOIN agents a ON a.id = s.agent_id
          WHERE a.host_id = ?
            AND s.conversation_id IS NOT NULL
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
