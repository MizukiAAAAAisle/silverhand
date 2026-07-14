import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

/**
 * Daemon-local workspace registry (D4.e-1).
 *
 * The keystone primitive that makes the daemon — not the backend — the
 * sole authority for host-local path resolution of *regular* workspaces.
 * See `docs/orchestration-boundary-v1.md §5.1` (Host-local path authority).
 *
 * Why this exists: pre-D4.e the backend computed `<workspace>/.silverhand/
 * ...` paths from the server DB column `workspaces.workspace_path` and
 * either acted on them directly or shipped them to the daemon. That
 * column is daemon-local truth, not server truth (it is exactly what
 * standalone gates off as `workspace_path_not_supported`). The registry
 * relocates that truth to the host: the backend speaks only
 * `workspace_id`, and the daemon resolves the absolute path here.
 *
 * Agent-home / DM workspaces are NOT stored here — their path derives
 * deterministically from the daemon's own `homedir()` + `agent_id` (the
 * `agent_materialize` pattern), so the registry only owns the
 * non-derivable regular-workspace mapping.
 *
 * Namespace isolation (Cindy rev2 P1): the file is bound to exactly one
 * control-plane identity `(server_origin, host_id)`, recorded in its
 * header. A registry whose recorded binding differs from the daemon's
 * current binding is **foreign** and fails closed — every op throws
 * `registry_foreign` rather than silently serving (or clobbering) another
 * backend/profile's entries. This is the on-disk realization of "a
 * `workspace_id` lookup must be scoped to the current binding".
 */

export interface RegistryBinding {
  /**
   * Standalone: `new URL(daemon-config.server_url).origin`.
   * Embedded before its live host binding: the fixed sentinel
   * `local-embedded`.
   */
  server_origin: string;
  /**
   * Standalone: `daemon-config.host_id`.
   * Embedded after claim: `daemon-config.host_id`; before claim, the daemon
   * identity's `daemon_id` (default `local`).
   */
  host_id: string;
}

export type WorkspaceRegistryErrorCode =
  | 'registry_foreign'
  | 'not_provisioned'
  | 'registry_corrupt'
  | 'path_conflict'
  | 'invalid_path';

export class WorkspaceRegistryError extends Error {
  constructor(
    readonly code: WorkspaceRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRegistryError';
  }
}

export const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_FILE_NAME = 'workspace-registry.json';
const MANAGED_WORKSPACES_DIR = 'workspaces';

/**
 * Stable, path-safe slug for a binding. Both the registry file and the
 * managed workspaces root live under `<stateDir>/<bindingSlug>/`, so two
 * different control-plane bindings on the same machine (e.g. embedded vs
 * standalone, or two standalone backends) NEVER share a registry file or
 * a managed directory (Cindy rev2 P1 guard #1). `server_origin` may
 * contain characters that are unsafe in a path component, so we hash
 * rather than embed it verbatim. The header-level foreign-guard
 * (`load()` below) stays as defense-in-depth even though collisions in a
 * 16-hex-char sha256 prefix are not a practical concern.
 */
