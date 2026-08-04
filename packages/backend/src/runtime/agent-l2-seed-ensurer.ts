import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';
import {
  dispatchAgentL2Seed,
  resolveOutboundForHost,
  type DataPlaneFailureCode,
} from './workspace-data-plane.js';

/**
 * Pre-spawn L2 seed on the DISPATCH host (relocation-v1 §7 tasks 1/4): before
 * the first spawn in a workspace we TRY to materialize the agent's L2 bundle
 * there. This is an attempt, not a precondition — "L2 must exist before spawn"
 * was the pre-pivot model and is no longer true (shiki + Cindy 2026-08-04).
 * Dispatches the idempotent `agent_l2_seed` intent to the agent's daemon, which
 * mkdir's the deterministic agent-centric bundle coordinate
 * (`<agent home>/workspaces/<workspace_id>`) DIRECTLY — no registry binding
 * and no workspace provision gate it (U1 de-gated the seed handler; a pure-DB
 * membership that has never spawned is a legal unbound state, not a
 * fail-closed one). No provision ever happens here.
 *
 * L2 memory is BEST-EFFORT enrichment, never an admission gate: the
 * runtime-start caller (`seedRuntimeStartL2BestEffort`) records ANY seed
 * outcome — success, an `fs_unavailable` write/read failure, a transport
 * failure, an unwired dep — as a diagnostic only and ALWAYS proceeds with the
 * spawn (reduced/absent L2 context on failure). No seed-layer code decides
 * dispatch. The session cwd — the sole hard-ensured runtime base — is enforced
 * SEPARATELY, host-side, so a swallowed L2 failure can never let a child start
 * without a usable cwd.
 *
 * Per-(host, workspace, agent) SUCCESS memo for this backend lifetime
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
