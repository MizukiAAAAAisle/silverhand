/**
 * D4.e-6 — daemon-side `runtime_start` path resolution.
 *
 * Invariant I1 / design §3.5: the backend ships `runtime_start` with
 * SEMANTIC refs only (`agent`/`workspace`/`workspace_memory_index` carry
 * `id`/`name`/`kind`, never a host path). The daemon is the sole authority
 * for host-local paths, so it resolves every absolute path here, reusing
 * the exact same single sources as the other D4.e intents:
 *   - `regular` workspaces → the deterministic agent-centric bundle root
 *     (`resolveAgentWorkspaceBundleDir`). relocation-v1 §7 task 4: there is no
 *     registry establishment gate any more — a workspace id maps to a UNIQUE
 *     bundle COORDINATE. The active workspace resolves to that coordinate
 *     unconditionally; whether its L2 MEMORY is materialized here is a separate
 *     best-effort fact that governs only the prompt's memory index, NOT whether
 *     the agent may spawn (`bundleL2Present`, the same MEMORY.md predicate the
 *     seeder acks);
 *   - `agent_home` → daemon-local agent home root + agent id
 *     (never registry-backed), identical to `agent_materialize` /
 *     `agent_workspace_tree`.
 *
 * The result is a `ResolvedStartOptions` — structurally the pre-D4.e-6
 * path-bearing shape — consumed verbatim by `buildPromptContextFromRuntime
 * StartOptions` and the spawn cwd. `spawn-env` keeps consuming the semantic
 * `StartOptions` (it never read a path).
 *
 * cwd hard-ensure vs L1/L2 best-effort (relocation-v1 §3.3; shiki + Cindy
 * 2026-08-04):
 *   - the ACTIVE workspace resolves to its deterministic coordinate here; the
 *     supervisor's `ensureRuntimeStartWorkspaceCwd` then HARD-ENSURES that cwd
 *     (mkdir -p + require a usable/enterable directory). That is process
 *     admission — it fails closed ONLY when the OS genuinely cannot spawn a
 *     child there (path occupied by a non-dir file, or the dir cannot be
 *     created/entered), NEVER because MEMORY.md is absent. A missing/half-seeded
 *     L2 still spawns; the prompt simply omits the L2 memory section;
 *   - a memory-INDEX entry fails soft: an unresolvable ref (foreign/corrupt
 *     `agent_home`, unsafe id) OR a coordinate whose MEMORY.md is not readable
 *     here (the legal lazy window where an agent added to a workspace has never
 *     spawned there, or a half-seeded dir) resolves to `path: null` and renders
 *     "unavailable on this computer" — never a fabricated path, never blocking
 *     the spawn.
 *
 * Fail-closed: the active workspace's resolution throws a
 * `RuntimeStartResolveError` (a `DaemonTypedError`) only for a foreign/corrupt
 * `agent_home` ref (`workspace_not_provisioned`) or an unsafe id segment
 * (`registry_unavailable`) — path safety / ownership boundaries, not L2 gates;
 * the dispatcher validates its code against the spawning intent's error schema
 * and emits the typed wire code instead of collapsing to `internal_error`. The
 * unspawnable-cwd case surfaces as `workspace_bundle_missing` from the
 * supervisor's post-resolve cwd hard-ensure.
 */
import type {
  AgentStartOptions,
  ConversationStartOptions,
  RuntimeActionTarget,
  RuntimeStartErrorCode,
  StartOptions,
} from '../protocol.js';
import {
  AGENT_HOME_WORKSPACE_ID_PREFIX,
  agentHomeWorkspaceId,
} from '@silverhand/shared';
import {
  bundleL2Present,
  resolveAgentDir,
  resolveAgentWorkspaceBundleDir,
} from './agent-materialize/handler.js';
import {
  assertSafeWorkspaceIdSegment,
  WorkspaceIdSegmentError,
} from './workspace-path-authority.js';
import { join } from 'node:path';
import { DaemonTypedError } from './typed-error.js';

