import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Daemon-local workspace registry — READ-ONLY legacy inventory reader
 * (relocation-v1 §7-4, #task:1808).
 *
 * ## What this is now
 *
 * A parser for a file an OLDER daemon wrote. It has exactly one production
 * consumer: the one-time layout relocation's `readInventory`, which needs the
 * pre-relocation `workspace_id → path` set to know what to move. It resolves
 * nothing at runtime, provisions nothing, and never writes.
 *
 * ## Why it was demoted
 *
 * Pre-§7-4 this was the authority for host-local path resolution of *regular*
 * workspaces: the backend spoke only `workspace_id` and the daemon looked the
 * absolute path up here. That whole indirection is gone. A regular workspace's
 * per-agent bundle now lives at a TERMINAL DETERMINISTIC agent-centric
 * coordinate — `<agent bundle root>/workspaces/<workspace_id>` on each member
 * agent's OWN computer — computed identically by every host with no lookup and
 * no stored binding. Nothing is provisioned ahead of use either: the first
 * spawn seeds the bundle lazily. With no non-derivable mapping left to own,
 * the registry keeps only the ability to READ what the old layout recorded, so
 * the migration can finish carrying it over.
 *
 * Agent-home / DM workspaces were never stored here — their path always
 * derived from the daemon's own state root + `agent_id`.
 *
 * ## What survives, and why each part is still load-bearing
 *
 * Namespace isolation: the file is bound to exactly one control-plane identity
 * `(server_origin, host_id)`, recorded in its header. A registry whose recorded
 * binding differs from the daemon's current binding is **foreign** and fails
 * closed with `registry_foreign` rather than handing another backend/profile's
 * entries to a migration that would then relocate them.
 *
 * Fail-closed parsing: a malformed file, a non-file at the path, or an id set
 * that collides case-insensitively is `registry_corrupt`. It is never
 * "repaired" into a partial inventory — the migration must relocate ALL of the
 * old layout or none of it, so a half-read inventory is strictly worse than a
 * refusal.
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

/**
 * relocation-v1 §7-4 — the read-only reader produces exactly two codes. The
 * write-path codes (`not_provisioned`, `path_conflict`, `invalid_path`) went
 * with the write path: a taxonomy member no caller can ever observe is an
 * authoritative-but-wrong contract. Unsafe id segments are still rejected, by
 * `WorkspaceIdSegmentError` at the path-authority boundary that actually mints
 * paths (`daemon/workspace-path-authority.ts`), not here.
 */
export type WorkspaceRegistryErrorCode = 'registry_foreign' | 'registry_corrupt';

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
 * (`sha256(workspace_id)` prefix). The flattened layout uses the RAW
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
 * #task:1608 (Cindy R3-4) — raw ids are case-sensitive but the default
 * APFS volume is not, so two ids differing only by case would land in the
 * SAME managed directory. Uniqueness is therefore enforced case-folded:
 * a registry whose ids collide under folding is corrupt.
 */
function workspaceIdCaseFoldKey(workspaceId: string): string {
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
 *  returns the first colliding pair or null. Shared by the inventory read and
 *  the migration plan. */
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

export interface WorkspaceRegistryOptions {
  /**
   * The workspace-data root that holds the legacy registry file (e.g.
   * `<silverhand>/computers/<computer_id>/workspace-data`). Injected, not
   * derived, so production and tests are explicit about which root is read.
   */
  stateDir: string;
  /** The daemon's current control-plane binding (see RegistryBinding). */
  binding: RegistryBinding;
}

function bindingsEqual(a: RegistryBinding, b: RegistryBinding): boolean {
  return a.server_origin === b.server_origin && a.host_id === b.host_id;
}

/**
 * Synchronous read-only view over one binding's registry file. Every call
 * re-reads from disk: there is no cached state to invalidate, and the only
 * caller reads once per migration attempt.
 */
export class WorkspaceRegistry {
  private readonly filePath: string;
  private readonly binding: RegistryBinding;

  constructor(opts: WorkspaceRegistryOptions) {
    // #task:1608 workspace-data convergence: the registry file sits DIRECTLY
    // on the workspace-data root — the `computers/<computer_id>` slot is the
    // enrollment boundary, so the historical per-binding nesting
    // (`<stateDir>/<bindingSlug>/`) is gone. The binding stays in the file
    // header as the foreign guard.
    this.filePath = join(opts.stateDir, REGISTRY_FILE_NAME);
    this.binding = opts.binding;
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
   * The legacy inventory recorded under the current binding. Absent file → an
   * empty list (nothing was ever provisioned under the old layout, so there is
   * nothing to relocate). Foreign or corrupt → throws.
   */
  list(): WorkspaceRegistryEntry[] {
    const file = this.load();
    if (file === null) return [];
    return Object.entries(file.workspaces).map(([workspace_id, entry]) => ({
      workspace_id,
      path: entry.path,
      provisioned_at: entry.provisioned_at,
    }));
  }

  // ── internals ──────────────────────────────────────────────────────

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
}
