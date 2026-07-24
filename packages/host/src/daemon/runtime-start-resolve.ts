/**
 * D4.e-6 — daemon-side `runtime_start` path resolution.
 *
 * Invariant I1 / design §3.5: the backend ships `runtime_start` with
 * SEMANTIC refs only (`agent`/`workspace`/`workspace_memory_index` carry
 * `id`/`name`/`kind`, never a host path). The daemon is the sole authority
 * for host-local paths, so it resolves every absolute path here, reusing
 * the exact same single sources as the other D4.e intents:
 *   - `regular` workspaces → the daemon workspace registry
 *     (`registry.resolve(id)`), fail-closed when unbound;
 *   - `agent_home` → daemon-local agent home root + agent id
 *     (never registry-backed), identical to `agent_materialize` /
 *     `agent_workspace_tree`.
 *
 * The result is a `ResolvedStartOptions` — structurally the pre-D4.e-6
 * path-bearing shape — consumed verbatim by `buildPromptContextFromRuntime
 * StartOptions` and the spawn cwd. `spawn-env` keeps consuming the semantic
 * `StartOptions` (it never read a path).
 *
 * Fail-closed: when a regular workspace cannot be resolved the resolver
 * throws a `RuntimeStartResolveError` (a `DaemonTypedError`); the dispatcher
 * validates its code against the spawning intent's error schema
 * (`runtime_start` or `runtime_deliver`) and emits the typed wire code
 * (`workspace_not_provisioned` /
 * `workspace_path_missing` / `registry_unavailable`) instead of collapsing to
 * `internal_error`. This is the daemon-side final boundary; the backend ALSO
 * bounded-lazy-backfills before dispatch (Cindy `2A_y70Aue5X1SlOr`) so a
 * cold-start auto-start of a legacy unprovisioned workspace self-heals rather
 * than fails.
 */
import type { RuntimeStartErrorCode, StartOptions } from '../protocol.js';
import { agentHomeWorkspaceId } from '@silverhand/shared';
import { resolveAgentDir } from './agent-materialize/handler.js';
import { DaemonTypedError } from './typed-error.js';

/** A workspace ref with the daemon-resolved absolute `path` attached. */
export type ResolvedWorkspaceRef = StartOptions['workspace'] & {
  path: string;
};

/** An agent ref with the daemon-resolved L1 `home_dir` attached. */
export type ResolvedAgentRef = StartOptions['agent'] & { home_dir: string };

/**
 * The path-bearing shape consumed by prompt-context + spawn cwd. Identical
 * to the pre-D4.e-6 `StartOptions`, but produced daemon-side from the
 * semantic wire options rather than received over the wire.
 */
export type ResolvedStartOptions = Omit<
  StartOptions,
  'agent' | 'workspace' | 'workspace_memory_index'
> & {
  agent: ResolvedAgentRef;
  workspace: ResolvedWorkspaceRef;
  workspace_memory_index: ResolvedWorkspaceRef[];
  /** The daemon-authenticated computer id this runtime spawns on (the
   *  control-plane binding's `host_id`). Injected into the prompt's This
   *  Context block; never received over the wire. */
  computer_id: string;
};

/** Typed, dispatcher-projectable failure to resolve a runtime_start path. */
export class RuntimeStartResolveError extends DaemonTypedError {
  constructor(
    readonly code: RuntimeStartErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeStartResolveError';
  }
}

export interface RuntimeStartResolveDeps {
  /**
   * Daemon homedir override (test seam — mirrors the other intents'
   * `agentMaterializeHomeDir`). Omitted in production so `computeAgentDir`
   * falls back to the daemon process `homedir()`.
   */
  homeDir?: string;
  /**
   * Exact root under which per-agent L1 dirs live. Production Desktop
   * passes `<SILVERHAND_DIR>/agents`; takes precedence over `homeDir`.
   */
  agentHomeRootDir?: string;
  /**
   * Resolve a `regular` workspace id to its absolute host path. Production
   * wires this to the registry (`registry.resolve(id)`), mapping any
   * `WorkspaceRegistryError` / missing-binding into a
   * `RuntimeStartResolveError` (fail-closed). It MUST throw — never return a
   * guessed path — when the id is unbound.
   */
  resolveRegularWorkspacePath: (workspaceId: string) => string;
  /**
   * Resolve the daemon's own authenticated computer id. Production wires
   * this to {@link resolveAuthenticatedComputerId} over the LIVE outbound
   * binding (standalone host config or the post-claim
   * `host_outbound_attach` binding) — NOT the registry's namespace
   * fallback, whose embedded pre-login placeholder (`daemon_id` / 'local')
   * must never be presented as prompt provenance. It MUST throw
   * (fail-closed) when the daemon is not attached — never guess or fall
   * back to a machine-derived name.
   */
  resolveComputerId: () => string;
}

/**
 * The single computer-id authority for prompt provenance: the host id of an
 * AUTHENTICATED control-plane binding, or a typed fail-closed error. Null
 * means "not attached yet" — a runtime must never spawn believing it is on
 * a placeholder computer, so this refuses rather than guessing.
 */
export function resolveAuthenticatedComputerId(
  binding: { host_id: string } | null,
): string {
  if (binding == null) {
    throw new RuntimeStartResolveError(
      'registry_unavailable',
      'daemon not attached to a control plane; cannot resolve the authenticated computer id',
    );
  }
  return binding.host_id;
}

/**
 * Resolve every host path a `runtime_start` needs from semantic refs.
 * Pure: all registry/error policy lives behind `deps.resolveRegular
 * WorkspacePath`. An `agent_home` ref (including in the memory index) resolves
 * to the CURRENT agent's L1 dir, but ONLY after its id is verified to be this
 * agent's own home workspace id (`agentHomeWorkspaceId(agentId)`, the shared
 * single source). A foreign / corrupt `agent_home` id is NOT silently
 * normalized onto the current agent's L1 — it fails closed (which would
 * otherwise let host B's home, or another agent's, resolve under host A).
 */
export function resolveRuntimeStartPaths(
  options: StartOptions,
  deps: RuntimeStartResolveDeps,
): ResolvedStartOptions {
  const agentId = options.agent.id;
  const homeDir = resolveAgentDir(agentId, deps);
  const ownHomeWorkspaceId = agentHomeWorkspaceId(agentId);

  const resolveWorkspace = (
    workspace: StartOptions['workspace'],
  ): ResolvedWorkspaceRef => {
    if (workspace.kind === 'agent_home') {
      // I4 / single-source guard: an `agent_home` ref must be THIS agent's own
      // home workspace id. Never trust `kind` alone — a mismatched id is a
      // corrupt/foreign ref, not this agent's L1.
      if (workspace.id !== ownHomeWorkspaceId) {
        throw new RuntimeStartResolveError(
          'workspace_not_provisioned',
          `agent_home workspace ref '${workspace.id}' does not belong to agent ` +
            `'${agentId}' (expected '${ownHomeWorkspaceId}'); refusing to ` +
            'resolve a foreign ref onto this agent\'s L1',
        );
      }
      return { ...workspace, path: homeDir };
    }
    return { ...workspace, path: deps.resolveRegularWorkspacePath(workspace.id) };
  };

  return {
    ...options,
    agent: { ...options.agent, home_dir: homeDir },
    workspace: resolveWorkspace(options.workspace),
    workspace_memory_index:
      options.workspace_memory_index.map(resolveWorkspace),
    computer_id: deps.resolveComputerId(),
  };
}