export function isAgentStartOptions(
  options: StartOptions,
): options is AgentStartOptions {
  return options.runtime_scope.kind === 'agent';
}

export function isResolvedAgentStartOptions(
  options: ResolvedStartOptions,
): options is ResolvedAgentStartOptions {
  return options.runtime_scope.kind === 'agent';
}

/** A workspace ref with the daemon-resolved absolute `path` attached. */
export type ResolvedWorkspaceRef = NonNullable<
  ConversationStartOptions['workspace']
> & {
  path: string;
};

/**
 * A memory-index workspace ref after local resolution. `path` is the memory
 * path offered to the prompt's Workspace Memory Index, or `null` when no
 * readable L2 memory exists here — either an unresolvable ref
 * (cross-computer/foreign or corrupt) or a valid coordinate whose MEMORY.md is
 * not readable here (the legal lazy window after a pure-DB membership add,
 * before the agent has spawned in that workspace, a half-seeded dir, or an
 * unreadable file). The prompt renders it "unavailable on this computer"
 * instead of a fabricated path, and it never blocks the spawn. It resolves once
 * the agent first spawns there and the best-effort seed writes MEMORY.md
 * (relocation-v1 §3.3). This is a memory-path fact, NOT the cwd-usability fact
 * `list_workspaces.agent_dir` reports.
 */
export type ResolvedWorkspaceIndexRef = NonNullable<
  ConversationStartOptions['workspace']
> & {
  path: string | null;
};

/** An agent ref with the daemon-resolved L1 `home_dir` attached. */
export type ResolvedAgentRef = StartOptions['agent'] & { home_dir: string };

/**
 * The path-bearing shape consumed by prompt-context + spawn cwd. Identical
 * to the pre-D4.e-6 `StartOptions`, but produced daemon-side from the
 * semantic wire options rather than received over the wire.
 */
interface ResolvedCommon {
  agent: ResolvedAgentRef;
  /** The daemon-authenticated computer id this runtime spawns on (the
   *  control-plane binding's `host_id`). Injected into the prompt's This
   *  Context block; never received over the wire. */
  computer_id: string;
  /** The one hard-ensured process base selected by RuntimeScope. */
  cwd: string;
}

export type ResolvedConversationStartOptions = Omit<
  ConversationStartOptions,
  'agent' | 'workspace' | 'workspace_memory_index'
> &
  ResolvedCommon & {
    workspace: ResolvedWorkspaceRef | null;
    workspace_memory_index: ResolvedWorkspaceIndexRef[];
  };

export type ResolvedAgentStartOptions = Omit<AgentStartOptions, 'agent'> &
  ResolvedCommon;

