import type { Database as Db } from 'better-sqlite3';
import {
  AGENT_CAPABILITIES,
  type AgentCapability,
} from '@silverhand/shared';

/**
 * Storage for the agent-capability axis (graded-permissions Layer A cut 2,
 * v41). One row per granted (workspace, agent, capability) — PRESENCE =
 * GRANTED. Deliberately a SEPARATE repo from `WorkspaceRepo` (which owns
 * the human role axis) so the two orthogonal axes never share helpers
 * (doc §6.4 naming discipline): nothing here references workspace roles
 * and `WorkspaceRepo` never references capabilities.
 *
 * Membership coupling lives in the schema, not here: the table's composite
 * FK (workspace_id, agent_id) → `workspace_members` ON DELETE CASCADE
 * deletes a member's caps when they leave the workspace. Seeding on add is
 * driven by `WorkspaceRepo.addMember` calling {@link seedDefaults} inside
 * the membership-insert transaction.
 */
export class AgentCapabilityRepo {
  constructor(private readonly db: Db) {}

  /** The granted capability set for one (workspace, agent) pair, sorted
   *  for stable output. Empty array when the pair has no rows (not a
   *  member, or every capability revoked). */
  list(workspaceId: string, agentId: string): AgentCapability[] {
    return this.db
      .prepare<[string, string], { capability: AgentCapability }>(
        `SELECT capability FROM workspace_agent_capabilities
          WHERE workspace_id = ? AND agent_id = ?
          ORDER BY capability ASC`,
      )
      .all(workspaceId, agentId)
      .map(r => r.capability);
  }

  /** Whether the (workspace, agent) pair holds `capability`. This is the
   *  hot path behind `canAgentUseCapability`. */
  has(workspaceId: string, agentId: string, capability: AgentCapability): boolean {
    const row = this.db
      .prepare<[string, string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspace_agent_capabilities
          WHERE workspace_id = ? AND agent_id = ? AND capability = ?`,
      )
      .get(workspaceId, agentId, capability);
    return (row?.c ?? 0) > 0;
  }

  /**
   * Replace the entire capability set for a pair (PUT semantics, doc
   * §2.4). Delete-all + insert-desired inside one transaction so a reader
   * never observes a half-applied set. Caller validates `capabilities`
   * against the bucket enum (route-level zod → 400 on unknown).
   */
  replaceSet(workspaceId: string, agentId: string, capabilities: readonly AgentCapability[]): void {
    const unique = [...new Set(capabilities)];
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM workspace_agent_capabilities
            WHERE workspace_id = ? AND agent_id = ?`,
        )
        .run(workspaceId, agentId);
      const insert = this.db.prepare(
        `INSERT INTO workspace_agent_capabilities (workspace_id, agent_id, capability)
           VALUES (?, ?, ?)`,
      );
      for (const cap of unique) {
        insert.run(workspaceId, agentId, cap);
      }
    })();
  }

  /**
   * Seed the FULL default capability set for a newly added membership
   * (doc §2.4 / §2.3). Idempotent via `INSERT OR IGNORE` — re-seeding an
   * existing pair never duplicates and never re-widens a narrowed set
   * (the caller only invokes this when the membership row was genuinely
   * created). MUST run inside the same transaction as the
   * `workspace_members` insert so a member always has a cap set.
   */
  seedDefaults(workspaceId: string, agentId: string): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO workspace_agent_capabilities (workspace_id, agent_id, capability)
         VALUES (?, ?, ?)`,
    );
    for (const cap of buildDefaultCapabilities()) {
      insert.run(workspaceId, agentId, cap);
    }
  }
}

/**
 * The default capability set granted to a NEW membership. Full set in v1
 * (zero behavioral regression). Per the no-silent-widen rule (doc §2.3)
 * this is applied ONLY to new memberships — a future capability bucket is
 * NOT retroactively granted to existing rows by changing this helper; it
 * ships its own migration deciding per-row defaults.
 */
export function buildDefaultCapabilities(): AgentCapability[] {
  return [...AGENT_CAPABILITIES];
}
