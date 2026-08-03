import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { resolveAgentWorkspaceBundleDir } from '../agent-materialize/handler.js';
import {
  buildManifest,
  freshStagingPath,
  manifestsEqual,
  probe,
  publishStaged,
  removeStaging,
  stageTree,
  copyTreeStable,
  type Manifest,
} from './opaque-copy.js';
import { RelocationError } from './relocation-error.js';
import {
  assertSafeWorkspaceIdSegment,
  WorkspaceRegistry,
  WorkspaceRegistryError,
  type RegistryBinding,
  type WorkspaceRegistryEntry,
} from './registry.js';
import {
  CWD_SCOPED_SESSION_RUNTIMES,
  isSessionStoreRootVerifiable,
  isSlugVerifiableCwd,
  sessionNamespaceFor,
  type MigrationLogger,
  type SessionStoreEnv,
} from './session-migration.js';

/**
 * #task:1805 workspace-layout-relocation-v1 (§5) — the daemon startup-preflight
 * facet that carries an existing user onto the agent-centric L2 layout on the
 * SAME computer, in place. It transposes each `(agent, workspace)` L2 subtree
 * out of the shared workspace cwd into the deterministic agent-home bundle, and
 * fans each workspace's shared Claude/Qoder session bucket out to every agent's
 * new distinct cwd — verbatim, opaquely, fail-closed, idempotently.
 *
 * This is a NEW facet composed from the shipped machinery per the reuse map
 * (§4): it runs inside the same connect-command preflight as
 * `runWorkspaceDataConvergencePass`, AFTER it (the flatten must settle the
 * registry to the flat raw-id layout first), and it is enabled ONLY at that
 * connect composition entry — the desktop sibling neither enables the facet nor
 * writes the marker (Cindy org ruling). It reuses the registry inventory, the
 * cwd-slug computation, the `isSlugVerifiableCwd` charset gate, the config-dir
 * override normalization, and the fail-closed typed-error discipline; it does
 * NOT reuse the rename-based physical move (cross-fs copy instead) nor the
 * 1→1 session rename (1→N opaque fan-out instead).
 *
 * The whole facet — like the rest of the migration unit — is deletable once the
 * required-upgrade floor guarantees every user is already relocated.
 */

const MARKER_FILE_NAME = 'relocation-v1.marker.json';
const MARKER_SCHEMA_VERSION = 1;
const FACET_ID = 'workspace-layout-relocation-v1';

/** The `.silverhand/agents/*` direct-child set under a workspace's old shared
 *  cwd is BOTH the L2 inventory and the session fan-out census (§5). The census
 *  agent-id becomes a destination path SEGMENT, so it is validated with the
 *  same fs-safe charset the registry applies to workspace ids — an unsafe id is
 *  a contract violation, never "repaired". `readdir` only yields single path
 *  components, so `.`/`..` traversal is impossible by construction; this guards
 *  the charset. */
const SAFE_AGENT_ID_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