export type ResolvedStartOptions =
  | ResolvedConversationStartOptions
  | ResolvedAgentStartOptions;

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
   * The EXACT root under which per-agent L1 dirs live — the computer
   * slot's `agents` dir, read from the daemon's generation-scoped path
   * context at spawn time. Required — no implicit default (#task:1813):
   * a daemon with no computer bound refuses the spawn with its own typed
   * `registry_unavailable` rather than resolving a home-relative
   * coordinate.
   */
  agentHomeRootDir: string;
  /**
   * Memory-readable predicate for a resolved bundle coordinate — the SAME
   * `bundleL2Present` (MEMORY.md readable) fact the seeder acks. Governs ONLY
   * whether a memory-index entry offers a memory path; it is NOT a spawn gate
   * (the active cwd is hard-ensured separately). Test seam only; production
   * omits it and the real fs-backed predicate is used, keeping the resolver
   * pure in unit tests that don't touch disk.
   */
  bundleL2Present?: (bundleDir: string) => Promise<boolean>;
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

/** Resolve one delivery origin to its absolute action workdir. This is distinct
 * from the process cwd: AgentSlot stays rooted at Agent home while each action
 * points at the semantic target's workspace bundle (or the stable
 * workspace-less conversation directory). */
export function resolveRuntimeActionWorkdir(
  agentId: string,
  target: RuntimeActionTarget,
  deps: RuntimeStartResolveDeps,
): string {
  const homeDir = resolveAgentDir(agentId, deps);
  if (target.workspace === null) {
    try {
      return join(
        homeDir,
        'conversations',
        assertSafeWorkspaceIdSegment(target.conversation_id),
      );
    } catch (err) {
      if (err instanceof WorkspaceIdSegmentError) {
        throw new RuntimeStartResolveError('registry_unavailable', err.message);
      }
      throw err;
    }
  }
  // #task:2081: no stored `kind` on the wire — the id decides. The `wsah_`
  // prefix says WHICH alphabet (an agent-home-shaped ref); the exact match
  // against `agentHomeWorkspaceId(agentId)` says WHOSE. A foreign/corrupt
  // agent-home id must fail closed here rather than fall through to bundle
  // resolution (which would resolve it onto a path under this agent).
  if (target.workspace.id.startsWith(AGENT_HOME_WORKSPACE_ID_PREFIX)) {
    const expected = agentHomeWorkspaceId(agentId);
    if (target.workspace.id !== expected) {
      throw new RuntimeStartResolveError(
        'workspace_not_provisioned',
        `agent_home workspace ref '${target.workspace.id}' does not belong to agent '${agentId}' (expected '${expected}')`,
      );
    }
    return homeDir;
  }
  try {
    return resolveAgentWorkspaceBundleDir(agentId, target.workspace.id, deps);
  } catch (err) {
    if (err instanceof WorkspaceIdSegmentError) {
      throw new RuntimeStartResolveError('registry_unavailable', err.message);
    }
    throw err;
  }
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
 * Pure aside from the injectable `bundleL2Present` fs probe. An `agent_home`
 * ref resolves to the CURRENT agent's L1 dir, but ONLY after its id is verified
 * to be this agent's own home workspace id (`agentHomeWorkspaceId(agentId)`,
 * the shared single source). A foreign / corrupt `agent_home` id is NOT
 * silently normalized onto the current agent's L1 (which would let host B's
 * home, or another agent's, resolve under host A): as the ACTIVE workspace it
 * fails closed; as a memory-index entry it degrades to `path: null`.
 *
 * cwd hard-ensure vs memory: the ACTIVE workspace resolves to its
 * deterministic coordinate; the supervisor's `ensureRuntimeStartWorkspaceCwd`
 * then hard-ensures that cwd right after (process admission, NOT an L2 gate). A
 * memory-INDEX entry is checked here — a coordinate whose MEMORY.md is not
 * readable (lazy window / half-seed / unreadable) degrades to `path: null` so
 * the prompt offers no memory path, never a fabricated one. This is the
 * memory-path decision only; it never blocks a spawn.
 */
export function resolveRuntimeStartPaths(
  options: ConversationStartOptions,
  deps: RuntimeStartResolveDeps,
): Promise<ResolvedConversationStartOptions>;
export function resolveRuntimeStartPaths(
  options: AgentStartOptions,
  deps: RuntimeStartResolveDeps,
): Promise<ResolvedAgentStartOptions>;
export function resolveRuntimeStartPaths(
  options: StartOptions,
  deps: RuntimeStartResolveDeps,
): Promise<ResolvedStartOptions>;
export async function resolveRuntimeStartPaths(
  options: StartOptions,
  deps: RuntimeStartResolveDeps,
): Promise<ResolvedStartOptions> {
  const agentId = options.agent.id;
  const homeDir = resolveAgentDir(agentId, deps);
  const ownHomeWorkspaceId = agentHomeWorkspaceId(agentId);
  const memoryReadable = deps.bundleL2Present ?? bundleL2Present;

  if (isAgentStartOptions(options)) {
    return {
      ...options,
      agent: { ...options.agent, home_dir: homeDir },
      computer_id: deps.resolveComputerId(),
      cwd: homeDir,
    };
  }

  // Deterministic path for a ref — no availability judgment (that is the
  // caller's, and differs for the active workspace vs an index entry). Throws
  // a typed `RuntimeStartResolveError` for a foreign/corrupt `agent_home` ref
  // or an unsafe regular id segment.
  const resolvePath = (
    workspace: NonNullable<ConversationStartOptions['workspace']>,
  ): string => {
    // I4 / single-source guard (#task:2081): the wire no longer carries a
    // `kind`, so the id is the sole authority. The `wsah_` prefix identifies an
    // agent-home-shaped ref (WHICH alphabet); the exact match against this
    // agent's own home id decides WHOSE. A mismatched id is a corrupt/foreign
    // ref, not this agent's L1, and must fail closed rather than resolve onto a
    // bundle path under this agent.
    if (workspace.id.startsWith(AGENT_HOME_WORKSPACE_ID_PREFIX)) {
      if (workspace.id !== ownHomeWorkspaceId) {
        throw new RuntimeStartResolveError(
          'workspace_not_provisioned',
          `agent_home workspace ref '${workspace.id}' does not belong to agent ` +
            `'${agentId}' (expected '${ownHomeWorkspaceId}'); refusing to ` +
            'resolve a foreign ref onto this agent\'s L1',
        );
      }
      return homeDir;
    }
    // relocation-v1 §7 task 4 — the L2/cwd PATH is the deterministic
    // agent-centric bundle coordinate. No registry establishment gate; the
    // coordinate self-validates the id segment (traversal-safe). Whether it is
    // a usable cwd / has readable memory is a separate fact checked per role.
    try {
      return resolveAgentWorkspaceBundleDir(agentId, workspace.id, deps);
    } catch (err) {
      if (err instanceof WorkspaceIdSegmentError) {
        throw new RuntimeStartResolveError('registry_unavailable', err.message);
      }
      throw err;
    }
  };

  // The ACTIVE workspace resolves to its coordinate; the cwd is hard-ensured
  // right after by the supervisor's `ensureRuntimeStartWorkspaceCwd`. No memory
  // gate here — a missing/half-seeded L2 still spawns.
  const resolveActive = (
    workspace: NonNullable<ConversationStartOptions['workspace']>,
  ): ResolvedWorkspaceRef => ({ ...workspace, path: resolvePath(workspace) });

  // A memory-INDEX entry offers a memory path only when MEMORY.md is readable.
  // An unresolvable ref (foreign/corrupt agent_home, unsafe id) or a coordinate
  // with no readable memory (lazy window / half-seed / unreadable) resolves to
  // `path: null` — never a guessed path, never blocking the spawn.
  const resolveIndexEntry = async (
    workspace: NonNullable<ConversationStartOptions['workspace']>,
  ): Promise<ResolvedWorkspaceIndexRef> => {
    let path: string;
    try {
      path = resolvePath(workspace);
    } catch (err) {
      if (err instanceof RuntimeStartResolveError) {
        return { ...workspace, path: null };
      }
      throw err;
    }
    return {
      ...workspace,
      path: (await memoryReadable(path)) ? path : null,
    };
  };

  const workspace = options.workspace === null
    ? null
    : resolveActive(options.workspace);
  let cwd: string;
  if (workspace === null) {
    try {
      cwd = join(
        homeDir,
        'conversations',
        assertSafeWorkspaceIdSegment(options.runtime_scope.conversation_id),
      );
    } catch (err) {
      if (err instanceof WorkspaceIdSegmentError) {
        throw new RuntimeStartResolveError('registry_unavailable', err.message);
      }
      throw err;
    }
  } else {
    cwd = workspace.path;
  }
  return {
    ...options,
    agent: { ...options.agent, home_dir: homeDir },
    workspace,
    workspace_memory_index: await Promise.all(
      options.workspace_memory_index.map(resolveIndexEntry),
    ),
    computer_id: deps.resolveComputerId(),
    cwd,
  };
}
