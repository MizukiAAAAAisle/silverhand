import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  assertSafeWorkspaceIdSegment,
  bindingSlug,
  findCaseFoldCollision,
  managedWorkspaceSlug,
  parseWorkspaceRegistryFileStrict,
  type RegistryBinding,
  type WorkspaceRegistryFile,
} from './registry.js';

/**
 * #task:1608 workspace-data convergence — ONE-TIME flatten of the current
 * binding's per-namespace registry layout
 * (`<workspace-data>/<binding-slug>/{workspace-registry.json,
 * workspaces/<workspace-hash>}`) to the final flat shape
 * (`<workspace-data>/workspace-registry.json` +
 * `workspaces/<workspace_id>`).
 *
 * Authority discipline (Cindy R4 P0-1): the migration receives the FULL
 * candidate `RegistryBinding`s (never a bare host id), computes each
 * candidate's ONE expected legacy namespace coordinate
 * (`<root>/<bindingSlug(candidate)>`), and strictly verifies the
 * registry header there equals the candidate byte-for-byte. No other
 * directory under workspace-data is ever read: a malformed orphan can
 * neither block nor join the migration, and a same-host/different-origin
 * namespace is never adopted.
 *
 * Validation discipline (Cindy R4 P0-2): there is exactly ONE strict
 * plan. It reuses the runtime registry schema (schema_version, full
 * binding, every entry shape), then checks case-fold uniqueness, managed
 * raw-id path safety, and every source/flat directory state — BEFORE the
 * caller may rename a single session bucket or write any flat bytes. The
 * execute step consumes that same validated plan; a malformed file is
 * never "repaired" into an empty or partial registry.
 *
 * Crash discipline: the FLAT registry is written first (atomic
 * tmp+rename) as the single resume authority; per-entry directory
 * renames are individually atomic and idempotent; the source namespace's
 * registry file is unlinked only after every entry settled. Every
 * filesystem failure inside this unit maps to a typed
 * `FlattenLayoutError` (Cindy R4 P1-3). Migration inventory — retires
 * with the required-upgrade floor once no pre-flatten population exists.
 */

export class FlattenLayoutError extends Error {
  constructor(
    readonly code:
      | 'flatten_ambiguous'
      | 'flatten_conflict'
      | 'flatten_unreadable'
      | 'flatten_invalid_id'
      | 'flatten_move_failed',
    message: string,
  ) {
    super(message);
    this.name = 'FlattenLayoutError';
  }
}

const REGISTRY_FILE_NAME = 'workspace-registry.json';
const MANAGED_WORKSPACES_DIR = 'workspaces';

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

