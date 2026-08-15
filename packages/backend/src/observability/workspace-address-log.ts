import { createHash } from 'node:crypto';
import type { AddressFallbackReason } from '@silverhand/shared';
import type { BackendLogger } from '../context.js';

/**
 * The reasons this window counts — the CODEC's set, aliased rather than restated
 * (#task:2021 P4-4).
 *
 * The counter and the renderer must agree by construction: every value here is
 * produced by `formatStreamAddressToken`, which decides on the render, and a
 * second copy of the union would let one side gain a reason the other silently
 * dropped into no bucket. The alias also documents WHERE the recorder is —
 * `runtime/outbound-event-fanout.ts` frames every delivery header and records each
 * non-null fallback, which `title-address-log.ts` names as the one unbounded member
 * of this family and deliberately leaves to the resolver's ticket.
 */
export type WorkspaceAddressFallbackReason = AddressFallbackReason;

/** The exact structured fields written to the persistent logger. The offline
 * dogfood report consumes this wire shape directly; there is no camelCase
 * shadow DTO that can drift away from emitted JSONL. */
export type WorkspaceAddressDogfoodEvent =
  | {
      readonly workspace_address_event: 'assignment';
      readonly action: 'create' | 'rename';
      readonly workspace_id: string;
      readonly old_key_hash: string | null;
      readonly new_key_hash: string;
    }
  | {
      readonly workspace_address_event: 'conflict';
      readonly workspace_id: string | null;
      readonly key_hash: string;
    }
  | {
      readonly workspace_address_event: 'resolve';
      readonly outcome: 'unresolved' | 'ambiguous';
      readonly key_hash: string | null;
      readonly matches: number;
    }
  | {
      readonly workspace_address_event: 'fallback_window';
      readonly total: number;
      readonly counts: Readonly<Record<WorkspaceAddressFallbackReason, number>>;
    };

/** Correlation token for the temporary dogfood window. Display names never
 * enter logs; a version prefix makes a future hashing-policy change explicit. */
export function hashWorkspaceAddressKey(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24)}`;
}

export function logWorkspaceAddressAssignment(
  logger: BackendLogger,
  event: {
    workspaceId: string;
    action: 'create' | 'rename';
    oldKey: string | null;
    newKey: string;
  },
): void {
  const fields: WorkspaceAddressDogfoodEvent = {
    workspace_address_event: 'assignment',
    action: event.action,
    workspace_id: event.workspaceId,
    old_key_hash: event.oldKey === null ? null : hashWorkspaceAddressKey(event.oldKey),
    new_key_hash: hashWorkspaceAddressKey(event.newKey),
  };
  logger.warn(fields, 'workspace address assigned');
}

export function logWorkspaceAddressConflict(
  logger: BackendLogger,
  event: { workspaceId: string | null; key: string },
): void {
  const fields: WorkspaceAddressDogfoodEvent = {
    workspace_address_event: 'conflict',
    workspace_id: event.workspaceId,
    key_hash: hashWorkspaceAddressKey(event.key),
  };
  logger.warn(fields, 'workspace address refused: current name taken');
}

export function logWorkspaceAddressResolution(
  logger: BackendLogger,
  event: {
    outcome: 'unresolved' | 'ambiguous';
    key: string | null;
    matches: number;
  },
): void {
  const fields: WorkspaceAddressDogfoodEvent = {
    workspace_address_event: 'resolve',
    outcome: event.outcome,
    key_hash: event.key === null ? null : hashWorkspaceAddressKey(event.key),
    matches: event.matches,
  };
  logger.warn(fields, `workspace address ${event.outcome}`);
}

/** High-frequency fallback is counted in memory and emitted only when the
 * owning release window explicitly flushes it. `record` never logs. */
export class WorkspaceAddressFallbackWindow {
  private readonly counts = new Map<WorkspaceAddressFallbackReason, number>();

  record(reason: WorkspaceAddressFallbackReason): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }

  snapshot(): Readonly<Record<WorkspaceAddressFallbackReason, number>> {
    return {
      token_budget: this.counts.get('token_budget') ?? 0,
      agent_home: this.counts.get('agent_home') ?? 0,
      unrenderable: this.counts.get('unrenderable') ?? 0,
    };
  }

  /**
   * Emit the window and reset it, and report WHETHER it spoke.
   *
   * The boolean is what lets an interval-gated caller arm its clock on a line that
   * was actually written rather than on the attempt: gating on the attempt makes a
   * quiet pass consume the window, so the first real fallback after startup would
   * wait out a whole interval before anyone heard about it.
   */
  flush(logger: BackendLogger): boolean {
    const counts = this.snapshot();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (total === 0) return false;
    const fields: WorkspaceAddressDogfoodEvent = {
      workspace_address_event: 'fallback_window',
      total,
      counts,
    };
    logger.warn(fields, 'workspace address fallback window');
    this.counts.clear();
    return true;
  }
}

/** Pure offline aggregation used by the one-shot dogfood report. Reuse is a
 * later assignment of a hash some other workspace released by rename. */
export function summarizeWorkspaceAddressDogfood(
  events: readonly WorkspaceAddressDogfoodEvent[],
): {
  assignments: number;
  renames: number;
  reuses: number;
  conflicts: number;
  unresolved: number;
  ambiguous: number;
  fallbacks: number;
} {
  const released = new Map<string, string>();
  let assignments = 0;
  let renames = 0;
  let reuses = 0;
  let conflicts = 0;
  let unresolved = 0;
  let ambiguous = 0;
  let fallbacks = 0;
  for (const event of events) {
    if (event.workspace_address_event === 'assignment') {
      assignments += 1;
      if (event.action === 'rename') {
        renames += 1;
        if (event.old_key_hash) {
          released.set(event.old_key_hash, event.workspace_id);
        }
      }
      if (
        released.has(event.new_key_hash)
        && released.get(event.new_key_hash) !== event.workspace_id
      ) reuses += 1;
    } else if (event.workspace_address_event === 'conflict') conflicts += 1;
    else if (event.workspace_address_event === 'resolve') {
      if (event.outcome === 'unresolved') unresolved += 1;
      else if (event.outcome === 'ambiguous') ambiguous += 1;
    } else fallbacks += event.total;
  }
  return { assignments, renames, reuses, conflicts, unresolved, ambiguous, fallbacks };
}
