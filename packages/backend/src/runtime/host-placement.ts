import type { HostRow } from '@silverhand/shared';
import type { AgentRepo } from '../repos/agent-repo.js';
import { isHostReadyForPlacement, type HostRepo } from '../repos/host-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import { RuntimeHostPlacementError } from '../host-placement-errors.js';

export interface RuntimeHostPlacement {
  assertActiveHost(hostId: string): HostRow;
  resolveForAgent(agentId: string): { host: HostRow };
}

export interface RuntimeHostPlacementControl extends RuntimeHostPlacement {
  assertOwnedActiveHost(hostId: string, userId: string): HostRow;
  resolveOwnedReadyForPlacement(userId: string): HostRow;
  resolveOwnedLocalForUser(userId: string): HostRow;
  /**
   * D4.c C1 — enumeration of active local hosts owned by a user
   * (most-recently-seen first). Returns `[]` when the user has no
   * active local host. Used by callers that need to surface the
   * 0/1/N branch explicitly (e.g. multi-host UX, future
   * create-agent placement picker) rather than collapsing into the
   * single-row "resolve" decision.
   */
  listOwnedActiveLocalForUser(userId: string): HostRow[];
}

export class RuntimeHostPlacementResolver implements RuntimeHostPlacementControl {
  constructor(
    private readonly deps: {
      hosts: HostRepo;
      agents: AgentRepo;
      workspaces: WorkspaceRepo;
    },
  ) {}

  assertActiveHost(hostId: string): HostRow {
    const host = this.deps.hosts.get(hostId);
    if (!host) {
      throw new RuntimeHostPlacementError(
        'host_missing',
        `host ${hostId} not found`,
      );
    }
    if (host.revoked_at !== null) {
      throw new RuntimeHostPlacementError(
        'host_revoked',
        `host ${hostId} has been revoked`,
      );
    }
    if (!isHostReadyForPlacement(host)) {
      throw new RuntimeHostPlacementError(
        'host_pending_attach',
        `host ${hostId} has not completed its first daemon attachment`,
      );
    }
    return host;
  }

  assertOwnedActiveHost(hostId: string, userId: string): HostRow {
    const host = this.assertActiveHost(hostId);
    if (host.user_id !== userId) {
      throw new RuntimeHostPlacementError(
        'host_not_owned',
        `host ${hostId} is not owned by user ${userId}`,
      );
    }
    return host;
  }

  /**
   * D4.c C1 — default placement helper used when a route caller
   * doesn't supply an explicit `host_id`. Three branches:
   *
   *   0 active local hosts → `local_host_unbound` (existing
   *     semantics: user has no daemon attached, must claim/create
   *     one first).
   *   1 active local host  → return it.
   *   ≥2 active local hosts → `local_host_ambiguous` (NEW): the
   *     pre-D4.c "silent pick most-recently-seen" behavior is no
   *     longer safe in multi-host scenarios. Caller must pick an
   *     explicit `host_id`. Use `listOwnedActiveLocalForUser` to
   *     enumerate the candidates for the user.
   *
   * In embedded V1 the user always has exactly 1 local host
   * (the desktop running the backend), so this is a no-op
   * change for embedded callers. In standalone — and especially
   * after D3.b multi-daemon scenarios — N≥2 becomes a real
   * branch and the typed `local_host_ambiguous` lets the
   * caller surface a "which host?" UX instead of guessing.
   */
  resolveOwnedLocalForUser(userId: string): HostRow {
    const hosts = this.deps.hosts.listOwnedActiveLocalForUser(userId);
    if (hosts.length === 0) {
      throw new RuntimeHostPlacementError(
        'local_host_unbound',
        `user ${userId} has no active local host`,
      );
    }
    if (hosts.length > 1) {
      throw new RuntimeHostPlacementError(
        'local_host_ambiguous',
        `user ${userId} has ${hosts.length} active local hosts; caller must pick one explicitly`,
      );
    }
    return hosts[0]!;
  }

  resolveOwnedReadyForPlacement(userId: string): HostRow {
    const hosts = this.deps.hosts.listOwnedReadyForPlacement(userId);
    if (hosts.length === 0) {
      throw new RuntimeHostPlacementError(
        'local_host_unbound',
        `user ${userId} has no active host`,
      );
    }
    if (hosts.length > 1) {
      throw new RuntimeHostPlacementError(
        'local_host_ambiguous',
        `user ${userId} has ${hosts.length} active hosts; caller must pick one explicitly`,
      );
    }
    return hosts[0]!;
  }

  listOwnedActiveLocalForUser(userId: string): HostRow[] {
    return this.deps.hosts.listOwnedActiveLocalForUser(userId);
  }

  resolveForAgent(agentId: string): { host: HostRow } {
    const agent = this.deps.agents.get(agentId);
    if (!agent) {
      throw new RuntimeHostPlacementError(
        'agent_missing',
        `agent ${agentId} not found`,
      );
    }
    return { host: this.assertActiveHost(agent.host_id) };
  }

}

/**
 * D4.c C1 — kept for explicit "runtime hard-disabled" use cases
 * (e.g. a future config flag, or non-host-bearing test harnesses)
 * but **no longer wired into standalone backend bootstrap**.
 * Standalone now uses `RuntimeHostPlacementResolver` so multi-host
 * ACL / placement work the same way as embedded — D2.0 guiding
 * principle ("server doesn't pretend to own user filesystem")
 * lives at the route / data-plane layer, not at the placement
 * layer, which is just authoritative DB lookup either way.
 *
 * If you find yourself constructing this in production code,
 * stop and reconsider: the right answer is almost certainly the
 * real Resolver with whatever HostRepo / DB you have.
 */
export class DisabledRuntimeHostPlacement implements RuntimeHostPlacementControl {
  assertActiveHost(hostId: string): HostRow {
    throw disabled(`host ${hostId} cannot be resolved in standalone mode`);
  }

  assertOwnedActiveHost(hostId: string, _userId: string): HostRow {
    throw disabled(`host ${hostId} cannot be resolved in standalone mode`);
  }

  resolveOwnedLocalForUser(userId: string): HostRow {
    throw disabled(`user ${userId} has no local runtime host in standalone mode`);
  }

  resolveOwnedReadyForPlacement(userId: string): HostRow {
    throw disabled(`user ${userId} has no runtime host in standalone mode`);
  }

  listOwnedActiveLocalForUser(_userId: string): HostRow[] {
    throw disabled('local host enumeration is disabled in standalone mode');
  }

  resolveForAgent(agentId: string): { host: HostRow } {
    throw disabled(`agent ${agentId} has no runtime host in standalone mode`);
  }

}

function disabled(message: string): RuntimeHostPlacementError {
  return new RuntimeHostPlacementError('host_runtime_disabled', message);
}