/** Wrap a filesystem MUTATION so no raw errno escapes the typed boundary. */
function moveClosed<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new FlattenLayoutError(
      'flatten_move_failed',
      `${what} failed (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
}

function readRegistryStrict(path: string): WorkspaceRegistryFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new FlattenLayoutError(
      'flatten_unreadable',
      `registry file ${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'fs error'})`,
    );
  }
  return parseWorkspaceRegistryFileStrict(
    raw,
    m => new FlattenLayoutError('flatten_unreadable', `${path}: ${m}`),
  );
}

function bindingsEqual(a: RegistryBinding, b: RegistryBinding): boolean {
  return a.server_origin === b.server_origin && a.host_id === b.host_id;
}

/** A managed workspace whose directory moves. The caller derives session
 *  cwd pairs from these using ITS old-coordinate map, so the plan stays
 *  context-free. */
export interface FlattenedManagedEntry {
  workspaceId: string;
  /** The legacy on-disk dir name (`managedWorkspaceSlug(id)`). */
  legacySlugName: string;
  /** The source namespace dir name (`bindingSlug(binding)`). */
  namespaceName: string;
}

export interface ConvergencePlan {
  status: 'convert' | 'resume' | 'already_flat' | 'no_namespace';
  /** The proven authority binding ('convert'/'resume'). */
  binding: RegistryBinding | null;
  /** Source namespace dir name when it still exists on disk. */
  namespaceName: string | null;
  /** The validated FLAT registry content to write ('convert') or the one
   *  already on disk ('resume'). */
  flatFile: WorkspaceRegistryFile | null;
  /** Managed entries whose directory moves — fully validated. */
  managed: FlattenedManagedEntry[];
}

/**
 * The ONE strict plan/classification. Performs EVERY check up front and
 * throws typed errors; a returned plan means session renames and the
 * flat write are safe to start. No bytes are modified here.
 */
export function planWorkspaceDataConvergence(opts: {
  workspaceDataRoot: string;
  candidateBindings: readonly RegistryBinding[];
}): ConvergencePlan {
  const root = opts.workspaceDataRoot;
  const rootState = entryState(root);
  if (rootState === 'absent') {
    return { status: 'no_namespace', binding: null, namespaceName: null, flatFile: null, managed: [] };
  }
  if (rootState === 'unreadable' || rootState !== 'dir') {
    throw new FlattenLayoutError(
      rootState === 'unreadable' ? 'flatten_unreadable' : 'flatten_conflict',
      'workspace-data root cannot be inspected or is not a directory',
    );
  }

  const flatRegistryPath = join(root, REGISTRY_FILE_NAME);
  const flatState = entryState(flatRegistryPath);
  if (flatState === 'unreadable') {
    throw new FlattenLayoutError('flatten_unreadable', 'flat registry cannot be inspected');
  }
  if (flatState === 'dir' || flatState === 'special') {
    throw new FlattenLayoutError('flatten_conflict', 'flat registry path is not a regular file');
  }

  // Deduplicate candidates by their slug (the coordinate identity).
  const candidates = new Map<string, RegistryBinding>();
  for (const candidate of opts.candidateBindings) {
    candidates.set(bindingSlug(candidate), candidate);
  }

  // The candidates' EXPECTED coordinates are the only directories read.
  const sources: Array<{ name: string; binding: RegistryBinding; file: WorkspaceRegistryFile }> = [];
  for (const [slug, binding] of candidates) {
    const nsDir = join(root, slug);
    const nsState = entryState(nsDir);
    if (nsState === 'absent') continue;
    if (nsState === 'unreadable') {
      throw new FlattenLayoutError('flatten_unreadable', `namespace ${slug} cannot be inspected`);
    }
    if (nsState !== 'dir') {
      throw new FlattenLayoutError('flatten_conflict', `namespace ${slug} is not a directory`);
    }
    const registryPath = join(nsDir, REGISTRY_FILE_NAME);
    const registryState = entryState(registryPath);
    if (registryState === 'absent') continue; // residue dir without a registry: not claimable
    if (registryState !== 'file') {
      throw new FlattenLayoutError(
        'flatten_unreadable',
        `namespace ${slug} registry cannot be inspected or is not a regular file`,
      );
    }
    const file = readRegistryStrict(registryPath);
    // Strict provenance: dirname AND full header must both prove the
    // candidate. A forged header under the expected dirname (or vice
    // versa) is a conflict, never adopted.
    if (!bindingsEqual(file.binding, binding)) {
      throw new FlattenLayoutError(
        'flatten_conflict',
        `namespace ${slug} header (${file.binding.server_origin}/${file.binding.host_id}) does not match its coordinate's binding`,
      );
    }
    sources.push({ name: slug, binding, file });
  }
  if (sources.length > 1) {
    throw new FlattenLayoutError(
      'flatten_ambiguous',
      `multiple candidate namespaces exist (${sources.map(s => s.name).join(', ')}); refusing to pick one`,
    );
  }
  const source = sources[0] ?? null;

  if (flatState === 'file') {
    // Resume (or already done): the flat registry is the plan authority
    // and must itself pass the strict parse AND prove a candidate binding.
    const flat = readRegistryStrict(flatRegistryPath);
    const candidate = [...candidates.values()].find(c => bindingsEqual(flat.binding, c));
    if (candidate === undefined) {
      throw new FlattenLayoutError(
        'flatten_conflict',
        'flat workspace registry does not belong to any candidate binding; refusing to touch it',
      );
    }
    assertPlanEntryInvariants(root, flat, source?.name ?? null);
    const managed = managedEntriesOf(root, flat, source?.name ?? null);
    return {
      status: source !== null ? 'resume' : 'already_flat',
      binding: candidate,
      namespaceName: source?.name ?? null,
      flatFile: flat,
      managed,
    };
  }

  if (source === null) {
    return { status: 'no_namespace', binding: null, namespaceName: null, flatFile: null, managed: [] };
  }

  // Fresh convert: build the validated flat registry content (the shared
  // invariants below cover case-fold uniqueness over these same ids).
  const workspaces: WorkspaceRegistryFile['workspaces'] = {};
  for (const [id, entry] of Object.entries(source.file.workspaces)) {
    const legacyManaged = join(root, source.name, MANAGED_WORKSPACES_DIR, managedWorkspaceSlug(id));
    if (entry.path === legacyManaged) {
      let safeId: string;
      try {
        safeId = assertSafeWorkspaceIdSegment(id);
      } catch (err) {
        throw new FlattenLayoutError(
          'flatten_invalid_id',
          `managed workspace id cannot become a path segment: ${(err as Error).message}`,
        );
      }
      workspaces[id] = {
        path: join(root, MANAGED_WORKSPACES_DIR, safeId),
        provisioned_at: entry.provisioned_at,
      };
    } else {
      workspaces[id] = { path: entry.path, provisioned_at: entry.provisioned_at };
    }
  }
  const flatFile: WorkspaceRegistryFile = {
    schema_version: source.file.schema_version,
    binding: source.binding,
    workspaces,
  };
  assertPlanEntryInvariants(root, flatFile, source.name);
  return {
    status: 'convert',
    binding: source.binding,
    namespaceName: source.name,
    flatFile,
    managed: managedEntriesOf(root, flatFile, source.name),
  };
}

