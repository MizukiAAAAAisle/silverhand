/**
 * #task:1603 — the eager layout-v2 migration engine
 * (docs/app-data-layout-v2.md §5/§6, eager model).
 *
 * The filesystem is the progress record: no per-file state machine. Each
 * facet stages into its deterministic staging root, is validated there,
 * and activates with ONE same-filesystem rename. Crash anywhere resumes
 * deterministically from what is on disk. Everything here fails closed —
 * symlinks/special files, coexistence, EXDEV, and unreadable states block
 * startup rather than merging or copying.
 *
 * Order per run: classify sources → eager session pass (sessions.ts) →
 * facet tree moves → completion marker. The session pass and the tree
 * move consume the SAME classification result: the engine picks each
 * facet's single authoritative source for this run, and cwd pairs are
 * derived from that source only (old/new cwds are always computed from
 * resolver + slug functions — never parsed back off disk).
 *
 * Single physical-move owner: the engine owns the run-era registry
 * namespace move (`run/<binding-slug>/` → `computers/<computer_id>/
 * workspace-data/<binding-slug>/`). The daemon's own state-dir migration
 * must not move the same source; its stale-path ALIAS provenance is a
 * separate concern (#1529) with its own observation-first removal gate.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { classifyServerUrl } from '@silverhand/shared';
import {
  embeddedServerStagingDir,
  localComputerStagingDir,
  resolveDesktopAppPaths,
  type DesktopAppPaths,
} from '@silverhand/shared/app-data-layout';
import {
  bindingSlug,
  executeWorkspaceDataConvergence,
  FlattenLayoutError,
  managedWorkspaceSlug,
  parseWorkspaceRegistryFileStrict,
  planWorkspaceDataConvergence,
  runSessionRenamePass,
  runWorkspaceDataConvergencePass,
  SessionMigrationError,
  type RegistryBinding,
  type SessionCwdPair,
  type SessionStoreEnv,
  type WorkspaceRegistryFile,
} from '@silverhand/host';
import { resolveComputerSlotPaths } from '@silverhand/shared/app-data-layout';
import { readDataLayoutMarker, writeDataLayoutMarker } from './marker.js';

export class LayoutMigrationError extends Error {
  constructor(
    readonly code:
      | 'layout_conflict'
      | 'layout_unreadable'
      | 'layout_special_file'
      | 'layout_move_failed'
      | 'layout_registry_rewrite_blocked'
      | 'layout_marker_corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'LayoutMigrationError';
  }
}

type EntryState = 'absent' | 'dir' | 'file' | 'special' | 'unreadable';

function entryState(path: string): EntryState {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'special';
}

/** One legacy→final move unit inside a facet. */
interface FacetEntry {
  legacy: string;
  /** Path inside the staging root the entry moves to. */
  staged: string;
  kind: 'dir' | 'file';
}

export interface MigrationLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

export interface MigrateResult {
  migrated: boolean;
  facets: { localComputer: 'migrated' | 'noop' | 'already'; embeddedServer: 'migrated' | 'noop' | 'already' };
  sessions: 'migrated' | 'noop' | 'already';
}

export interface SessionPassTestSeams {
  sessionStoreHome?: string;
  env?: SessionStoreEnv;
}

/**
 * The common startup preparation (§5): both desktop modes call this after
 * single-instance ownership + legacy daemon quiesce, BEFORE reading host
 * config, spawning the daemon, or opening the embedded DB. Idempotent:
 * a completed marker short-circuits; a crash mid-staging resumes.
 *
 * A marker WITHOUT the `sessions` completion fact (only the dev-machine
 * dogfood build ever wrote one) triggers a session-only catch-up pass:
 * the v2 tree is the authoritative source, cwd pairs are recomputed from
 * resolver coordinates, and the marker is rewritten with the fact.
 */
