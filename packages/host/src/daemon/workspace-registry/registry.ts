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
 * Stable, path-safe slug for a binding. HISTORICAL COORDINATE ONLY
 * (#task:1608 workspace-data convergence): the live registry no longer
 * nests under `<stateDir>/<bindingSlug>/` — the slot's `computers/
 * <computer_id>` directory IS the enrollment boundary, and the binding
 * stays in the registry file header as the foreign guard. This function
 * remains ONLY so the one-time layout migration can name the exact
 * legacy namespace coordinates (#task:1612 deleted the other consumer,
 * the #1529 stale-path alias); nothing mints new paths from it, and it
 * goes when the migration unit does.
 */
export function bindingSlug(binding: RegistryBinding): string {
  return createHash('sha256')
    .update(`${binding.server_origin}\0${binding.host_id}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * HISTORICAL COORDINATE ONLY (#task:1608 workspace-data convergence): the
 * legacy on-disk directory name for a managed workspace
 * (`sha256(workspace_id)` prefix). New managed paths use the RAW
 * workspace id validated by `assertSafeWorkspaceIdSegment` — the id
 * generator is filesystem-safe base64url, and validating beats hashing
 * into an unreadable name. Kept ONLY for the one-time migration's
 * legacy-side coordinates (#task:1612 deleted the alias consumer); it
 * goes when the migration unit does.
 */
export function managedWorkspaceSlug(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 32);
}

/**
 * #task:1608 — the registry is the daemon's path authority / security
 * boundary, so a server-supplied semantic id may become a path component
 * ONLY after structural validation: fs-safe charset (no separators, no
 * dots — `.`/`..` traversal is impossible by construction), non-empty,
 * bounded length. Anything else fails closed as `invalid_path`; we never
 * "repair" an id by hashing, because an unverifiable id is a contract
 * violation, not an encoding problem.
 */
const SAFE_WORKSPACE_ID_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export function assertSafeWorkspaceIdSegment(workspaceId: string): string {
  if (!SAFE_WORKSPACE_ID_SEGMENT.test(workspaceId)) {
    throw new WorkspaceRegistryError(
      'invalid_path',
      `workspace id ${JSON.stringify(workspaceId)} is not a safe path segment`,
    );
  }
  return workspaceId;
}

/**
 * #task:1608 (Cindy R3-4) — raw ids are case-sensitive but the default
 * APFS volume is not, so two ids differing only by case would land in the
 * SAME managed directory. Uniqueness is therefore enforced case-folded:
 * a registry whose ids collide under folding is corrupt, and a provision
 * that would create such a collision fails closed.
 */
export function workspaceIdCaseFoldKey(workspaceId: string): string {
  return workspaceId.toLowerCase();
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

/** #task:1608 (Cindy R4 P0-2) — the ONE strict registry-file parse, shared
 *  by the runtime load() and the migration plan so there is exactly one
 *  schema authority. Throws the caller-supplied error on ANY deviation —
 *  a malformed file is never "repaired" into an empty/partial registry. */
export type WorkspaceRegistryFile = RegistryFile;
export function parseWorkspaceRegistryFileStrict(
  raw: string,
  fail: (message: string) => Error,
): WorkspaceRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(`registry file is not valid JSON: ${(err as Error).message}`);
  }
  const result = RegistryFileSchema.safeParse(parsed);
  if (!result.success) {
    throw fail(
      `registry file does not match the schema: ${result.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  return result.data;
}

/** #task:1608 (Cindy R3-4) — case-folded id uniqueness over a full id set;
 *  returns the first colliding pair or null. Shared by load, provision,
 *  and the migration plan. */
export function findCaseFoldCollision(
  ids: readonly string[],
): { a: string; b: string } | null {
  const folded = new Map<string, string>();
  for (const id of ids) {
    const key = workspaceIdCaseFoldKey(id);
    const prior = folded.get(key);
    if (prior !== undefined && prior !== id) return { a: prior, b: id };
    folded.set(key, id);
  }
  return null;
}

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
   * #task:1596 round 3/4 (Cindy P1-3) — roots whose subtree, exact path, or
   * ANCESTORS a requested workspace path may never occupy (bidirectional
   * overlap): binding a workspace over these would let a later recursive
   * workspace purge destroy Silverhand durable state. Production passes
   * the computer's workspace-data root, the agent L1 root, AND the global
   * silverhand root (each needs its own ancestor guard — a custom data
   * root may live on a disjoint volume from the global root). The only
   * carve-out: a sanctioned `legacyWorkspacesRoot` child strictly INSIDE
   * the global root (matched via `silverhandStateRoot`); the exemption
   * never applies to ancestors nor to the workspace-data / agents roots.
   */
  protectedRoots?: readonly string[];
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
  private readonly filePath: string;
  private readonly managedRoot: string;
  private readonly binding: RegistryBinding;
  private readonly silverhandStateRoot: string | undefined;
  private readonly legacyWorkspacesRoot: string | undefined;
  private readonly protectedRoots: readonly string[];
  private readonly now: () => number;

  constructor(opts: WorkspaceRegistryOptions) {
    // #task:1608 workspace-data convergence: the registry and the managed
    // workspaces root sit DIRECTLY on the workspace-data root — the
    // computers/<computer_id> slot is the enrollment boundary, so the
    // historical per-binding nesting (`<stateDir>/<bindingSlug>/`) is
    // gone. The binding stays in the file header as the foreign guard.
    this.filePath = join(opts.stateDir, REGISTRY_FILE_NAME);
    this.managedRoot = join(opts.stateDir, MANAGED_WORKSPACES_DIR);
    this.binding = opts.binding;
    this.silverhandStateRoot = opts.silverhandStateRoot
      ? resolve(opts.silverhandStateRoot)
      : undefined;
    this.legacyWorkspacesRoot = opts.legacyWorkspacesRoot
      ? resolve(opts.legacyWorkspacesRoot)
      : undefined;
    this.protectedRoots = (opts.protectedRoots ?? []).map(dir => resolve(dir));
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
   *   path (`<stateDir>/workspaces/<workspace_id>` — the RAW id after
   *   `assertSafeWorkspaceIdSegment` structural validation, #task:1608).
   *   Ids are unique per registry and case-fold-guarded, so managed paths
   *   are 1:1 with ids and can never collide across workspaces.
   * - `requestedPath` PRESENT → the caller-proposed host path (M1 folder
   *   picker / sandbox typed path). The daemon
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
   *   managed paths (the dir name is the unique id; a requested path can
   *   never be inside the managed root — `validateRequestedPath` rejects
   *   that).
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
      // daemon-managed one, which `validateRequestedPath` would otherwise
      // reject as `invalid_path`. Comparing the resolved path before
      // structural validation keeps a faithful re-bind from spuriously
      // failing. (A relative path still falls through to validation →
      // `invalid_path`.)
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

    let path: string;
    if (requestedPath === undefined) {
      // #task:1608 — the managed dir IS the validated raw workspace id
      // (fail closed on an unsafe id), directly under the workspace-data
      // root's workspaces/ dir.
      path = join(this.managedRoot, assertSafeWorkspaceIdSegment(workspaceId));
    } else {
      path = this.validateRequestedPath(requestedPath);
    }
    // #task:1608 (Cindy R3-4) — case-folded id uniqueness: on the default
    // case-insensitive APFS volume, ids differing only by case would land
    // in the same managed directory. A NEW id colliding case-folded with
    // an existing DIFFERENT id fails closed.
    const foldedNew = workspaceIdCaseFoldKey(workspaceId);
    for (const otherId of Object.keys(file.workspaces)) {
      if (otherId !== workspaceId && workspaceIdCaseFoldKey(otherId) === foldedNew) {
        throw new WorkspaceRegistryError(
          'path_conflict',
          `workspace id ${workspaceId} collides case-insensitively with existing workspace ${otherId}`,
        );
      }
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

  /**
   * #task:1719 — remove workspace registry entries BY ID, deliberately and
   * unconditionally, as ONE batch: one load, one removed/absent partition,
   * ONE atomic persist. When nothing was removed (`removed` empty) the file
   * is NOT rewritten at all — an absent-only call is a pure read. Duplicate
   * input ids are reported once. This is the server-driven teardown
   * primitive: when the backend deletes a workspace row (or reconciles a
   * ready generation), it dispatches `workspace_unbind` so the mapping stops
   * participating in path-overlap validation as a ghost.
   *
   * NOT the same operation as `remove(workspaceId, expectedPath)` above:
   * `remove` is provision-COMPENSATION with a path guard (roll back a
   * half-done bind only if the mapping still points where we put it);
   * `unbindMany` is a deliberate by-id removal ordered by the control
   * plane — no path guard, because the server's delete of the workspace row
   * is the authority, whatever local path the id ended up bound to.
   *
   * Mapping removal ONLY: never touches the workspace directory or any file
   * contents (zero implicit deletion of user data, #1594). Foreign/corrupt
   * registry still fails the whole call closed (`WorkspaceRegistryError`
   * propagates) — never a partial mutation.
   */
  unbindMany(workspaceIds: string[]): { removed: string[]; absent: string[] } {
    const file = this.loadOrInit();
    const removed: string[] = [];
    const absent: string[] = [];
    const seen = new Set<string>();
    for (const workspaceId of workspaceIds) {
      if (seen.has(workspaceId)) continue;
      seen.add(workspaceId);
      if (file.workspaces[workspaceId]) {
        delete file.workspaces[workspaceId];
        removed.push(workspaceId);
      } else {
        absent.push(workspaceId);
      }
    }
    if (removed.length > 0) {
      this.persist(file);
    }
    return { removed, absent };
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
    // #task:1596 rounds 3-5 (Cindy P1-3) — protected-root overlap guard: a
    // requested path may not equal, live inside, OR be an ANCESTOR of any
    // protected root (an ancestor binding would purge the root itself;
    // ancestor coverage must be per-root because a connect custom data
    // root can live on a DISJOINT tree/volume from the global root, so
    // nothing "transitively" covers `~/.silverhand`'s ancestors).
    // The ONE carve-out: a path strictly INSIDE the global state root that
    // is a sanctioned legacyWorkspacesRoot child — that historical
    // exemption applies to the global root's DESCENDANT direction only,
    // never to its ancestors and never to workspace-data / agents roots.
    const insideLegacyWorkspacesChild =
      this.legacyWorkspacesRoot !== undefined &&
      resolved.startsWith(this.legacyWorkspacesRoot + sep);
    for (const root of this.protectedRoots) {
      if (!pathsOverlap(resolved, root)) continue;
      const isDescendantOfRoot = resolved.startsWith(root + sep);
      const exempt =
        isDescendantOfRoot &&
        insideLegacyWorkspacesChild &&
        this.silverhandStateRoot !== undefined &&
        root === this.silverhandStateRoot;
      if (exempt) continue;
      throw new WorkspaceRegistryError(
        'invalid_path',
        'requested path overlaps a protected silverhand root (workspace-data / agents / silverhand state)',
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

    const parsed = parseWorkspaceRegistryFileStrict(
      raw,
      m => new WorkspaceRegistryError('registry_corrupt', `registry file is malformed: ${m}`),
    );

    if (!bindingsEqual(parsed.binding, this.binding)) {
      throw new WorkspaceRegistryError(
        'registry_foreign',
        `registry is bound to ${parsed.binding.server_origin}/${parsed.binding.host_id}, ` +
          `not the current ${this.binding.server_origin}/${this.binding.host_id}`,
      );
    }
    // #task:1608 (Cindy R3-4) — a persisted registry whose ids collide
    // under case folding is corrupt (its managed dirs would alias on a
    // case-insensitive volume); fail closed rather than serve either.
    const collision = findCaseFoldCollision(Object.keys(parsed.workspaces));
    if (collision !== null) {
      throw new WorkspaceRegistryError(
        'registry_corrupt',
        `registry ids ${collision.a} and ${collision.b} collide case-insensitively`,
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