/** Validate the invariants EVERY WorkspaceRegistryFile must satisfy —
 *  shared verbatim by the fresh-convert and the flat-resume arms so a
 *  failure surfaces BEFORE any session rename or flat write: case-fold id
 *  uniqueness (Cindy R5 P1-1), the managed root's own state (R5 P1-2 —
 *  the final layout includes `workspaces/`, so a file/symlink there is a
 *  conflict even for external-only registries), and every managed entry's
 *  raw-id safety and directory states. */
function assertPlanEntryInvariants(
  root: string,
  flat: WorkspaceRegistryFile,
  namespaceName: string | null,
): void {
  const collision = findCaseFoldCollision(Object.keys(flat.workspaces));
  if (collision !== null) {
    throw new FlattenLayoutError(
      'flatten_conflict',
      `workspace ids ${collision.a} and ${collision.b} collide case-insensitively`,
    );
  }
  const managedRootState = entryState(join(root, MANAGED_WORKSPACES_DIR));
  if (managedRootState === 'unreadable') {
    throw new FlattenLayoutError('flatten_unreadable', 'the workspaces/ root cannot be inspected');
  }
  if (managedRootState === 'file' || managedRootState === 'special') {
    throw new FlattenLayoutError(
      'flatten_conflict',
      'the workspaces/ root is occupied by a non-directory',
    );
  }
  for (const [id, entry] of Object.entries(flat.workspaces)) {
    const finalDir = join(root, MANAGED_WORKSPACES_DIR, id);
    if (entry.path !== finalDir) continue; // external path — no bytes move
    try {
      assertSafeWorkspaceIdSegment(id);
    } catch (err) {
      throw new FlattenLayoutError(
        'flatten_invalid_id',
        `managed workspace id cannot become a path segment: ${(err as Error).message}`,
      );
    }
    const finalState = entryState(finalDir);
    if (finalState === 'unreadable') {
      throw new FlattenLayoutError('flatten_unreadable', `flat dir for workspace ${id} cannot be inspected`);
    }
    if (finalState === 'file' || finalState === 'special') {
      throw new FlattenLayoutError(
        'flatten_conflict',
        `flat coordinate for workspace ${id} is occupied by a non-directory`,
      );
    }
    if (namespaceName === null) continue;
    const sourceDir = join(root, namespaceName, MANAGED_WORKSPACES_DIR, managedWorkspaceSlug(id));
    const sourceState = entryState(sourceDir);
    if (sourceState === 'unreadable') {
      throw new FlattenLayoutError('flatten_unreadable', `legacy dir for workspace ${id} cannot be inspected`);
    }
    if (sourceState === 'file' || sourceState === 'special') {
      throw new FlattenLayoutError('flatten_conflict', `legacy dir for workspace ${id} is not a directory`);
    }
    if (sourceState === 'dir' && finalState === 'dir') {
      throw new FlattenLayoutError(
        'flatten_conflict',
        `workspace ${id} exists at BOTH the legacy and the flat coordinate; refusing to merge`,
      );
    }
  }
}

function managedEntriesOf(
  root: string,
  flat: WorkspaceRegistryFile,
  namespaceName: string | null,
): FlattenedManagedEntry[] {
  if (namespaceName === null) return [];
  const managed: FlattenedManagedEntry[] = [];
  for (const [id, entry] of Object.entries(flat.workspaces)) {
    if (entry.path !== join(root, MANAGED_WORKSPACES_DIR, id)) continue;
    managed.push({
      workspaceId: id,
      legacySlugName: managedWorkspaceSlug(id),
      namespaceName,
    });
  }
  return managed;
}