export function migrateDesktopAppDataLayout(
  appRoot: string,
  logger: MigrationLogger,
  now: () => number = Date.now,
  seams: SessionPassTestSeams = {},
): MigrateResult {
  const legacy = resolveDesktopAppPaths(appRoot, 'legacy-v1');
  const v2 = resolveDesktopAppPaths(appRoot, 'v2');
  const sessionDeps = {
    sessionStoreHome: seams.sessionStoreHome ?? homedir(),
    env: seams.env ?? (process.env as SessionStoreEnv),
    logger,
  };

  const marker = readDataLayoutMarker(v2.desktop.layoutMarker);
  if (marker.state === 'corrupt') {
    throw new LayoutMigrationError(
      'layout_marker_corrupt',
      `data-layout marker is unreadable (${marker.detail}); refusing to guess the physical layout`,
    );
  }
  if (marker.state === 'v2') {
    // §6.4 case 5 — v2 is authoritative; later legacy leftovers are inert
    // and reported, never re-adopted or deleted.
    reportInertLegacyLeftovers(legacy, logger);
    if (marker.marker.computer_slot && marker.marker.workspace_layout) {
      return {
        migrated: false,
        facets: { localComputer: 'already', embeddedServer: 'already' },
        sessions: 'already',
      };
    }
    let renamed = 0;
    let catchUpFacts: BindingConfigFacts | null = null;
    if (!marker.marker.computer_slot) {
      // #task:1608 — computer-slot catch-up (the pre-revision dogfood
      // marker): durable computer data still sits at the retired
      // `computers/local` alias. Move it to `computers/<computer_id>`,
      // relocate the binding file, rewrite registry paths with exact
      // provenance, and re-rename the session buckets whose cwds changed
      // again. This reader exists ONLY here in the deletable unit.
      const slotPass = runComputerSlotCatchUp(appRoot, v2, sessionDeps, logger);
      renamed += slotPass.renamed;
      catchUpFacts = slotPass.facts;
      logger.info(
        { action: 'layout_v2_computer_slot_caught_up', renamed: slotPass.renamed },
        'computer slot migrated off the retired computers/local alias',
      );
    }
    // #task:1608 workspace-data convergence catch-up: lift the current
    // binding's registry to workspace-data/, rename managed dirs to raw
    // ids, re-rename the affected session buckets, THEN stamp. Old cwds
    // here are the SLOT-ERA slug coordinates (the state this marker
    // proves). No binding at all → nothing claims a namespace → no-op.
    const facts =
      catchUpFacts ?? readBindingConfig([v2.desktop.computerBinding], logger);
    if (facts !== null) {
      renamed += runWorkspaceFlattenCatchUp(
        resolveComputerSlotPaths(appRoot, facts.hostId).workspaceData,
        currentBindingFor(facts),
        sessionDeps,
        logger,
      );
    }
    writeDataLayoutMarker(
      v2.desktop.layoutMarker,
      marker.marker.migrated_at,
      marker.marker.sessions?.migrated_at ?? now(),
      marker.marker.computer_slot?.migrated_at ?? now(),
      now(),
    );
    return {
      migrated: true,
      facets: { localComputer: 'already', embeddedServer: 'already' },
      sessions: renamed > 0 ? 'migrated' : 'noop',
    };
  }

  // ── provenance: the target computer id (#task:1608) ──────────────────
  // The migration may only claim legacy computer data when the legacy
  // binding config proves WHICH computer it belongs to. Reading precedes
  // every move; a crash after the binding file relocated resumes from the
  // new location.
  const bindingFacts = readBindingConfig(
    [v2.desktop.computerBinding, legacy.legacyLocalComputer.daemonConfig],
    logger,
  );
  const computerId = bindingFacts?.hostId ?? null;
  const slot = computerId !== null ? resolveComputerSlotPaths(appRoot, computerId) : null;

  // ── classify (once) ──────────────────────────────────────────────────
  const localStaging = localComputerStagingDir(appRoot);
  const runNamespaces = provableRunEraNamespaces(legacy.run.root, logger);
  const localEntries = localComputerEntries(legacy, localStaging, runNamespaces);
  const hasComputerData =
    localEntries.some(e => entryState(e.legacy) !== 'absent') ||
    entryState(localStaging) === 'dir';
  if (hasComputerData && slot === null) {
    throw new LayoutMigrationError(
      'layout_conflict',
      'legacy computer data exists but no binding config proves its computer id; refusing to guess a slot',
    );
  }
  const local =
    slot !== null
      ? classifyFacet('local_computer', localStaging, slot.root, localEntries, [
          // The facet's expected final children, DERIVED from the slot
          // resolver (never a hand-maintained name list — Cindy R2 gate).
          basename(slot.agents),
          basename(slot.workspaceData),
          basename(slot.proxyConfig),
        ])
      : null;

  const embeddedStaging = embeddedServerStagingDir(appRoot);
  const embeddedEntries = embeddedServerEntries(legacy, embeddedStaging);
  const embedded = classifyFacet('embedded_server', embeddedStaging, v2.embeddedServer.root, embeddedEntries);

  // ── eager session pass (before any tree move) ────────────────────────
  // Source selection follows the local facet's classification: final-dir
  // (crash after activation, before marker) → the slot tree; otherwise the
  // legacy tree plus any staged remainder of the SAME source in flight.
  let pass = { renamed: 0 };
  let localResult: 'migrated' | 'noop' | 'already' = 'noop';
  if (slot !== null && local !== null) {
    const cwdMap: SessionCwdMap = {
      oldAgentsRoot: legacy.legacyLocalComputer.agents,
      newAgentsRoot: slot.agents,
      oldNamespaceRoot: ns => join(legacy.run.root, ns),
      newWorkspaceData: slot.workspaceData,
    };
    const sessionSources =
      local.finalState === 'dir' && !local.finalPreexisting
        ? { agentsDirs: [slot.agents], namespaceRoots: [slot.workspaceData] }
        : {
            // finalPreexisting (#task:1608 R2-1): a mid-activation crash may
            // have left some outputs in the final root — enumerate BOTH
            // trees (dedup by oldCwd; cwd values stay coordinate-computed).
            agentsDirs: [
              legacy.legacyLocalComputer.agents,
              join(localStaging, 'agents'),
              ...(local.finalPreexisting ? [slot.agents] : []),
            ],
            namespaceRoots: [
              join(localStaging, 'workspace-data'),
              ...(local.finalPreexisting ? [slot.workspaceData] : []),
            ],
            runNamespaces: runNamespaces.map(ns => join(legacy.run.root, ns)),
          };
    const pairs = collectSessionCwdPairs(cwdMap, sessionSources);
    // #task:1608 workspace-data convergence — the current binding's
    // managed workspaces end at the FLAT raw-id coordinate, not the slug
    // one. Their registry-driven pairs are prepended (first-wins per
    // oldCwd), overriding the slug-targeted pair the directory
    // enumeration would produce; old cwds stay run-era
    // coordinate-computed. Probed across every place the namespace can
    // physically be mid-crash; a flat registry already present means the
    // session pass completed in the run that started the flatten.
    const currentBinding = currentBindingFor(bindingFacts!);
    const adoptionPlan = planCrossBindingManagedAdoptions({
      workspaceDataRoots: [
        join(localStaging, 'workspace-data'),
        legacy.run.root,
        slot.workspaceData,
      ],
      legacyRunRoot: legacy.run.root,
      v2WorkspaceData: slot.workspaceData,
      currentBinding,
    });
    const flattenPlan = wrapFlatten(() => {
      for (const root of [
        join(localStaging, 'workspace-data'),
        legacy.run.root,
        slot.workspaceData,
      ]) {
        const plan = planWorkspaceDataConvergence({
          workspaceDataRoot: root,
          currentBinding,
        });
        if (plan.status !== 'no_namespace') return plan;
      }
      return null;
    });
    const registryManagedPairs: SessionCwdPair[] = adoptionPlan.managedSessionSources.flatMap(entry => {
      const legacyNamespaced = join(
        legacy.run.root,
        entry.namespace,
        'workspaces',
        managedWorkspaceSlug(entry.workspaceId),
      );
      const slotNamespaced = join(
        slot.workspaceData,
        entry.namespace,
        'workspaces',
        managedWorkspaceSlug(entry.workspaceId),
      );
      const target = join(slot.workspaceData, 'workspaces', entry.workspaceId);
      return [
        { oldCwd: legacyNamespaced, newCwd: target },
        { oldCwd: slotNamespaced, newCwd: target },
      ];
    });
    const flattenedPairs: SessionCwdPair[] = (flattenPlan?.managed ?? []).map(entry => ({
      oldCwd: join(
        legacy.run.root,
        entry.namespaceName,
        'workspaces',
        entry.legacySlugName,
      ),
      newCwd: join(slot.workspaceData, 'workspaces', entry.workspaceId),
    }));
    const flatPairs = [
      ...registryManagedPairs,
      ...flattenedPairs.filter(
        pair => !registryManagedPairs.some(managed => managed.oldCwd === pair.oldCwd),
      ),
    ];
    // This pass MUST finish before runFacet can persist an adoption. The
    // predecessor registry paths are the evidence used to derive the direct
    // predecessor→final cwd pairs; rewriting them first would make a retry
    // unable to recover session buckets that had not yet moved.
    pass = wrapFlatten(() =>
      runSessionRenamePass(
        [...flatPairs, ...pairs.filter(p => !flatPairs.some(f => f.oldCwd === p.oldCwd))],
        sessionDeps,
      ),
    );

    // ── facet tree move ──────────────────────────────────────────────
    localResult = runFacet({
      facet: 'local_computer',
      stagingRoot: localStaging,
      finalRoot: slot.root,
      entries: localEntries,
      classification: local,
      logger,
      validateStaging: () =>
        rewriteStagedRegistries(
          join(localStaging, 'workspace-data'),
          legacy.run.root,
          slot.workspaceData,
          currentBinding,
          logger,
        ),
    });
    // The binding file is desktop-owned and lives OUTSIDE the slot: its
    // relocation is a separate single atomic rename AFTER the facet and
    // BEFORE the marker (idempotent — legacy absent + destination present
    // resumes as done; the id was already read from either location).
    relocateBindingFile(legacy.legacyLocalComputer.daemonConfig, v2.desktop.computerBinding, logger);
    // #task:1608 workspace-data convergence — flatten the ACTIVATED slot
    // tree (registry lift + raw-id dir renames) before the marker: one
    // strict plan against the final tree, then execute it. The session
    // pass above already targeted the flat coordinates.
    wrapFlatten(() => {
      const plan = planWorkspaceDataConvergence({
        workspaceDataRoot: slot.workspaceData,
        currentBinding,
      });
      executeWorkspaceDataConvergence(plan, {
        workspaceDataRoot: slot.workspaceData,
        logger,
      });
    });
  }
  const embeddedResult = runFacet({
    facet: 'embedded_server',
    stagingRoot: embeddedStaging,
    finalRoot: v2.embeddedServer.root,
    entries: embeddedEntries,
    classification: embedded,
    logger,
  });

  const stamp = now();
  writeDataLayoutMarker(v2.desktop.layoutMarker, stamp, stamp, stamp, stamp);
  logger.info(
    { action: 'layout_v2_migrated', local: localResult, embedded: embeddedResult, sessions_renamed: pass.renamed },
    'desktop app data layout migrated to v2',
  );
  return {
    migrated: true,
    facets: { localComputer: localResult, embeddedServer: embeddedResult },
    sessions: pass.renamed > 0 ? 'migrated' : 'noop',
  };
}