const RelocationMarkerV1Schema = z
  .object({
    schema_version: z.literal(MARKER_SCHEMA_VERSION),
    facet: z.literal(FACET_ID),
    completed_at: z.number().int().nonnegative(),
    migrated: z
      .object({
        workspaces: z.number().int().nonnegative(),
        agents: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export interface RelocationDeps {
  /** Per-computer workspace-data root; holds the flat registry AND the marker
   *  (`connect-command`'s `paths.workspaceDataRootDir`). */
  workspaceDataRootDir: string;
  /** The computer's agent-home root (`computers/<computer_id>/agents`); the
   *  bundle destination resolves under it. */
  agentHomeRootDir: string;
  /** The daemon's resolved control-plane binding — the registry inventory read
   *  is scoped to it (foreign registry fails closed). */
  currentBinding: RegistryBinding;
  /** `homedir()` — the session-store root base, exactly as the spawned runtime
   *  child will resolve it. */
  sessionStoreHome: string;
  /** The daemon process env (same env the runtime child inherits), for the
   *  config-dir override normalization. */
  env: SessionStoreEnv;
  logger: MigrationLogger;
  /** Injectable clock for the marker's `completed_at` (tests). */
  now?: () => number;
}

export interface RelocationResult {
  status: 'already_done' | 'migrated';
  workspaces: number;
  agents: number;
  /** Whether this preflight actually ran the migration (marker was absent or
   *  corrupt) versus finding a valid marker and skipping. */
  moved: boolean;
}

type MarkerRouting =
  | { kind: 'done'; workspaces: number; agents: number }
  | { kind: 'run' };

/**
 * Route the completion marker (§5). NOT "any unknown ⇒ re-run": a missing file,
 * or a file whose `schema_version` we cannot even read, or a current-version
 * file that fails full validation, is treated as *not done* and re-run (the
 * filesystem-state classifier makes an already-published destination a safe
 * no-op). A strictly HIGHER version is a future/downgrade artifact this binary
 * has no right to interpret, and a value BELOW the first shipped version routes
 * to a named-but-empty lower arm — both fail closed rather than reinterpret as
 * v1.
 */
function readRelocationMarker(markerPath: string): MarkerRouting {
  let raw: string;
  try {
    raw = readFileSync(markerPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'run' };
    throw new RelocationError(
      'relocation_unreadable',
      `cannot read relocation marker ${markerPath} (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Current-shape file that is corrupt JSON → not done, re-run.
    return { kind: 'run' };
  }

  const version = (parsed as { schema_version?: unknown } | null)?.schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    // No routable version key → corrupt, re-run.
    return { kind: 'run' };
  }
  if (version > MARKER_SCHEMA_VERSION) {
    throw new RelocationError(
      'relocation_marker_unsupported',
      `relocation marker schema_version ${version} is newer than this binary supports (${MARKER_SCHEMA_VERSION}); refusing to reinterpret it as v${MARKER_SCHEMA_VERSION}`,
    );
  }
  if (version < MARKER_SCHEMA_VERSION) {
    // Named lower arm — v1 is the first shipped version, so nothing is below
    // it; a lower value is an artifact this binary cannot interpret.
    throw new RelocationError(
      'relocation_marker_unsupported',
      `relocation marker schema_version ${version} is below the first shipped version (${MARKER_SCHEMA_VERSION})`,
    );
  }

  const result = RelocationMarkerV1Schema.safeParse(parsed);
  if (!result.success) {
    // Current-version but otherwise malformed → not done, re-run.
    return { kind: 'run' };
  }
  return {
    kind: 'done',
    workspaces: result.data.migrated.workspaces,
    agents: result.data.migrated.agents,
  };
}

/** Read the retained registry as the migration inventory (§5) under the current
 *  binding. Absent registry → empty inventory (nothing to relocate). Any
 *  read/parse/foreign failure fails closed as unreadable — the migration never
 *  runs against a registry it cannot fully trust. Every entry is validated at
 *  this boundary: its `workspace_id` must be an fs-safe path segment (it becomes
 *  a destination segment) and its `path` must be absolute and already canonical,
 *  so a bare `WorkspaceRegistryError('invalid_path')` can never escape untyped
 *  from the downstream bundle-dir resolution, and no `..`/relative root is ever
 *  fed to a copy. */
function readInventory(deps: RelocationDeps): WorkspaceRegistryEntry[] {
  const registry = new WorkspaceRegistry({
    stateDir: deps.workspaceDataRootDir,
    binding: deps.currentBinding,
  });
  let entries: WorkspaceRegistryEntry[];
  try {
    entries = registry.list();
  } catch (err) {
    if (err instanceof WorkspaceRegistryError) {
      throw new RelocationError(
        'relocation_unreadable',
        `cannot read the workspace registry inventory (${err.code}): ${err.message}`,
      );
    }
    throw err;
  }
  for (const entry of entries) {
    try {
      assertSafeWorkspaceIdSegment(entry.workspace_id);
    } catch (err) {
      throw new RelocationError(
        'relocation_unverifiable',
        `registry inventory workspace id ${JSON.stringify(entry.workspace_id)} is not a safe path segment (${err instanceof WorkspaceRegistryError ? err.code : 'invalid'})`,
      );
    }
    if (!isAbsolute(entry.path) || resolve(entry.path) !== entry.path) {
      throw new RelocationError(
        'relocation_unverifiable',
        `registry inventory path ${JSON.stringify(entry.path)} for workspace ${entry.workspace_id} is not an absolute, canonical path`,
      );
    }
  }
  return entries;
}

/** The `.silverhand/agents/*` direct-child agent-id set under a workspace's old
 *  shared cwd. Absent `agents/` dir → empty census (a workspace whose agents
 *  never wrote L2). A non-directory `agents` node, or an unreadable one, fails
 *  closed. Non-directory children are skipped (they are not agent subtrees);
 *  every directory child's name must be a safe path segment. */
function enumerateAgentCensus(oldRoot: string): string[] {
  const agentsDir = join(oldRoot, '.silverhand', 'agents');
  const state = probe(agentsDir);
  if (state === 'absent') return [];
  if (state === 'unreadable') {
    throw new RelocationError(
      'relocation_unreadable',
      `cannot inspect ${agentsDir}`,
    );
  }
  if (state !== 'dir') {
    throw new RelocationError(
      'relocation_conflict',
      `${agentsDir} is not a directory`,
    );
  }
  // The manifest walk classifies types and fails closed on non-copyable nodes;
  // reuse it as the one directory reader so `agents/` enumeration shares the
  // same fail-closed lstat discipline.
  const manifest = buildManifest(agentsDir);
  const census: string[] = [];
  for (const [rel, entry] of manifest) {
    if (rel === '' || rel.includes('/')) continue; // only direct children
    if (entry.type !== 'dir') continue; // a stray file under agents/ is not an agent subtree
    if (!SAFE_AGENT_ID_SEGMENT.test(rel)) {
      throw new RelocationError(
        'relocation_unverifiable',
        `agent home id ${JSON.stringify(rel)} under ${agentsDir} is not a safe path segment`,
      );
    }
    census.push(rel);
  }
  return census.sort();
}

/**
 * The one publish classifier (§5), 1→1: classify a (source, destination) pair
 * purely by filesystem state and act. Source retained forever, so a lone
 * published destination is a legitimate replay only when its manifest equals
 * the source's; a lone destination with NO source is unverifiable.
 */
function relocateSingleTree(source: string, dest: string): void {
  const s = probe(source);
  const d = probe(dest);
  if (s === 'dir') {
    if (d === 'absent') {
      copyTreeStable(source, dest);
      return;
    }
    if (d === 'dir') {
      if (manifestsEqual(buildManifest(source), buildManifest(dest))) return; // settled replay
      throw new RelocationError(
        'relocation_conflict',
        `${dest} already exists with different content than ${source}`,
      );
    }
    throw new RelocationError(
      d === 'unreadable' ? 'relocation_unreadable' : 'relocation_special_file',
      `destination ${dest} is ${d}`,
    );
  }
  if (s === 'absent') {
    if (d === 'absent') return; // not-applicable, settled no-op
    throw new RelocationError(
      'relocation_conflict',
      `${dest} exists but its source ${source} is absent; a retained source cannot legitimately vanish`,
    );
  }
  throw new RelocationError(
    s === 'unreadable' ? 'relocation_unreadable' : 'relocation_special_file',
    `source ${source} is ${s}`,
  );
}

/**
 * Fan one shared source bucket out to N destination buckets under ONE batch
 * stability boundary (§5). All destinations are staged (or verified already
 * equivalent) against a SINGLE `source-before` manifest; only after the whole
 * batch verifies AND `source-after == source-before` are the staged copies
 * published. So a source rewritten anywhere across the fan-out withholds every
 * publish and the marker, and a retry lands all N against one stable source —
 * no destination ever picks its own legal source version.
 *
 * `opts.onStaged` is the TEST-ONLY seam (fires after all staging, before the
 * source-after check) to simulate a mid-fan-out source rewrite.
 */
function fanOutOneBucket(
  source: string,
  dests: readonly string[],
  opts?: { onStaged?: () => void },
): number {
  const s = probe(source);
  if (s === 'absent') {
    // Not-applicable when no destination exists; a lone destination with no
    // source is unverifiable (§5 source-absent rows).
    for (const dest of dests) {
      if (probe(dest) !== 'absent') {
        throw new RelocationError(
          'relocation_conflict',
          `session destination ${dest} exists but its source bucket ${source} is absent`,
        );
      }
    }
    return 0;
  }
  if (s !== 'dir') {
    throw new RelocationError(
      s === 'unreadable' ? 'relocation_unreadable' : 'relocation_special_file',
      `session source bucket ${source} is ${s}`,
    );
  }
  // Source present. A live bucket with zero destinations (zero-census) is the
  // unexpected state (§5) — never silently orphan it.
  if (dests.length === 0) {
    throw new RelocationError(
      'relocation_conflict',
      `session bucket ${source} exists but the workspace has zero agent census`,
    );
  }

  const before = buildManifest(source);
  const toPublish: Array<{ staging: string; dest: string }> = [];
  // Every staging path is registered for cleanup the instant it is chosen —
  // BEFORE `stageTree` runs — so a mid-stage failure (a torn copy, a special
  // file discovered deep in the tree) still leaves no staging residue.
  const stagings: string[] = [];
  try {
    for (const dest of dests) {
      const d = probe(dest);
      if (d === 'absent') {
        const staging = freshStagingPath(dest);
        stagings.push(staging);
        stageTree(source, staging);
        if (!manifestsEqual(buildManifest(staging), before)) {
          throw new RelocationError(
            'relocation_unstable',
            `staged session copy for ${dest} diverged from the batch source snapshot`,
          );
        }
        toPublish.push({ staging, dest });
      } else if (d === 'dir') {
        if (!manifestsEqual(buildManifest(dest), before)) {
          throw new RelocationError(
            'relocation_conflict',
            `session destination ${dest} exists with content differing from ${source}`,
          );
        }
        // already-present equivalent → settled replay, no stage
      } else {
        throw new RelocationError(
          d === 'unreadable' ? 'relocation_unreadable' : 'relocation_special_file',
          `session destination ${dest} is ${d}`,
        );
      }
    }
    opts?.onStaged?.();
    if (!manifestsEqual(buildManifest(source), before)) {
      throw new RelocationError(
        'relocation_unstable',
        `session source bucket ${source} changed during the fan-out; refusing to publish a torn batch`,
      );
    }
    for (const { staging, dest } of toPublish) {
      publishStaged(staging, dest);
    }
  } catch (err) {
    for (const staging of stagings) removeStaging(staging);
    throw err;
  }
  return toPublish.length;
}

type CwdScopedSessionRuntime = (typeof CWD_SCOPED_SESSION_RUNTIMES)[number];

/** A census entry: a workspace's retained inventory row paired with its
 *  `.silverhand/agents/*` census, enumerated ONCE and reused by both the L2
 *  moves and the session plan. */
interface CensusedWorkspace {
  entry: WorkspaceRegistryEntry;
  census: readonly string[];
}

/** One planned session fan-out: a single shared source bucket and the deduped
 *  set of physical destination namespaces it publishes to. */
interface SessionFanOutStep {
  kind: CwdScopedSessionRuntime;
  source: string;
  dests: string[];
}

/**
 * Plan every cwd-scoped runtime's session fan-out across the WHOLE inventory
 * BEFORE any publish (§5, Cindy 2026-08-04). The vendor cwd-slug is
 * non-injective (`/._` all fold to `-`), so two distinct new bundle cwds can
 * resolve to the same physical session namespace. This planner is the one place
 * that reconciles the collapse:
 *
 * - two destinations from the SAME source bucket (aliasing agents) collapse to
 *   one publish — the agents stay separated at runtime by their `cli_session_id`
 *   inside the shared bucket, exactly as the prior cwd-slug migration
 *   (#task:1663) established;
 * - one destination claimed by TWO DIFFERENT source buckets is an ambiguous
 *   merge of distinct histories — a typed `relocation_conflict` raised HERE,
 *   before L2 or session has published anything, so a colliding inventory aborts
 *   the whole preflight with every destination still absent.
 *
 * A workspace with a live source bucket but zero census yields a `source → ∅`
 * step so the executor's `fanOutOneBucket` fails closed on the orphan rather
 * than silently dropping it.
 */
function planSessionFanOut(
  workspaces: readonly CensusedWorkspace[],
  deps: RelocationDeps,
): SessionFanOutStep[] {
  const steps: SessionFanOutStep[] = [];
  for (const kind of CWD_SCOPED_SESSION_RUNTIMES) {
    const destOwner = new Map<string, string>(); // physical destination → owning source namespace
    const bySource = new Map<string, Set<string>>(); // source namespace → deduped destinations
    for (const { entry, census } of workspaces) {
      const oldRoot = entry.path;
      if (!isSlugVerifiableCwd(oldRoot)) {
        throw new RelocationError(
          'relocation_unverifiable',
          `workspace cwd ${oldRoot} is outside the verified session-slug charset`,
        );
      }
      if (!isSessionStoreRootVerifiable(kind, deps.env)) {
        throw new RelocationError(
          'relocation_unverifiable',
          `${kind} session store root is unverifiable from the environment`,
        );
      }
      const source = sessionNamespaceFor(kind, oldRoot, deps.sessionStoreHome, deps.env)!;
      if (!bySource.has(source)) bySource.set(source, new Set());
      const bucket = bySource.get(source)!;
      for (const agentId of census) {
        const newCwd = resolveAgentWorkspaceBundleDir(agentId, entry.workspace_id, {
          agentHomeRootDir: deps.agentHomeRootDir,
        });
        if (!isSlugVerifiableCwd(newCwd)) {
          throw new RelocationError(
            'relocation_unverifiable',
            `new bundle cwd ${newCwd} is outside the verified session-slug charset`,
          );
        }
        const dest = sessionNamespaceFor(kind, newCwd, deps.sessionStoreHome, deps.env)!;
        const owner = destOwner.get(dest);
        if (owner !== undefined && owner !== source) {
          throw new RelocationError(
            'relocation_conflict',
            `session destination ${dest} is claimed by two distinct source buckets (${owner} and ${source}); refusing to merge distinct histories`,
          );
        }
        destOwner.set(dest, source);
        bucket.add(dest);
      }
    }
    for (const [source, dests] of bySource) {
      steps.push({ kind, source, dests: [...dests] });
    }
  }
  return steps;
}

/** Write the completion marker LAST, atomically (§5): temp-file + same-dir
 *  rename, single writer. */
function writeRelocationMarkerAtomic(
  markerPath: string,
  migrated: { workspaces: number; agents: number },
  now: () => number,
): void {
  const payload = {
    schema_version: MARKER_SCHEMA_VERSION,
    facet: FACET_ID,
    completed_at: now(),
    migrated,
  };
  const tmp = `${markerPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, markerPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort tmp cleanup
    }
    throw new RelocationError(
      'relocation_move_failed',
      `writing the relocation marker ${markerPath} failed (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
}

/**
 * Run the L2-relocation preflight facet (§5). Idempotent and fail-closed: on a
 * valid marker it skips; otherwise it relocates every agent's L2 subtree and
 * fans out every workspace's session bucket, then writes the marker LAST. Any
 * unverifiable/conflicting/torn state throws a typed {@link RelocationError}
 * and the marker is not written — the caller (connect preflight) aborts daemon
 * startup, leaving every source byte in place for the next startup to retry.
 */
export function runWorkspaceLayoutRelocation(deps: RelocationDeps): RelocationResult {
  const markerPath = join(deps.workspaceDataRootDir, MARKER_FILE_NAME);
  const marker = readRelocationMarker(markerPath);
  if (marker.kind === 'done') {
    return {
      status: 'already_done',
      workspaces: marker.workspaces,
      agents: marker.agents,
      moved: false,
    };
  }

  const inventory = readInventory(deps);

  // Phase 1 — enumerate every workspace's census ONCE (shared by L2 + session).
  const workspaces: CensusedWorkspace[] = inventory.map(entry => ({
    entry,
    census: enumerateAgentCensus(entry.path),
  }));

  // Phase 2 — PLAN, no writes. The L2 destination is injective in
  // `(agentId, workspaceId)` so it cannot cross-collide, but the session
  // namespace CAN (the cwd-slug is non-injective), so the whole-inventory
  // session plan is computed and its cross-source collisions raised HERE,
  // before any publish. A conflict aborts with every destination still absent.
  const l2Moves: Array<{ source: string; dest: string }> = [];
  for (const { entry, census } of workspaces) {
    for (const agentId of census) {
      l2Moves.push({
        source: join(entry.path, '.silverhand', 'agents', agentId),
        dest: resolveAgentWorkspaceBundleDir(agentId, entry.workspace_id, {
          agentHomeRootDir: deps.agentHomeRootDir,
        }),
      });
    }
  }
  const sessionSteps = planSessionFanOut(workspaces, deps);

  // Phase 3 — EXECUTE the validated plan. L2 first, then the session fan-out.
  for (const { source, dest } of l2Moves) {
    relocateSingleTree(source, dest);
  }
  for (const step of sessionSteps) {
    fanOutOneBucket(step.source, step.dests);
  }

  const migrated = { workspaces: inventory.length, agents: l2Moves.length };
  writeRelocationMarkerAtomic(markerPath, migrated, deps.now ?? Date.now);
  deps.logger.info(
    { action: 'workspace_layout_relocation_completed', ...migrated },
    'workspace-layout relocation completed; per-agent L2 bundles and session buckets published',
  );
  return {
    status: 'migrated',
    workspaces: inventory.length,
    agents: l2Moves.length,
    moved: true,
  };
}

// Re-exported for the falsifier tests that exercise the batch fan-out and the
// snapshot seam directly.
export {
  enumerateAgentCensus as __test_enumerateAgentCensus,
  fanOutOneBucket as __test_fanOutOneBucket,
  planSessionFanOut as __test_planSessionFanOut,
  readRelocationMarker as __test_readRelocationMarker,
  relocateSingleTree as __test_relocateSingleTree,
};
export type { Manifest };
