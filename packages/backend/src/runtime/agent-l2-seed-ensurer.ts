import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
  dispatchAgentL2Seed,
  resolveOutboundForHost,
  type DataPlaneFailureCode,
} from './workspace-data-plane.js';

/**
 * Cross-computer slice 1 (#task:1596) — pre-spawn L2 seed on the DISPATCH
 * host: the L2 for the active workspace must exist under the dispatch
 * computer's local root before the first spawn. Dispatches the idempotent
 * `agent_l2_seed` intent to the agent's daemon, which resolves the
 * workspace via ITS registry — the registry is the sole authority
 * (#task:1612), so a missing binding surfaces as the seed's typed
 * `workspace_not_provisioned` and the caller fails closed (no provision
 * happens here, ever).
 *
 * Per-(host, workspace, agent) success memo for this backend lifetime
 * (the daemon-side seed is writeIfMissing-idempotent, so a repeat after a
 * backend restart is safe), in-flight collapse for concurrent spawns, and
 * failures are NOT memoized so the next spawn retries.
 */

export interface AgentL2SeedEnsureFailure {
  code: DataPlaneFailureCode;
  message: string;
  retriable: boolean;
}

export type AgentL2SeedEnsureResult =
  | { ok: true }
  | { ok: false; failure: AgentL2SeedEnsureFailure };

export class AgentL2SeedEnsurer {
  private readonly inFlight = new Map<string, Promise<AgentL2SeedEnsureResult>>();
  private readonly settled = new Set<string>();

  constructor(
    private readonly deps: { outboundFrameAdapter: () => OutboundFrameAdapter | null },
  ) {}

  private key(hostId: string, workspaceId: string, agentId: string): string {
    return JSON.stringify([hostId, workspaceId, agentId]);
  }

  async ensure(
    hostId: string,
    workspaceId: string,
    agentId: string,
  ): Promise<AgentL2SeedEnsureResult> {
    const key = this.key(hostId, workspaceId, agentId);
    if (this.settled.has(key)) return { ok: true };
    const running = this.inFlight.get(key);
    if (running) return running;
    const run = this.seedOne(hostId, workspaceId, agentId, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async seedOne(
    hostId: string,
    workspaceId: string,
    agentId: string,
    key: string,
  ): Promise<AgentL2SeedEnsureResult> {
    const outbound = resolveOutboundForHost(
      this.deps.outboundFrameAdapter(),
      hostId,
    );
    if (outbound.kind === 'failed') {
      return {
        ok: false,
        failure: {
          code: outbound.code,
          message: outbound.message,
          retriable: outbound.retriable,
        },
      };
    }
    const seed = await dispatchAgentL2Seed(
      outbound.adapter,
      hostId,
      outbound.connectionId,
      { agent_id: agentId, workspace_id: workspaceId, template_choice: 'default' },
    );
    if (seed.kind === 'failed') {
      return {
        ok: false,
        failure: {
          code: seed.code,
          message: seed.message,
          retriable: seed.retriable,
        },
      };
    }
    this.settled.add(key);
    return { ok: true };
  }
}