/**
 * Read the computer id from the FIRST binding config that parses with a
 * usable `host_id`, in priority order (v2 binding file first for crash
 * resume, then the legacy location). A present-but-unreadable/corrupt
 * config fails closed — never guess which computer owns durable bytes.
 */
interface BindingConfigFacts {
  hostId: string;
  /** Raw config value retained for the shared loopback/remote discriminator. */
  serverUrl: string;
  sourceName: string;
}

function readBindingConfig(
  candidates: readonly string[],
  logger: MigrationLogger,
): BindingConfigFacts | null {
  for (const path of candidates) {
    const state = entryState(path);
    if (state === 'absent') continue;
    if (state !== 'file') {
      throw new LayoutMigrationError(
        'layout_registry_rewrite_blocked',
        `binding config at ${basename(path)} cannot be inspected or is not a regular file`,
      );
    }
    let parsed: { host_id?: unknown; server_url?: unknown };
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as typeof parsed;
    } catch (err) {
      throw new LayoutMigrationError(
        'layout_registry_rewrite_blocked',
        `binding config at ${basename(path)} cannot be parsed: ${(err as Error).message}`,
      );
    }
    const hostId = parsed.host_id;
    if (typeof hostId !== 'string' || hostId.trim() === '') {
      throw new LayoutMigrationError(
        'layout_registry_rewrite_blocked',
        `binding config at ${basename(path)} carries no usable host_id`,
      );
    }
    // The current binding derives from this ONE strict config, so a missing
    // server_url fails closed; it must never silently degrade to embedded.
    if (typeof parsed.server_url !== 'string' || parsed.server_url.trim() === '') {
      throw new LayoutMigrationError(
        'layout_registry_rewrite_blocked',
        `binding config at ${basename(path)} carries no usable server_url`,
      );
    }
    logger.info(
      { action: 'layout_v2_computer_id_resolved', source: basename(path) },
      'target computer id resolved from the binding config',
    );
    return { hostId, serverUrl: parsed.server_url, sourceName: basename(path) };
  }
  return null;
}

/**
 * Resolve the ONE current registry binding from the same server URL policy
 * that selects the desktop backend. This deliberately mirrors
 * `decideBackendBootMode`: as long as loopback profiles boot embedded, a
 * loopback config belongs to the embedded sentinel and a remote config belongs
 * to its exact origin. If remote-on-loopback ever becomes valid, this
 * classifier and the runtime binding resolver must change together.
 * Historical `local-embedded/<same-host>` namespaces remain available to the
 * adoption planner as predecessor evidence, but never compete as current
 * authority.
 */
function currentBindingFor(facts: BindingConfigFacts): RegistryBinding {
  // This classifies coordinate identity, not transport admission. Allowing
  // insecure remote HTTP here makes it land on its exact remote origin; the
  // package/env policy may still refuse that URL later during backend boot.
  const classified = classifyServerUrl(facts.serverUrl, {
    allowInsecureRemote: true,
  });
  if (!classified.ok) {
    // Production writers persist classifier-normalized URLs. If that
    // provenance is ever broken (manual edit, corruption, or a new writer),
    // block the migration instead of guessing a registry coordinate.
    throw new LayoutMigrationError(
      'layout_registry_rewrite_blocked',
      `binding config at ${facts.sourceName} carries a server_url that cannot identify its registry binding: ${classified.message}`,
    );
  }
  if (classified.kind === 'loopback') {
    return { server_origin: 'local-embedded', host_id: facts.hostId };
  }
  return { server_origin: classified.url.origin, host_id: facts.hostId };
}

interface RegistryNamespaceSnapshot {
  workspaceDataRoot: string;
  namespace: string;
  filePath: string;
  binding: RegistryBinding;
}

interface StrictRegistryNamespaceSnapshot extends RegistryNamespaceSnapshot {
  file: WorkspaceRegistryFile;
}

interface CrossBindingManagedAdoption {
  workspaceId: string;
  sourceNamespace: string;
  targetNamespace: string;
  sourceDir: string;
  targetDir: string;
  targetLegacyPath: string;
  move: 'required' | 'resumed' | 'unmaterialized';
}

interface CrossBindingAdoptionPlan {
  target: StrictRegistryNamespaceSnapshot | null;
  adoptions: CrossBindingManagedAdoption[];
  managedSessionSources: Array<{ workspaceId: string; namespace: string }>;
}