export interface FlattenOutcome {
  status: 'flattened' | 'already_flat' | 'no_namespace';
  managed: FlattenedManagedEntry[];
}

/**
 * Execute a validated plan: write the flat registry FIRST (atomic — the
 * single resume authority), settle the per-entry renames, then retire the
 * source registry file. Consumes the plan; performs no re-parsing.
 */
export function executeWorkspaceDataConvergence(
  plan: ConvergencePlan,
  opts: {
    workspaceDataRoot: string;
    logger?: { info(fields: Record<string, unknown>, msg: string): void };
  },
): FlattenOutcome {
  const root = opts.workspaceDataRoot;
  if (plan.status === 'no_namespace' || plan.status === 'already_flat') {
    return { status: plan.status === 'already_flat' ? 'already_flat' : 'no_namespace', managed: [] };
  }
  const flatRegistryPath = join(root, REGISTRY_FILE_NAME);
  if (plan.status === 'convert') {
    const tmp = `${flatRegistryPath}.tmp-${process.pid}`;
    moveClosed('writing the flat registry', () => {
      writeFileSync(tmp, `${JSON.stringify(plan.flatFile, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, flatRegistryPath);
    });
  }
  settleEntries(root, plan);
  if (plan.namespaceName !== null) {
    moveClosed('retiring the source registry file', () =>
      unlinkSync(join(root, plan.namespaceName!, REGISTRY_FILE_NAME)),
    );
    cleanupEmptyNamespaceDirs(root, plan.namespaceName);
  }
  opts.logger?.info(
    {
      action: 'workspace_data_flattened',
      namespace: plan.namespaceName,
      managed: plan.managed.length,
      resumed: plan.status === 'resume',
    },
    'workspace-data flattened to the raw-id layout',
  );
  return { status: 'flattened', managed: plan.managed };
}

/** Per-entry idempotent directory renames driven by the validated plan.
 *  States were verified at plan time; the re-checks here keep each rename
 *  individually safe on crash-resume without widening the plan. */
function settleEntries(root: string, plan: ConvergencePlan): void {
  moveClosed('creating the flat workspaces dir', () =>
    mkdirSync(join(root, MANAGED_WORKSPACES_DIR), { recursive: true, mode: 0o700 }),
  );
  for (const entry of plan.managed) {
    const finalDir = join(root, MANAGED_WORKSPACES_DIR, entry.workspaceId);
    const sourceDir = join(root, entry.namespaceName, MANAGED_WORKSPACES_DIR, entry.legacySlugName);
    const sourceState = entryState(sourceDir);
    const finalState = entryState(finalDir);
    if (sourceState === 'unreadable' || finalState === 'unreadable') {
      throw new FlattenLayoutError(
        'flatten_unreadable',
        `workspace ${entry.workspaceId} dirs cannot be inspected`,
      );
    }
    if (finalState === 'dir') {
      if (sourceState !== 'absent') {
        throw new FlattenLayoutError(
          'flatten_conflict',
          `workspace ${entry.workspaceId} exists at BOTH the legacy and the flat coordinate; refusing to merge`,
        );
      }
      continue; // already settled
    }
    if (finalState !== 'absent') {
      throw new FlattenLayoutError(
        'flatten_conflict',
        `flat coordinate for workspace ${entry.workspaceId} is occupied by a non-directory`,
      );
    }
    if (sourceState === 'absent') continue; // never materialized — daemon surfaces it on use
    if (sourceState !== 'dir') {
      throw new FlattenLayoutError(
        'flatten_conflict',
        `legacy dir for workspace ${entry.workspaceId} is not a directory`,
      );
    }
    moveClosed(`moving workspace ${entry.workspaceId} to its flat coordinate`, () =>
      renameSync(sourceDir, finalDir),
    );
  }
}

/** Best-effort removal of the emptied source namespace dirs; leftovers
 *  (unreferenced residue) stay in place as inert orphan bytes. */
function cleanupEmptyNamespaceDirs(root: string, namespaceName: string): void {
  for (const dir of [
    join(root, namespaceName, MANAGED_WORKSPACES_DIR),
    join(root, namespaceName),
  ]) {
    try {
      rmdirSync(dir);
    } catch {
      // not empty or already gone — leave residue in place
    }
  }
}