export function bindingSlug(binding: RegistryBinding): string {
  return createHash('sha256')
    .update(`${binding.server_origin}\0${binding.host_id}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Path-safe slug for a workspace id (Cindy rev2 ① P1). The registry is
 * the daemon's path authority / security boundary, so a server-supplied
 * semantic id MUST NOT be trusted as a path component: values like
 * `../escape`, `a/b`, or `/abs` would let the managed path escape its
 * root or nest unexpectedly. We derive the on-disk directory name by
 * hashing the id rather than depending on the upstream ID character set,
 * so the managed path is structurally always exactly one component under
 * `managedRoot`. The raw id remains the registry MAP key (a JSON object
 * key — never a path), so lookups stay by id while the directory is the
 * slug. 128 bits (32 hex chars) makes collisions a non-concern.
 */
export function managedWorkspaceSlug(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 32);
}

const RegistryBindingSchema = z
  .object({
    server_origin: z.string().min(1),
    host_id: z.string().min(1),
  })
  .strict();

const RegistryEntrySchema = z
  .object({
    path: z.string().min(1),
    provisioned_at: z.number().int().positive(),
  })
  .strict();

const RegistryFileSchema = z
  .object({
    schema_version: z.literal(REGISTRY_SCHEMA_VERSION),
    binding: RegistryBindingSchema,
    workspaces: z.record(z.string().min(1), RegistryEntrySchema),
  })
  .strict();

type RegistryFile = z.infer<typeof RegistryFileSchema>;

export interface WorkspaceRegistryEntry {
  workspace_id: string;
  path: string;
  provisioned_at: number;
}

export interface ProvisionResult {
  path: string;
  /** false when the entry already existed (idempotent re-provision). */
  created: boolean;
}

export interface WorkspaceRegistryOptions {
  /**
   * Daemon state dir (= `dirname(identity.json)`, e.g.
   * `~/.silverhand/daemon`). The registry file and the managed
   * workspaces root both live under it.
   */
  stateDir: string;
  /** The daemon's current control-plane binding (see RegistryBinding). */
  binding: RegistryBinding;
  /**
   * Silverhand state root on this host (e.g. `~/.silverhand`). When set, a
   * caller-proposed `requested_path` may NOT live inside it — that subtree
   * holds L1 agent identity (`agents/**`), daemon state (`daemon/**`) and
   * the registry itself, and a workspace root is recursively purged, so a
   * requested path there could destroy Silverhand internals. The ONE
   * exception is a child of `legacyWorkspacesRoot` (below), so a pre-D4.e
   * generated workspace can still be bound. This is the daemon-canonical
   * form of the retired backend `validateWorkspacePath` rule (removed in
   * D4.e-5 — the daemon is now the sole path authority). Injected (not
   * derived via `dirname`) so production and tests are explicit. Absent →
   * guard off.
   */
  silverhandStateRoot?: string;
  /**
   * The generated-workspaces root (e.g. `~/.silverhand/workspaces`). Only
   * a CHILD of this dir is allowed inside `silverhandStateRoot`; the dir
   * itself is still rejected. Only meaningful when `silverhandStateRoot`
   * is set.
   */
  legacyWorkspacesRoot?: string;
  /**
   * Explicitly trusted predecessor bindings whose exact daemon-managed
   * `workspace_id -> path` entry may be copied into this registry.
   * This is the narrow upgrade seam for desktop's historical
   * `local-embedded` namespace; it never widens generic requested-path
   * validation and never scans arbitrary binding directories.
   */
  legacyBindings?: readonly RegistryBinding[];
  /** Injectable clock for tests. */
  now?: () => number;
}

function bindingsEqual(a: RegistryBinding, b: RegistryBinding): boolean {
  return a.server_origin === b.server_origin && a.host_id === b.host_id;
}

/**
 * Two absolute resolved paths overlap when they are equal or one is an
 * ancestor of the other (component boundary via `sep`). Used to forbid two
 * workspaces from binding nested roots — a recursive purge of the outer
 * one would delete the inner one (ownership alias). Cindy D4.e-1 P1-2.
 */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * Synchronous, single-process registry. Every public op runs a
 * read-modify-write entirely within one synchronous call so concurrent
 * dispatcher invocations on the single-threaded event loop can never
 * interleave a load with another op's save.
 */
export class WorkspaceRegistry {
  private readonly stateDir: string;
  private readonly filePath: string;
  private readonly managedRoot: string;
  private readonly binding: RegistryBinding;
  private readonly silverhandStateRoot: string | undefined;
  private readonly legacyWorkspacesRoot: string | undefined;
  private readonly legacyBindings: readonly RegistryBinding[];
  private readonly now: () => number;

  constructor(opts: WorkspaceRegistryOptions) {
    this.stateDir = opts.stateDir;
    const nsRoot = join(opts.stateDir, bindingSlug(opts.binding));
    this.filePath = join(nsRoot, REGISTRY_FILE_NAME);
    this.managedRoot = join(nsRoot, MANAGED_WORKSPACES_DIR);
    this.binding = opts.binding;
    this.silverhandStateRoot = opts.silverhandStateRoot
      ? resolve(opts.silverhandStateRoot)
      : undefined;
    this.legacyWorkspacesRoot = opts.legacyWorkspacesRoot
      ? resolve(opts.legacyWorkspacesRoot)
      : undefined;
    const seenLegacyBindings = new Set<string>();
    this.legacyBindings = (opts.legacyBindings ?? []).filter(candidate => {
      if (bindingsEqual(candidate, opts.binding)) return false;
      const key = `${candidate.server_origin}\0${candidate.host_id}`;
      if (seenLegacyBindings.has(key)) return false;
      seenLegacyBindings.add(key);
      return true;
    });
    this.now = opts.now ?? (() => Date.now());
  }

  /** Absolute path to this binding's registry file (diagnostics/tests). */
  registryFilePath(): string {
    return this.filePath;
  }

  /** Current binding, for diagnostics/tests. */
  currentBinding(): RegistryBinding {
    return this.binding;
  }

  /**
   * Resolve the absolute managed path for a regular workspace. Read
   * fail-closed: an unknown `workspace_id` under the current binding
   * throws `not_provisioned` — it never falls back to a managed-path
   * guess, so a caller can never act on a directory the daemon did not
   * record provisioning.
   */
  resolve(workspaceId: string): string {
    const file = this.loadForRead();
    const entry = file.workspaces[workspaceId];
    if (!entry) {
      throw new WorkspaceRegistryError(
        'not_provisioned',
        `workspace ${workspaceId} is not provisioned in this daemon's registry`,
      );
    }
    return entry.path;
  }

  /** Whether a regular workspace has a registry entry under the current binding. */
  has(workspaceId: string): boolean {
    const file = this.loadForRead();
    return Boolean(file.workspaces[workspaceId]);
  }

  /**
   * Bind a regular workspace and persist the mapping. Returns the
   * authoritative absolute path. Does NOT create the directory on disk —
   * that is the provision handler's job (so fs errno classifies uniformly
   * for managed and requested paths alike).
   *
   * Two path regimes, one operation (A — single intent, Cindy #720 + shiki):
   * - `requestedPath` ABSENT → daemon self-picks a deterministic managed
   *   path (`<stateDir>/<binding-slug>/workspaces/<workspace-slug>`). The
   *   slug is a hash of the id, so managed paths are 1:1 with ids and can
   *   never collide across workspaces.
   * - `requestedPath` PRESENT → the caller-proposed host path (M1 folder
   *   picker / sandbox typed path / legacy backfill). The daemon
   *   RE-VALIDATES it (`validateRequestedPath`) — it does not blindly
   *   trust the backend — then binds it verbatim.
   *
   * Conflict is the full three-state guard (Cindy):
   * - same id + (no requested path | same path) → idempotent
   *   (`created:false`); a no-path re-provision of an already-bound id
   *   returns its existing binding regardless of regime.
   * - same id + different requested path → `path_conflict` (NOT a
   *   migration — including a parent↔child move, since the path differs).
   * - different id + an OVERLAPPING requested path → `path_conflict`. Two
   *   workspaces must never bind equal OR nested roots (P1-2): a recursive
   *   purge of the outer one would delete the inner one. Cannot arise for
   *   managed paths (slug is per-id; a requested path can never be inside
   *   the managed root — `validateRequestedPath` rejects that).
   *
   * A foreign/corrupt registry throws and is NOT clobbered.
   */
  provision(workspaceId: string, requestedPath?: string): ProvisionResult {
    const file = this.loadOrInit();
    const existing = file.workspaces[workspaceId];
    if (existing) {
      if (requestedPath === undefined) {
        // No-path re-provision of an already-bound id: idempotent,
        // regardless of whether it was originally managed or requested.
        return { path: existing.path, created: false };
      }
      // Idempotent-first (D4.e-1 3b-2): re-binding an id to the SAME absolute
      // path it already holds is ALWAYS a no-op — even when that path is the
      // daemon-managed one. The backend migration backfill re-provisions
      // every regular row by its stored `workspace_path`, and a
      // managed-default row's stored path lives INSIDE the managed root,
      // which `validateRequestedPath` would otherwise reject as
      // `invalid_path`. Comparing the resolved path before structural
      // validation keeps a faithful re-bind from spuriously failing. (A
      // relative path still falls through to validation → `invalid_path`.)
      if (isAbsolute(requestedPath) && resolve(requestedPath) === existing.path) {
        return { path: existing.path, created: false };
      }
      // Different path: validate it first (so a structurally bad proposal
      // surfaces as `invalid_path`), then refuse — never silently overwrite
      // an existing binding (including a parent↔child move).
      const validated = this.validateRequestedPath(requestedPath);
      throw new WorkspaceRegistryError(
        'path_conflict',
        `workspace ${workspaceId} is already bound to ${existing.path}; refusing to overwrite with ${validated}`,
      );
    }
    if (requestedPath !== undefined) {
      const copied = this.copyLegacyEntry(file, workspaceId, requestedPath);
      if (copied) return copied;
    }

    let path: string;
    if (requestedPath === undefined) {
      path = join(this.managedRoot, managedWorkspaceSlug(workspaceId));
    } else {
      path = this.validateRequestedPath(requestedPath);
    }
    // Cross-workspace OVERLAP conflict: no two workspace ids may bind equal
    // or nested roots (P1-2). Managed paths are per-id and disjoint, so this
    // only ever fires for a requested path that collides with an existing
    // binding — but we check uniformly.
    this.assertNoOverlap(file, workspaceId, path);
    file.workspaces[workspaceId] = { path, provisioned_at: this.now() };
    this.persist(file);
    return { path, created: true };
  }

  /**
   * Copy an exact daemon-managed entry from an explicitly trusted predecessor
   * registry.
   *
   * A normal caller may never bind a requested path inside Silverhand's state
   * root. Historical desktop-managed workspaces are the one upgrade case that
   * legitimately live there: their path was allocated by an older
   * `local-embedded` registry. We accept that path only when the predecessor
   * registry itself proves the same workspace id owns its deterministic
   * managed path, and that path exactly matches the server's requested path.
   * The predecessor remains intact for rollback. This creates no general alias:
   * only the same workspace id and exact daemon-recorded path may be copied,
   * and the daemon process still activates only one binding at a time.
   */
  private copyLegacyEntry(
    destination: RegistryFile,
    workspaceId: string,
    requestedPath: string,
  ): ProvisionResult | null {
    if (this.legacyBindings.length === 0 || !isAbsolute(requestedPath)) {
      return null;
    }
    const resolvedRequestedPath = resolve(requestedPath);
    const sources: Array<{
      entry: RegistryFile['workspaces'][string];
    }> = [];

    for (const binding of this.legacyBindings) {
      const registry = new WorkspaceRegistry({
        stateDir: this.stateDir,
        binding,
        ...(this.silverhandStateRoot
          ? { silverhandStateRoot: this.silverhandStateRoot }
          : {}),
        ...(this.legacyWorkspacesRoot
          ? { legacyWorkspacesRoot: this.legacyWorkspacesRoot }
          : {}),
        now: this.now,
      });
      const source = registry.load();
      const entry = source?.workspaces[workspaceId];
      if (!entry) continue;
      const sourceManagedPath = join(
        registry.managedRoot,
        managedWorkspaceSlug(workspaceId),
      );
      // A predecessor's user-requested path still goes through today's normal
      // validation. Only the deterministic path minted inside the predecessor's
      // own managed root needs this state-root migration seam.
      if (entry.path !== sourceManagedPath) continue;
      if (!isAbsolute(entry.path) || resolve(entry.path) !== resolvedRequestedPath) {
        throw new WorkspaceRegistryError(
          'path_conflict',
          `legacy registry binds workspace ${workspaceId} to ${entry.path}; ` +
            `refusing requested path ${resolvedRequestedPath}`,
        );
      }
      sources.push({ entry });
    }

    if (sources.length === 0) return null;

    this.assertNoOverlap(destination, workspaceId, resolvedRequestedPath);
    destination.workspaces[workspaceId] = {
      path: resolvedRequestedPath,
      provisioned_at: Math.min(...sources.map(source => source.entry.provisioned_at)),
    };
    this.persist(destination);
    return { path: resolvedRequestedPath, created: false };
  }

  /**
   * Remove a workspace's registry entry IFF it currently maps to
   * `expectedPath`. Returns whether an entry was removed. Used by the
   * provision handler to COMPENSATE a half-done bind: if skeleton creation
   * fails after the registry already persisted the mapping, the entry is
   * rolled back so the id is not stuck pointing at an unusable path
   * (Cindy P1-1). The `expectedPath` guard makes this a no-op if a
   * concurrent op already rebound the id, so we never delete someone
   * else's binding. Foreign/corrupt registry still fails closed.
   */
  remove(workspaceId: string, expectedPath: string): boolean {
    const file = this.loadOrInit();
    const existing = file.workspaces[workspaceId];
    if (!existing || existing.path !== expectedPath) {
      return false;
    }
    delete file.workspaces[workspaceId];
    this.persist(file);
    return true;
  }

  /** Throw `path_conflict` if `path` overlaps any OTHER workspace's root. */
  private assertNoOverlap(
    file: RegistryFile,
    workspaceId: string,
    path: string,
  ): void {
    for (const [otherId, entry] of Object.entries(file.workspaces)) {
      if (otherId === workspaceId) continue;
      if (pathsOverlap(entry.path, path)) {
        throw new WorkspaceRegistryError(
          'path_conflict',
          `path ${path} overlaps workspace ${otherId} bound at ${entry.path}; ` +
            `two workspaces cannot share or nest roots`,
        );
      }
    }
  }

  /**
   * Daemon-side validation of a caller-PROPOSED workspace root. The
   * registry is the daemon's path-authority / security boundary, so a
   * backend-supplied path is never trusted: every workspace op (skeleton
   * create, seed, future purge — all RECURSIVE) operates under this root,
   * so the guards bound the destructive blast radius and protect the
   * managed namespace. Rejected (→ `invalid_path`):
   * - empty / relative — non-deterministic (depends on daemon cwd);
   * - the filesystem root `/` — a workspace purge would target the disk;
   * - the home dir — holds the agent's L1 identity (`~/.silverhand/...`)
   *   and the user's whole tree; binding/deleting there is catastrophic
   *   and conflates L1 with L2;
   * - inside the daemon-managed root — that namespace is the daemon's
   *   exclusive per-id allocation space; a requested path there could
   *   alias/shadow another workspace's managed slug.
   * Creatability/writability is NOT probed here (keeps the registry pure):
   * it is enforced when the handler creates the skeleton, where the fs
   * errno classifies as `fs_unavailable` / `fs_quota_exceeded`.
   */
  private validateRequestedPath(requestedPath: string): string {
    if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
      throw new WorkspaceRegistryError('invalid_path', 'requested path is empty');
    }
    if (!isAbsolute(requestedPath)) {
      throw new WorkspaceRegistryError(
        'invalid_path',
        'requested path must be absolute',
      );
    }
    const resolved = resolve(requestedPath);
    if (resolved === '/' || resolved === sep) {
      throw new WorkspaceRegistryError(
        'invalid_path',
        'requested path cannot be the filesystem root',
      );
    }
    if (resolved === resolve(homedir())) {
      throw new WorkspaceRegistryError(
        'invalid_path',
        'requested path cannot be the home directory',
      );
    }
    const managedRootResolved = resolve(this.managedRoot);
    if (
      resolved === managedRootResolved ||
      resolved.startsWith(managedRootResolved + sep)
    ) {
      throw new WorkspaceRegistryError(
        'invalid_path',
        'requested path cannot live inside the daemon-managed workspaces root',
      );
    }
    // State-root guard (Cindy P1-3; the daemon-canonical form of the retired
    // backend `validateWorkspacePath` rule, removed in D4.e-5):
    // the silverhand state subtree holds L1 agent identity (`agents/**`),
    // daemon state (`daemon/**`) and the registry itself; a workspace root
    // is recursively purged, so a requested path there could destroy
    // Silverhand internals. The ONE exception is a CHILD of
    // `legacyWorkspacesRoot` (so a pre-D4.e generated workspace can still be
    // bound) — the dir itself is still rejected.
    if (this.silverhandStateRoot) {
      const insideStateRoot =
        resolved === this.silverhandStateRoot ||
        resolved.startsWith(this.silverhandStateRoot + sep);
      const insideLegacyChild =
        this.legacyWorkspacesRoot !== undefined &&
        resolved.startsWith(this.legacyWorkspacesRoot + sep);
      if (insideStateRoot && !insideLegacyChild) {
        throw new WorkspaceRegistryError(
          'invalid_path',
          'requested path cannot live inside the silverhand state dir (except under workspaces/)',
        );
      }
    }
    return resolved;
  }

  /** List all provisioned regular workspaces under the current binding. */
  list(): WorkspaceRegistryEntry[] {
    const file = this.loadForRead();
    return Object.entries(file.workspaces).map(([workspace_id, entry]) => ({
      workspace_id,
      path: entry.path,
      provisioned_at: entry.provisioned_at,
    }));
  }

  // ── internals ──────────────────────────────────────────────────────

  /**
   * Load for a read-only op. Absent file → an empty in-memory view bound
   * to the current identity (no entries; nothing to read). Foreign or
   * corrupt → throw.
   */
  private loadForRead(): RegistryFile {
    return this.load() ?? {
      schema_version: REGISTRY_SCHEMA_VERSION,
      binding: this.binding,
      workspaces: {},
    };
  }

  /**
   * Load for a write op. Absent → fresh file bound to the current
   * identity (will be persisted by the caller). Foreign or corrupt →
   * throw (never clobber a foreign registry).
   */
  private loadOrInit(): RegistryFile {
    return this.load() ?? {
      schema_version: REGISTRY_SCHEMA_VERSION,
      binding: this.binding,
      workspaces: {},
    };
  }

  /**
   * Read + validate the registry file. Returns null when the file does
   * not exist. Throws `registry_corrupt` on unreadable/invalid content,
   * `registry_foreign` when the recorded binding is not the daemon's
   * current binding.
   */
  private load(): RegistryFile | null {
    let raw: string;
    try {
      if (!statSync(this.filePath).isFile()) {
        throw new WorkspaceRegistryError(
          'registry_corrupt',
          `registry path ${this.filePath} is not a file`,
        );
      }
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      if (err instanceof WorkspaceRegistryError) {
        throw err;
      }
      throw new WorkspaceRegistryError(
        'registry_corrupt',
        `failed to read registry: ${(err as Error).message}`,
      );
    }

    let parsed: RegistryFile;
    try {
      parsed = RegistryFileSchema.parse(JSON.parse(raw));
    } catch (err) {
      throw new WorkspaceRegistryError(
        'registry_corrupt',
        `registry file is malformed: ${(err as Error).message}`,
      );
    }

    if (!bindingsEqual(parsed.binding, this.binding)) {
      throw new WorkspaceRegistryError(
        'registry_foreign',
        `registry is bound to ${parsed.binding.server_origin}/${parsed.binding.host_id}, ` +
          `not the current ${this.binding.server_origin}/${this.binding.host_id}`,
      );
    }
    return parsed;
  }

  /** Atomically persist the file (temp + rename), mode 0600. */
  private persist(file: RegistryFile): void {
    mkdirSync(this.managedRoot, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort tmp cleanup
      }
      throw err;
    }
  }
}