function bindingsEqual(a: RegistryBinding, b: RegistryBinding): boolean {
  return a.server_origin === b.server_origin && a.host_id === b.host_id;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function readRegistryStrictForMigration(
  snapshot: RegistryNamespaceSnapshot,
): StrictRegistryNamespaceSnapshot {
  let raw: string;
  try {
    raw = readFileSync(snapshot.filePath, 'utf-8');
  } catch (err) {
    throw new LayoutMigrationError(
      'layout_registry_rewrite_blocked',
      `registry for namespace ${snapshot.namespace} cannot be read: ${(err as Error).message}`,
    );
  }
  const file = parseWorkspaceRegistryFileStrict(
    raw,
    message =>
      new LayoutMigrationError(
        'layout_registry_rewrite_blocked',
        `registry for namespace ${snapshot.namespace} is invalid: ${message}`,
      ),
  );
  return { ...snapshot, file };
}

/**
 * Read the namespace registries from the facet's authoritative roots.
 * Root order follows the existing workspace convergence planner:
 * staging, then legacy, then final. A namespace duplicated across roots
 * is not a second planning authority; classifyFacet/runFacet still owns
 * the physical collision decision and will fail closed before activation.
 */
function collectRegistryNamespaceSnapshots(
  workspaceDataRoots: readonly string[],
): RegistryNamespaceSnapshot[] {
  const snapshots = new Map<string, RegistryNamespaceSnapshot>();
  for (const workspaceDataRoot of [...new Set(workspaceDataRoots)]) {
    const rootState = entryState(workspaceDataRoot);
    if (rootState === 'absent') continue;
    if (rootState !== 'dir') {
      throw new LayoutMigrationError(
        rootState === 'unreadable' ? 'layout_unreadable' : 'layout_special_file',
        `workspace-data root ${basename(workspaceDataRoot)} cannot be inspected or is not a directory`,
      );
    }
    for (const namespace of readdirSync(workspaceDataRoot)) {
      const namespaceDir = join(workspaceDataRoot, namespace);
      if (entryState(namespaceDir) !== 'dir') continue;
      const filePath = join(namespaceDir, 'workspace-registry.json');
      const fileState = entryState(filePath);
      if (fileState === 'absent') continue;
      if (fileState !== 'file') {
        throw new LayoutMigrationError(
          'layout_registry_rewrite_blocked',
          `registry for namespace ${namespace} cannot be inspected or is not a regular file`,
        );
      }
      const binding = assertRegistryBindingProvenance(filePath, namespace, 'cross-binding');
      if (snapshots.has(namespace)) continue;
      snapshots.set(namespace, {
        workspaceDataRoot,
        namespace,
        filePath,
        binding,
      });
    }
  }
  return [...snapshots.values()];
}

/**
 * The released registry handoff copied an exact managed entry from a
 * trusted predecessor binding into the active binding while preserving
 * the predecessor registry as history. Layout v2 removes cross-binding physical
 * aliases, so the active binding adopts those bytes before flattening.
 *
 * This is NOT a prefix-rewrite escape hatch. Both registry files must
 * strictly parse, both namespace directories must prove their binding
 * slug, and the same workspace id must carry the same exact predecessor
 * managed coordinate in both files.
 */
function planCrossBindingManagedAdoptions(input: {
  workspaceDataRoots: readonly string[];
  legacyRunRoot: string;
  v2WorkspaceData: string;
  currentBinding: RegistryBinding;
}): CrossBindingAdoptionPlan {
  const snapshots = collectRegistryNamespaceSnapshots(input.workspaceDataRoots);
  const strictSnapshots = new Map<string, StrictRegistryNamespaceSnapshot>();
  const strictSnapshot = (
    snapshot: RegistryNamespaceSnapshot,
  ): StrictRegistryNamespaceSnapshot => {
    const cached = strictSnapshots.get(snapshot.namespace);
    if (cached !== undefined) return cached;
    const parsed = readRegistryStrictForMigration(snapshot);
    strictSnapshots.set(snapshot.namespace, parsed);
    return parsed;
  };
  // One full binding hashes to one deterministic namespace coordinate.
  // Other same-host namespaces are historical sources, never co-equal
  // current targets.
  const targetSnapshot =
    snapshots.find(snapshot => bindingsEqual(snapshot.binding, input.currentBinding)) ?? null;
  const target = targetSnapshot === null ? null : strictSnapshot(targetSnapshot);
  if (target === null) {
    return { target: null, adoptions: [], managedSessionSources: [] };
  }

  const adoptions: CrossBindingManagedAdoption[] = [];
  const managedSessionSources: Array<{ workspaceId: string; namespace: string }> = [];
  for (const [workspaceId, targetEntry] of Object.entries(target.file.workspaces)) {
    const slug = managedWorkspaceSlug(workspaceId);
    const ownLegacyPath = join(input.legacyRunRoot, target.namespace, 'workspaces', slug);
    const ownV2Path = join(input.v2WorkspaceData, target.namespace, 'workspaces', slug);
    if (targetEntry.path === ownLegacyPath || targetEntry.path === ownV2Path) {
      managedSessionSources.push({ workspaceId, namespace: target.namespace });
      continue;
    }

    const sources = snapshots.filter(source => {
      if (source.namespace === target.namespace) return false;
      const sourceLegacyPath = join(input.legacyRunRoot, source.namespace, 'workspaces', slug);
      const sourceV2Path = join(input.v2WorkspaceData, source.namespace, 'workspaces', slug);
      if (targetEntry.path !== sourceLegacyPath && targetEntry.path !== sourceV2Path) {
        return false;
      }
      const strictSource = strictSnapshot(source);
      return strictSource.file.workspaces[workspaceId]?.path === targetEntry.path;
    });
    if (sources.length === 0) {
      if (pathInside(input.legacyRunRoot, targetEntry.path) || pathInside(input.v2WorkspaceData, targetEntry.path)) {
        throw new LayoutMigrationError(
          'layout_registry_rewrite_blocked',
          `registry entry for workspace ${workspaceId} in namespace ${target.namespace} points inside managed storage without exact managed provenance from a predecessor registry`,
        );
      }
      continue; // external user-requested path
    }
    if (sources.length !== 1) {
      throw new LayoutMigrationError(
        'layout_registry_rewrite_blocked',
        `workspace ${workspaceId} is claimed by multiple predecessor registries`,
      );
    }

    const source = sources[0]!;
    const sourceDir = join(
      source.workspaceDataRoot,
      source.namespace,
      'workspaces',
      slug,
    );
    const targetDir = join(
      target.workspaceDataRoot,
      target.namespace,
      'workspaces',
      slug,
    );
    const sourceState = entryState(sourceDir);
    const targetState = entryState(targetDir);
    if (sourceState === 'unreadable' || targetState === 'unreadable') {
      throw new LayoutMigrationError(
        'layout_unreadable',
        `cross-binding workspace ${workspaceId} cannot be inspected`,
      );
    }
    if (
      (sourceState !== 'absent' && sourceState !== 'dir') ||
      (targetState !== 'absent' && targetState !== 'dir')
    ) {
      throw new LayoutMigrationError(
        'layout_special_file',
        `cross-binding workspace ${workspaceId} is a symlink or special file`,
      );
    }
    if (sourceState === 'dir' && targetState === 'dir') {
      throw new LayoutMigrationError(
        'layout_conflict',
        `cross-binding workspace ${workspaceId} exists at both predecessor and current coordinates`,
      );
    }
    adoptions.push({
      workspaceId,
      sourceNamespace: source.namespace,
      targetNamespace: target.namespace,
      sourceDir,
      targetDir,
      targetLegacyPath: ownLegacyPath,
      move:
        sourceState === 'dir'
          ? 'required'
          : targetState === 'dir'
            ? 'resumed'
            : 'unmaterialized',
    });
    managedSessionSources.push({ workspaceId, namespace: source.namespace });
  }
  return { target, adoptions, managedSessionSources };
}

function adoptCrossBindingManagedWorkspaces(input: {
  stagedWorkspaceData: string;
  legacyRunRoot: string;
  v2WorkspaceData: string;
  currentBinding: RegistryBinding;
  logger: MigrationLogger;
}): void {
  const plan = planCrossBindingManagedAdoptions({
    workspaceDataRoots: [input.stagedWorkspaceData],
    legacyRunRoot: input.legacyRunRoot,
    v2WorkspaceData: input.v2WorkspaceData,
    currentBinding: input.currentBinding,
  });
  if (plan.target === null || plan.adoptions.length === 0) return;

  for (const adoption of plan.adoptions) {
    if (adoption.move !== 'required') continue;
    mkdirSync(dirname(adoption.targetDir), { recursive: true, mode: 0o700 });
    try {
      renameSync(adoption.sourceDir, adoption.targetDir);
    } catch (err) {
      throw new LayoutMigrationError(
        'layout_move_failed',
        `adopting cross-binding workspace ${adoption.workspaceId} failed (${(err as NodeJS.ErrnoException).code ?? 'rename error'})`,
      );
    }
  }

  for (const adoption of plan.adoptions) {
    plan.target.file.workspaces[adoption.workspaceId]!.path = adoption.targetLegacyPath;
  }
  const tempPath = `${plan.target.filePath}.adopting`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(plan.target.file, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, plan.target.filePath);
  } catch (err) {
    throw new LayoutMigrationError(
      'layout_move_failed',
      `persisting cross-binding workspace adoption failed (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
  input.logger.info(
    {
      action: 'layout_v2_cross_binding_workspaces_adopted',
      namespace: plan.target.namespace,
      workspaces: plan.adoptions.length,
    },
    'historical managed workspaces adopted by the current binding',
  );
}

/** Single-file atomic relocation of the binding config (legacy
 *  `daemon-config.json` → `desktop/computer-binding.json`). Idempotent. */
function relocateBindingFile(
  legacyPath: string,
  v2Path: string,
  logger: MigrationLogger,
): void {
  const legacyState = entryState(legacyPath);
  const v2State = entryState(v2Path);
  if (legacyState === 'unreadable' || v2State === 'unreadable') {
    throw new LayoutMigrationError('layout_unreadable', 'binding config cannot be inspected');
  }
  if (legacyState === 'absent') return; // fresh install or already moved
  if (legacyState !== 'file') {
    throw new LayoutMigrationError('layout_special_file', 'legacy binding config is not a regular file');
  }
  if (v2State !== 'absent') {
    throw new LayoutMigrationError(
      'layout_conflict',
      'legacy and v2 binding configs coexist; refusing to pick a side',
    );
  }
  mkdirSync(dirname(v2Path), { recursive: true, mode: 0o700 });
  try {
    renameSync(legacyPath, v2Path);
  } catch (err) {
    throw new LayoutMigrationError(
      'layout_move_failed',
      `relocating the binding config failed (${(err as NodeJS.ErrnoException).code ?? 'rename error'})`,
    );
  }
  logger.info(
    { action: 'layout_v2_binding_relocated' },
    'computer binding config relocated to desktop/computer-binding.json',
  );
}

/**
 * #task:1608 — one-time catch-up for the pre-revision dogfood layout:
 * durable computer data at the retired `computers/local` alias moves to
 * `computers/<computer_id>`, the binding file relocates, registry paths
 * rewrite on exact provenance, and session buckets re-rename (their cwds
 * changed again). The literal 'computers/local' below exists ONLY inside
 * this deletable unit.
 */
function runComputerSlotCatchUp(
  appRoot: string,
  v2: DesktopAppPaths,
  sessionDeps: { sessionStoreHome: string; env: SessionStoreEnv; logger: MigrationLogger },
  logger: MigrationLogger,
): { renamed: number; facts: BindingConfigFacts | null } {
  const legacySlotRoot = join(appRoot, 'computers', 'local');
  const slotState = entryState(legacySlotRoot);
  if (slotState === 'unreadable') {
    throw new LayoutMigrationError('layout_unreadable', 'the computers/local alias cannot be inspected');
  }
  if (slotState === 'absent') return { renamed: 0, facts: null }; // nothing to catch up
  const legacyBinding = join(legacySlotRoot, 'config', 'daemon-config.json');
  const facts = readBindingConfig([v2.desktop.computerBinding, legacyBinding], logger);
  const computerId = facts?.hostId ?? null;
  if (computerId === null) {
    throw new LayoutMigrationError(
      'layout_conflict',
      'computers/local exists but no binding config proves its computer id; refusing to guess a slot',
    );
  }
  const slot = resolveComputerSlotPaths(appRoot, computerId);
  // Session pass FIRST (idempotent: an already-renamed pair classifies as
  // no-op): pairs old=alias coords, new=slot coords. Enumeration reads
  // BOTH the alias tree and the slot tree so a crash-resumed run (some
  // children already moved) still derives the complete pair set — the
  // cwd VALUES are coordinate-computed either way.
  const oldAgents = join(legacySlotRoot, 'agents');
  const oldWorkspaceData = join(legacySlotRoot, 'workspace-data');
  const cwdMap: SessionCwdMap = {
    oldAgentsRoot: oldAgents,
    newAgentsRoot: slot.agents,
    oldNamespaceRoot: ns => join(oldWorkspaceData, ns),
    newWorkspaceData: slot.workspaceData,
  };
  const pairs = collectSessionCwdPairs(cwdMap, {
    agentsDirs: [oldAgents, slot.agents],
    namespaceRoots: [oldWorkspaceData, slot.workspaceData],
  });
  const pass = runSessionRenamePass(pairs, sessionDeps);
  // Registry rewrite IN PLACE on the alias tree (exact provenance:
  // alias-managed coordinate → slot-managed coordinate; idempotent — it
  // also accepts the already-rewritten slot value).
  rewriteStagedRegistries(
    oldWorkspaceData,
    oldWorkspaceData,
    slot.workspaceData,
    currentBindingFor(facts!),
    logger,
  );
  // Per-child idempotent moves (#task:1608 P1-1): each durable child is
  // its own atomic boundary. alias-present + slot-absent → rename;
  // alias-absent + slot-present → already moved (a prior run crashed
  // between children — resume, don't conflict); BOTH present → true
  // ownership ambiguity, fail closed. The alias root itself keeps only
  // transient leftovers (run/, empty config/) and is reported inert.
  mkdirSync(dirname(slot.root), { recursive: true, mode: 0o700 });
  mkdirSync(slot.root, { recursive: true, mode: 0o700 });
  for (const [from, to] of [
    [oldAgents, slot.agents],
    [oldWorkspaceData, slot.workspaceData],
  ] as const) {
    const st = entryState(from);
    const toState = entryState(to);
    if (st === 'unreadable' || toState === 'unreadable') {
      throw new LayoutMigrationError('layout_unreadable', `alias child ${basename(from)} cannot be inspected`);
    }
    if (st === 'absent') {
      // Completion arm must PROVE the destination (#task:1608 R2-2): the
      // marker may only stamp over a slot child that is a real directory
      // (already moved) or genuinely never existed. A file/symlink/special
      // where the slot child should be is not "done" — fail closed.
      if (toState !== 'absent' && toState !== 'dir') {
        throw new LayoutMigrationError(
          'layout_special_file',
          `slot child ${basename(to)} is not a directory; refusing to stamp completion over it`,
        );
      }
      continue;
    }
    if (st !== 'dir') {
      throw new LayoutMigrationError('layout_special_file', `alias child ${basename(from)} is not a directory`);
    }
    if (toState !== 'absent') {
      throw new LayoutMigrationError(
        'layout_conflict',
        `alias child ${basename(from)} and its slot counterpart coexist; refusing to merge`,
      );
    }
    try {
      renameSync(from, to);
    } catch (err) {
      throw new LayoutMigrationError(
        'layout_move_failed',
        `moving alias child ${basename(from)} failed (${(err as NodeJS.ErrnoException).code ?? 'rename error'})`,
      );
    }
  }
  relocateBindingFile(legacyBinding, v2.desktop.computerBinding, logger);
  logger.info(
    { action: 'layout_v2_computer_slot_migrated', renamed: pass.renamed },
    'durable computer data moved from computers/local to the id-keyed slot',
  );
  return { renamed: pass.renamed, facts };
}

/**
 * #task:1608 workspace-data convergence — IN-PLACE catch-up for a slot
 * whose current-binding registry still uses the per-namespace slug
 * layout: derive the session cwd pairs from the registry (old = slot-era
 * slug coordinate, new = flat raw-id coordinate), rename the buckets
 * FIRST, then flatten (registry lift + dir renames). Idempotent; every
 * flatten failure is typed and blocks the marker.
 */
function runWorkspaceFlattenCatchUp(
  workspaceDataRoot: string,
  currentBinding: RegistryBinding,
  sessionDeps: { sessionStoreHome: string; env: SessionStoreEnv; logger: MigrationLogger },
  logger: MigrationLogger,
): number {
  return wrapFlatten(
    () =>
      runWorkspaceDataConvergencePass({
        workspaceDataRoot,
        currentBinding,
        sessionStoreHome: sessionDeps.sessionStoreHome,
        env: sessionDeps.env,
        logger,
      }).renamed,
  );
}

/** Map the host migration unit's typed failures into the engine's own
 *  typed error (the codes mirror 1:1 for the session side). */
function wrapFlatten<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FlattenLayoutError) {
      throw new LayoutMigrationError(
        err.code === 'flatten_unreadable'
          ? 'layout_unreadable'
          : err.code === 'flatten_move_failed'
            ? 'layout_move_failed'
            : 'layout_conflict',
        err.message,
      );
    }
    if (err instanceof SessionMigrationError) {
      throw new LayoutMigrationError(err.code, err.message);
    }
    throw err;
  }
}

function reportInertLegacyLeftovers(
  legacy: DesktopAppPaths,
  logger: MigrationLogger,
): void {
  const leftovers = [
    legacy.legacyLocalComputer.agents,
    legacy.legacyLocalComputer.workspaceData,
    legacy.legacyLocalComputer.daemonConfig,
    legacy.embeddedServer.database,
    legacy.embeddedServer.blobs,
    legacy.embeddedServer.serverConfig,
  ].filter(p => existsSync(p));
  if (leftovers.length > 0) {
    logger.warn(
      { action: 'layout_v2_inert_legacy_leftovers', count: leftovers.length },
      'legacy layout leftovers present after v2 cutover; inert (never re-adopted or deleted)',
    );
  }
}

// ── source enumeration (single classification, resolver-computed cwds) ──

/**
 * The RELEASED pre-v2 registry namespaces live directly under the run
 * root (`run/<binding-slug>/workspace-registry.json` + `workspaces/`).
 * A directory is claimed ONLY on exact structural provenance: its
 * registry file parses and `bindingSlug(file.binding)` equals the
 * directory name. Anything else under run/ (pids, sockets, runtime-pids,
 * unprovable dirs) is left in place — transient state is never migrated,
 * and an unprovable namespace is never guessed at (it surfaces later as
 * a typed daemon failure, not silent adoption).
 */
function provableRunEraNamespaces(
  legacyRunRoot: string,
  logger: MigrationLogger,
): string[] {
  const rootState = entryState(legacyRunRoot);
  if (rootState === 'absent') return [];
  if (rootState === 'unreadable') {
    throw new LayoutMigrationError('layout_unreadable', 'the legacy run root cannot be inspected');
  }
  if (rootState !== 'dir') return [];
  const out: string[] = [];
  for (const name of readdirSync(legacyRunRoot)) {
    const nsDir = join(legacyRunRoot, name);
    if (entryState(nsDir) !== 'dir') continue;
    const registryPath = join(nsDir, 'workspace-registry.json');
    const registryState = entryState(registryPath);
    // No registry file at all: a transient run/ dir (runtime-pids etc.) —
    // never a registry namespace; ignore.
    if (registryState === 'absent') continue;
    // A PRESENT registry that cannot be proven is durable state we must
    // not leave under the old authority while stamping completion (P1-3):
    // fail closed, never warn-and-continue.
    if (registryState !== 'file') {
      throw new LayoutMigrationError(
        'layout_registry_rewrite_blocked',
        `run-era registry for namespace ${name} cannot be inspected or is not a regular file`,
      );
    }
    assertRegistryBindingProvenance(registryPath, name, 'run-era');
    out.push(name);
    logger.info(
      { action: 'layout_v2_run_namespace_claimed', namespace: name },
      'run-era registry namespace claimed on exact binding provenance',
    );
  }
  return out;
}

/** The shared binding proof (P1-3): the registry file must parse and its
 *  binding slug must equal the namespace directory name — checked at
 *  claim time AND again on the staged tree, so a crash between the two
 *  can never activate an unproven registry. */
function assertRegistryBindingProvenance(
  registryPath: string,
  namespace: string,
  where: string,
): RegistryBinding {
  let binding: { server_origin?: unknown; host_id?: unknown } | undefined;
  try {
    binding = (
      JSON.parse(readFileSync(registryPath, 'utf-8')) as {
        binding?: { server_origin?: unknown; host_id?: unknown };
      }
    ).binding;
  } catch (err) {
    throw new LayoutMigrationError(
      'layout_registry_rewrite_blocked',
      `${where} registry for namespace ${namespace} cannot be parsed: ${(err as Error).message}`,
    );
  }
  if (
    typeof binding?.server_origin !== 'string' ||
    typeof binding?.host_id !== 'string' ||
    bindingSlug({ server_origin: binding.server_origin, host_id: binding.host_id }) !== namespace
  ) {
    throw new LayoutMigrationError(
      'layout_registry_rewrite_blocked',
      `${where} registry for namespace ${namespace} lacks exact binding provenance (slug mismatch)`,
    );
  }
  return {
    server_origin: binding.server_origin,
    host_id: binding.host_id,
  };
}

function localComputerEntries(
  legacy: DesktopAppPaths,
  stagingRoot: string,
  runNamespaces: readonly string[],
): FacetEntry[] {
  return [
    { legacy: legacy.legacyLocalComputer.agents, staged: join(stagingRoot, 'agents'), kind: 'dir' },
    // The binding config is desktop-owned and relocates separately to
    // desktop/computer-binding.json (#task:1608) — deliberately not a
    // facet entry. Run-era registry namespaces are the released pre-v2
    // daemon state; the unreleased #1596-era top-level workspace-data
    // intermediate gets NO reader here (Cindy ruling 2026-07-24).
    ...runNamespaces.map(ns => ({
      legacy: join(legacy.run.root, ns),
      staged: join(stagingRoot, 'workspace-data', ns),
      kind: 'dir' as const,
    })),
  ];
}

function embeddedServerEntries(
  legacy: DesktopAppPaths,
  stagingRoot: string,
): FacetEntry[] {
  return [
    { legacy: legacy.embeddedServer.database, staged: join(stagingRoot, basename(legacy.embeddedServer.database)), kind: 'file' },
    { legacy: legacy.embeddedServer.databaseWal, staged: join(stagingRoot, basename(legacy.embeddedServer.databaseWal)), kind: 'file' },
    { legacy: legacy.embeddedServer.databaseShm, staged: join(stagingRoot, basename(legacy.embeddedServer.databaseShm)), kind: 'file' },
    { legacy: legacy.embeddedServer.blobs, staged: join(stagingRoot, 'blobs'), kind: 'dir' },
    {
      legacy: legacy.embeddedServer.serverConfig,
      staged: join(stagingRoot, 'config', basename(legacy.embeddedServer.serverConfig)),
      kind: 'file',
    },
    // The embedded bootstrap token is boot-scoped and NOT adopted as
    // durable identity (§6.3): deliberately not an entry.
  ];
}

interface SessionSourceSet {
  /** Dirs whose child dir names are agent ids. */
  agentsDirs: readonly string[];
  /** Workspace-data-shaped roots: `<root>/<ns>/workspaces/<slug>`. */
  namespaceRoots: readonly string[];
  /** Run-era namespace dirs: `<nsDir>/workspaces/<slug>` (ns = basename). */
  runNamespaces?: readonly string[];
}

/** The old→new cwd coordinate translation for one migration step. Both
 *  sides are resolver/slug products — never parsed back off disk. */
interface SessionCwdMap {
  oldAgentsRoot: string;
  newAgentsRoot: string;
  oldNamespaceRoot: (ns: string) => string;
  newWorkspaceData: string;
}

/**
 * Enumerate cwd pairs from the classified authoritative source. IDs and
 * slugs come from directory listings of that source; the old and new cwd
 * are ALWAYS computed through the coordinate map, so a source that
 * already moved to staging still yields the correct pre-cutover cwd.
 */
function collectSessionCwdPairs(
  map: SessionCwdMap,
  sources: SessionSourceSet,
): SessionCwdPair[] {
  const pairs = new Map<string, SessionCwdPair>();
  const add = (oldCwd: string, newCwd: string): void => {
    if (!pairs.has(oldCwd)) pairs.set(oldCwd, { oldCwd, newCwd });
  };
  const listDirs = (root: string): string[] => {
    const state = entryState(root);
    if (state === 'absent') return [];
    if (state === 'unreadable') {
      throw new LayoutMigrationError('layout_unreadable', `session source ${basename(root)} cannot be inspected`);
    }
    if (state !== 'dir') return [];
    return readdirSync(root).filter(name => entryState(join(root, name)) === 'dir');
  };

  for (const agentsDir of sources.agentsDirs) {
    for (const agentId of listDirs(agentsDir)) {
      add(join(map.oldAgentsRoot, agentId), join(map.newAgentsRoot, agentId));
    }
  }
  const addWorkspace = (ns: string, slug: string): void => {
    add(
      join(map.oldNamespaceRoot(ns), 'workspaces', slug),
      join(map.newWorkspaceData, ns, 'workspaces', slug),
    );
  };
  for (const nsRoot of sources.namespaceRoots) {
    for (const ns of listDirs(nsRoot)) {
      for (const slug of listDirs(join(nsRoot, ns, 'workspaces'))) {
        addWorkspace(ns, slug);
      }
    }
  }
  for (const nsDir of sources.runNamespaces ?? []) {
    const ns = basename(nsDir);
    for (const slug of listDirs(join(nsDir, 'workspaces'))) {
      addWorkspace(ns, slug);
    }
  }
  return [...pairs.values()];
}

// ── shared facet engine (§6.4 state classification) ─────────────────────

interface FacetClassification {
  finalState: EntryState;
  stagingState: EntryState;
  presentLegacy: FacetEntry[];
  /** #task:1608 P0-3/R2-1 — the final root pre-exists but every child is
   *  an EXPECTED slot child (resolver-derived set) whose legacy sources
   *  are all absent: legitimate pre-existing data (released same-host
   *  proxy config, a connect daemon's own slot agents) or the product of
   *  a mid-activation crash. The facet still migrates; activation first
   *  moves these children back into staging, then performs the ONE
   *  whole-root rename. */
  finalPreexisting: boolean;
}

/**
 * Classify the facet's roots ONCE per run and enforce the authority
 * invariants. Both the session pass and the tree move consume this same
 * result — two independent judgements could otherwise disagree on which
 * side is authoritative.
 */
function classifyFacet(
  facet: string,
  stagingRoot: string,
  finalRoot: string,
  entries: readonly FacetEntry[],
  expectedFinalChildren?: readonly string[],
): FacetClassification {
  const finalState = entryState(finalRoot);
  const stagingState = entryState(stagingRoot);
  if (finalState === 'unreadable' || stagingState === 'unreadable') {
    throw new LayoutMigrationError(
      'layout_unreadable',
      `${facet}: cannot inspect the final or staging root`,
    );
  }
  if (finalState === 'special' || stagingState === 'special' || finalState === 'file') {
    throw new LayoutMigrationError(
      'layout_special_file',
      `${facet}: the final or staging root is not a real directory`,
    );
  }
  const presentLegacy = entries.filter(e => entryState(e.legacy) !== 'absent');
  // #task:1608 P0-3/R2-1 — a pre-existing final root is a legitimate
  // migration input (not a conflict) when every child is accounted for:
  // it must be in the facet's EXPECTED final-children set (derived from
  // the slot resolver by the caller) AND every legacy source mapping to
  // it must be absent. A child whose legacy source still exists is
  // foreign (true ownership ambiguity); an unknown child always is.
  const entryTopSegments = new Map<string, FacetEntry[]>();
  for (const e of entries) {
    const top = relative(stagingRoot, e.staged).split(sep)[0]!;
    const group = entryTopSegments.get(top);
    if (group) group.push(e);
    else entryTopSegments.set(top, [e]);
  }
  const accountedFinalChild = (child: string): boolean => {
    if (!expectedFinalChildren!.includes(child)) return false;
    const group = entryTopSegments.get(child) ?? [];
    return group.every(e => entryState(e.legacy) === 'absent');
  };
  const finalPreexisting =
    finalState === 'dir' &&
    expectedFinalChildren !== undefined &&
    (stagingState !== 'absent' || presentLegacy.length > 0) &&
    readdirSync(finalRoot).every(accountedFinalChild);
  // Pre-marker ambiguity is otherwise ALWAYS a conflict — never merge,
  // never pick a side. The atomic staging→final rename can produce final
  // XOR staging, so final+staging coexisting (Cindy phase-A P0-1), or
  // final+legacy coexisting, are states no normal history reaches.
  if (
    !finalPreexisting &&
    finalState === 'dir' &&
    (stagingState !== 'absent' || presentLegacy.length > 0)
  ) {
    throw new LayoutMigrationError(
      'layout_conflict',
      `${facet}: the v2 root coexists with ${stagingState !== 'absent' ? 'a staging tree' : 'legacy sources'} before a completed marker`,
    );
  }
  return { finalState, stagingState, presentLegacy, finalPreexisting };
}

function runFacet(input: {
  facet: string;
  stagingRoot: string;
  finalRoot: string;
  entries: FacetEntry[];
  classification: FacetClassification;
  logger: MigrationLogger;
  validateStaging?: () => void;
}): 'migrated' | 'noop' | 'already' {
  const { facet, stagingRoot, finalRoot, entries, classification, logger } = input;
  const { finalState, stagingState, presentLegacy, finalPreexisting } = classification;

  // Case 3: final present alone → complete. (A preexisting-allowlisted
  // final root is NOT completion — the legacy facet still migrates into
  // it below.)
  if (finalState === 'dir' && !finalPreexisting) return 'already';

  // Case 6 (§6.4-6): no legacy source at all → nothing to create. The
  // embedded facet must not conjure an empty tree on a remote install; the
  // local facet lets the daemon create fresh v2 dirs itself.
  if (presentLegacy.length === 0 && stagingState === 'absent') return 'noop';

  // Cases 1 + 2: create-or-resume staging, move remaining sources in.
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const legacyState = entryState(entry.legacy);
    const stagedState = entryState(entry.staged);
    if (legacyState === 'unreadable' || stagedState === 'unreadable') {
      throw new LayoutMigrationError('layout_unreadable', `${facet}: cannot inspect ${basename(entry.legacy)}`);
    }
    if (legacyState === 'special') {
      throw new LayoutMigrationError(
        'layout_special_file',
        `${facet}: legacy source ${basename(entry.legacy)} is a symlink or special file`,
      );
    }
    if (legacyState === 'absent') {
      // Crash-resume: the source may already be in staging. NEVER activate
      // an unvalidated staged entry (Cindy phase-A P0-2) — a
      // symlink/special/wrong-kind staged item blocks the facet.
      if (stagedState !== 'absent' && stagedState !== entry.kind) {
        throw new LayoutMigrationError(
          'layout_special_file',
          `${facet}: staged entry ${basename(entry.staged)} is not the expected ${entry.kind}`,
        );
      }
      continue;
    }
    if (stagedState !== 'absent') {
      throw new LayoutMigrationError(
        'layout_conflict',
        `${facet}: staged copy of ${basename(entry.legacy)} already exists while the legacy source is still present`,
      );
    }
    if ((entry.kind === 'dir' && legacyState !== 'dir') || (entry.kind === 'file' && legacyState !== 'file')) {
      throw new LayoutMigrationError(
        'layout_special_file',
        `${facet}: legacy source ${basename(entry.legacy)} has an unexpected type`,
      );
    }
    mkdirSync(dirname(entry.staged), { recursive: true, mode: 0o700 });
    try {
      renameSync(entry.legacy, entry.staged);
    } catch (err) {
      throw new LayoutMigrationError(
        'layout_move_failed',
        `${facet}: moving ${basename(entry.legacy)} failed (${(err as NodeJS.ErrnoException).code ?? 'rename error'}); recursive copy is never attempted`,
      );
    }
  }

  input.validateStaging?.();

  // Activate: ONE same-filesystem rename of the whole staged tree — the
  // single atomic boundary (#task:1608 R2-1). A pre-existing final root
  // (allowlisted proxy config and/or already-activated children from a
  // mid-activation crash) is first emptied INTO staging with per-child
  // idempotent renames (a staged counterpart already present is a typed
  // conflict), then removed, so the rename below stays whole-root. Every
  // intermediate crash state re-classifies as finalPreexisting and
  // converges monotonically; bytes only ever move by rename.
  mkdirSync(dirname(finalRoot), { recursive: true, mode: 0o700 });
  try {
    if (finalPreexisting) {
      for (const child of readdirSync(finalRoot)) {
        const target = join(stagingRoot, child);
        if (entryState(target) !== 'absent') {
          throw new LayoutMigrationError(
            'layout_conflict',
            `${facet}: pre-existing final child ${child} collides with its staged counterpart`,
          );
        }
        renameSync(join(finalRoot, child), target);
      }
      rmdirSync(finalRoot);
    }
    renameSync(stagingRoot, finalRoot);
  } catch (err) {
    if (err instanceof LayoutMigrationError) throw err;
    throw new LayoutMigrationError(
      'layout_move_failed',
      `${facet}: activating the staged tree failed (${(err as NodeJS.ErrnoException).code ?? 'rename error'})`,
    );
  }
  logger.info({ action: 'layout_v2_facet_migrated', facet }, 'layout facet migrated');
  return 'migrated';
}

// ── §6.1 registry path rewrite (exact provenance) ────────────────────────

/**
 * While the workspace-data tree is in STAGING, rewrite each registry
 * entry that proves the exact daemon-managed run-era shape
 * `<legacy-run-root>/<binding-slug>/workspaces/<workspace-slug>` to the
 * v2 coordinate. The binding slug must equal the registry file's
 * namespace dir; the workspace slug must be the deterministic slug for
 * that registry key. Anything else inside the legacy root is a typed
 * conflict — never broad prefix replacement (§6.1). Recovery accepts the
 * exact legacy OR exact v2 value and converges to v2 (idempotent). This is
 * the SINGLE registry rewrite contract — the daemon performs none.
 */
export function rewriteStagedRegistries(
  stagedWorkspaceData: string,
  legacyRunRoot: string,
  v2WorkspaceData: string,
  currentBinding: RegistryBinding,
  logger: MigrationLogger,
): void {
  const rootState = entryState(stagedWorkspaceData);
  if (rootState === 'absent') return;
  if (rootState !== 'dir') {
    throw new LayoutMigrationError(
      'layout_unreadable',
      'the staged workspace-data tree cannot be inspected or is not a directory',
    );
  }
  adoptCrossBindingManagedWorkspaces({
    stagedWorkspaceData,
    legacyRunRoot,
    v2WorkspaceData,
    currentBinding,
    logger,
  });
  for (const ns of readdirSync(stagedWorkspaceData)) {
    const nsDir = join(stagedWorkspaceData, ns);
    const nsState = entryState(nsDir);
    if (nsState === 'unreadable') {
      throw new LayoutMigrationError(
        'layout_unreadable',
        `staged workspace-data namespace ${ns} cannot be inspected`,
      );
    }
    if (nsState !== 'dir') continue;
    const filePath = join(nsDir, 'workspace-registry.json');
    const fileState = entryState(filePath);
    if (fileState === 'absent') continue;
    if (fileState !== 'file') {
      throw new LayoutMigrationError(
        'layout_unreadable',
        `staged registry file for namespace ${ns} cannot be inspected or is not a regular file`,
      );
    }
    // P1-3: the claim-time binding proof must hold on the STAGED tree too —
    // a crash-resumed staging dir is otherwise activated without ever
    // re-proving provenance.
    assertRegistryBindingProvenance(filePath, ns, 'staged');
    let changed = false;
    let serialized: string;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        workspaces?: Record<string, { path?: unknown }>;
      };
      for (const [workspaceId, entry] of Object.entries(parsed.workspaces ?? {})) {
        if (typeof entry?.path !== 'string') continue;
        const legacyExact = join(legacyRunRoot, ns, 'workspaces', managedWorkspaceSlug(workspaceId));
        const v2Exact = join(v2WorkspaceData, ns, 'workspaces', managedWorkspaceSlug(workspaceId));
        if (entry.path === v2Exact) continue; // crash-after-rewrite convergence
        if (entry.path === legacyExact) {
          entry.path = v2Exact;
          changed = true;
          continue;
        }
        if (pathInside(legacyRunRoot, entry.path)) {
          // Inside the legacy root but NOT the exact managed shape for
          // this key: forged/foreign — block, never prefix-rewrite.
          throw new LayoutMigrationError(
            'layout_registry_rewrite_blocked',
            `registry entry for workspace ${workspaceId} in namespace ${ns} points inside the legacy root without exact managed provenance`,
          );
        }
        // External user-requested path: byte-for-byte unchanged.
      }
      if (!changed) continue;
      serialized = `${JSON.stringify(parsed, null, 2)}\n`;
    } catch (err) {
      if (err instanceof LayoutMigrationError) throw err;
      throw new LayoutMigrationError(
        'layout_registry_rewrite_blocked',
        `cannot verify/rewrite the staged registry file for namespace ${ns}: ${(err as Error).message}`,
      );
    }
    const tmpPath = `${filePath}.migrating`;
    writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
    logger.info(
      { action: 'layout_v2_registry_rewritten', namespace: ns },
      'staged workspace registry rewritten to v2 managed coordinates',
    );
  }
}
