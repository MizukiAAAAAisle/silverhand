/**
 * D4.d D2: daemon handler for the `agent_materialize` intent.
 *
 * Lives behind the same `IntentDispatcher` slot pattern as the
 * runtime_* family — wired through `DispatcherOptions.agent
 * MaterializeHandler` in `daemon/dispatcher.ts`. Stays out of the
 * `Supervisor` because agent home materialization is a one-shot
 * bootstrap, not a per-(conversation, agent) lifecycle event.
 *
 * Contract (design §3.1 / §4.6 / §6.5 / §8):
 *
 *   - `agent_dir` is computed daemon-local — the server only
 *     supplies `agent_id`. Default: `~/.silverhand/agents/<id>/`.
 *     Tests inject `homeDir` so they can point at a tmp dir
 *     without touching the real user home.
 *   - `agent_home_workspace_path === agent_dir` (§6.5 invariant —
 *     the DM workspace path IS the L1 dir).
 *   - Templates come from `template.ts`; daemon owns them and the
 *     backend does NOT import them (tripwire test enforces this).
 *   - Idempotent re-call: the sentinel's directory identity
 *     `(agent_id, template_choice)` matches the
 *     request → return ok:true without rewriting any file. Any
 *     mismatch → `agent_dir_collision`. The stored runtime is
 *     materialization-time provenance, not directory identity. Foreign content (no
 *     sentinel + non-empty dir) → `agent_dir_collision`.
 *   - fs errors map to typed wire codes (not collapsed into
 *     `internal_error`): `ENOSPC` → `fs_quota_exceeded`,
 *     `EACCES` / `EPERM` / `EROFS` → `fs_unavailable`. Unknown
 *     codes log + `internal_error` (preserves the unrecoverable
 *     vs recoverable boundary — see Cindy D2 pre-gate #3).
 */

import {
  linkSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  defaultAppRoot,
  resolveDesktopAppPaths,
} from '@silverhand/shared/app-data-layout';
import type {
  AgentMaterializeErrorCode,
  AgentMaterializeParams,
  AgentMaterializeResult,
} from '../../protocol.js';
import {
  AGENT_HOME_SENTINEL_FILENAME,
  AGENT_HOME_TEMPLATE_VERSION,
  type AgentHomeTemplate,
  getAgentHomeTemplate,
} from './template.js';
import {
  compareSentinel,
  readSentinel,
  writeSentinelAtomic,
} from './sentinel.js';
import { DaemonTypedError } from '../typed-error.js';
import { assertSafeWorkspaceIdSegment } from '../workspace-path-authority.js';

/**
 * Typed handler failure. Thrown by `materializeAgent` and
 * translated to wire `error.code` / HTTP status by the
 * dispatcher → outbound-client adapter. Carrying the typed code
 * (rather than a plain `Error`) is what lets Cindy D2 pre-gate
 * #3 hold: the dispatcher MUST NOT squash quota / unavailable /
 * collision into `internal_error`.
 */
export class AgentMaterializeError extends DaemonTypedError {
  constructor(
    readonly code: AgentMaterializeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentMaterializeError';
  }
}

export interface MaterializeAgentDeps {
  /**
   * Override the parent dir under which `agent_dir` is computed.
   * Production: `~`. Tests: a tmp directory. Default: `homedir()`.
   */
  homeDir?: string;
  /**
   * Override the exact root under which per-agent L1 dirs live.
   * Production Desktop passes `<SILVERHAND_DIR>/agents` so isolated
   * app launches do not write L1 files into the global user profile.
   * Takes precedence over `homeDir`.
   */
  agentHomeRootDir?: string;
  /** Override `Date.now()` so tests can pin `materialized_at`. */
  now?: () => number;
  /**
   * Test-only hook fired AFTER the §4.6 empty-dir check passes
   * and BEFORE `seedTemplate` runs. Production code MUST NOT
   * pass this — it exists solely so the race-window pin
   * (Cindy D2 round-2 P1) can simulate a foreign writer that
   * sneaks a NON-COLLIDING file into `agent_dir` between the
   * empty-dir check and the seed. Without this hook the test
   * cannot exercise the post-seed expected-tree verification
   * path because there is no natural pause point inside the
   * synchronous handler. The post-seed scan inside
   * `materializeAgent` is what actually closes the bug; this
   * hook only provides the test surface.
   */
  afterEmptyDirCheck?: (agentDir: string) => void | Promise<void>;
}

/**
 * Compute the absolute path the agent's L1 home lives at on this
 * host. Bare-daemon fallback only — production wiring passes
 * `agentHomeRootDir` explicitly. #task:1598/#task:1603 — delegates to
 * the shared app-data path authority (legacy-v1 agents root; env-AWARE
 * since the v2 cutover, contract §8); the `homeDir` seam keeps the
 * historical test signature.
 */
export function computeAgentDir(agentId: string, homeDir = homedir()): string {
  return join(
    resolveDesktopAppPaths(defaultAppRoot(process.env, () => homeDir), 'legacy-v1')
      .legacyLocalComputer.agents,
    agentId,
  );
}

export function computeAgentDirFromRoot(
  agentId: string,
  agentHomeRootDir: string,
): string {
  return join(agentHomeRootDir, agentId);
}

export function resolveAgentDir(
  agentId: string,
  deps: Pick<MaterializeAgentDeps, 'homeDir' | 'agentHomeRootDir'> = {},
): string {
  return deps.agentHomeRootDir
    ? computeAgentDirFromRoot(agentId, deps.agentHomeRootDir)
    : computeAgentDir(agentId, deps.homeDir);
}

/**
 * The deterministic, id-derived L2 bundle root for a (agent, regular
 * workspace) pair — `computers/<computer_id>/agents/<agent_id>/workspaces/
 * <workspace_id>/` (relocation-v1 §3.2/§3.3). `computer_id` is already folded
 * into the agent-home root (the computer slot's `agents` dir), so it is
 * inherited via `resolveAgentDir` rather than taken as a separate argument.
 *
 * This bundle root IS the agent's spawn cwd and IS its L2 memory dir (there is
 * no `.silverhand/agents/<id>` sub-path any more): MEMORY.md sits at the root,
 * notes/ beside it. It is the SOLE runtime path authority for regular
 * workspaces (relocation-v1 §7 task 1/4 — the registry is no longer a runtime
 * path source). As the sole path authority it self-validates the id before
 * making it a path SEGMENT — `assertSafeWorkspaceIdSegment` (the neutral
 * `workspace-path-authority` module's single id-safety predicate, shared with
 * the relocation reader, NOT the demoted registry) throws a typed
 * `WorkspaceIdSegmentError` on an unsafe id so a traversal segment can never
 * escape the agent home. The coordinate is always computable from
 * `(computer, agent, workspace)`; whether it is a usable cwd / has readable
 * memory is a SEPARATE fact checked per role, never a registry establishment
 * gate.
 */
export function resolveAgentWorkspaceBundleDir(
  agentId: string,
  workspaceId: string,
  deps: Pick<MaterializeAgentDeps, 'homeDir' | 'agentHomeRootDir'> = {},
): string {
  return join(
    resolveAgentDir(agentId, deps),
    'workspaces',
    assertSafeWorkspaceIdSegment(workspaceId),
  );
}

/**
 * Contract split (relocation-v1 §3.3; shiki + Cindy 2026-08-04): the session
 * cwd is the ONLY hard-ensured runtime base; L1/L2 CONTENT is best-effort
 * enrichment and never gates a spawn. That splits "is there a usable working
 * directory here?" from "is memory materialized here?" into TWO predicates
 * that must NOT be conflated:
 *
 *   - {@link bundleCwdUsable} — the CWD-usability fact. Answers `list_workspaces
 *     .agent_dir` (is a working dir materialized AND enterable by this process?)
 *     and underlies the supervisor's pre-spawn cwd hard-ensure. Deliberately the
 *     SAME predicate on both sides so list never reports a dir usable that spawn
 *     would then choke on.
 *   - {@link bundleL2Present} (below) — the MEMORY.md-readable fact. Answers only
 *     whether the prompt's Workspace Memory Index attaches a memory path, and is
 *     the completion fact `agent_l2_seed` reports as `l2_present`.
 *
 * A never-spawned member workspace (lazy window after a pure-DB membership add)
 * has neither; a half-seeded dir (mkdir succeeded, MEMORY.md not yet written)
 * is a usable cwd but has no readable memory. Keeping the predicates separate
 * lets the half-seeded dir be a valid, enterable cwd (the agent runs, just
 * without L2) while the memory index correctly reports "no memory path yet".
 *
 * "Usable cwd" = an existing directory the current process can ENTER/traverse
 * (search/execute permission), not merely one that exists. A `000` or otherwise
 * non-traversable dir would let list report `agent_dir` usable while `spawn`
 * fails on chdir — so this checks `X_OK`, matching what the OS requires of a cwd.
 */
export async function bundleCwdUsable(bundleDir: string): Promise<boolean> {
  try {
    if (!(await stat(bundleDir)).isDirectory()) return false;
    await access(bundleDir, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The memory-materialized fact for a bundle: `MEMORY.md` present AND READABLE at
 * the bundle root. This is the SAME fact the `agent_l2_seed` success contract
 * reports as `l2_present` — factored here as the single source so the seeder's
 * ack and the prompt's Workspace Memory Index agree by construction
 * (relocation-v1 §3.3).
 *
 * SCOPE: this is NOT a runtime-admission predicate. L1/L2 content is best-effort
 * enrichment — a missing/half-seeded/unreadable bundle must still spawn (shiki
 * 2026-08-04), so the cwd hard-ensure uses {@link bundleCwdUsable}, never this.
 * This predicate governs only whether a memory PATH is offered to the prompt: it
 * requires MEMORY.md to be a regular FILE (not a directory that happens to be
 * named `MEMORY.md`) that is readable (`R_OK`, not mere existence) — an
 * existing-but-unreadable or non-file entry is reported as "no memory path yet"
 * rather than handed over as a path the reader cannot open.
 */
export async function bundleL2Present(bundleDir: string): Promise<boolean> {
  try {
    const memoryFile = join(bundleDir, 'MEMORY.md');
    if (!(await stat(memoryFile)).isFile()) return false;
    await access(memoryFile, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the §4.6 decision tree and return a typed result.
 *
 * Two outcomes: an `AgentMaterializeResult` (ok:true) or a thrown
 * `AgentMaterializeError`. Never throws a bare `Error` for an
 * expected fs/idempotency failure — those paths set a typed
 * `code` so the dispatcher can map straight to the wire error
 * arm without squashing.
 */
export async function materializeAgent(
  params: AgentMaterializeParams,
  deps: MaterializeAgentDeps = {},
): Promise<AgentMaterializeResult> {
  const now = deps.now ?? Date.now;
  const agentDir = resolveAgentDir(params.agent_id, deps);

  // 1. Resolve the template before touching disk so an
  //    unsupported choice fails fast without leaving a half-
  //    written dir.
  const template = getAgentHomeTemplate(params.template_choice);
  if (!template) {
    throw new AgentMaterializeError(
      'unsupported_template',
      `daemon does not have a template definition for template_choice='${params.template_choice}'`,
    );
  }

  // 2. Idempotency / collision check (design §4.6 cases 2-5).
  //    Reading the sentinel first lets us cover all four cases
  //    in one branch tree without a second stat round-trip.
  let sentinel;
  try {
    sentinel = readSentinel(agentDir);
  } catch (err) {
    throw classifyFsError(
      err,
      `failed to read sentinel at ${join(agentDir, AGENT_HOME_SENTINEL_FILENAME)}`,
    );
  }

  if (sentinel.kind === 'ok') {
    // §4.6 case 4 / 5 — sentinel exists and is valid. Identity
    // check decides idempotent-ok vs collision.
    const match = compareSentinel(sentinel.sentinel, {
      agent_id: params.agent_id,
      template_choice: params.template_choice,
    });
    if (match.kind === 'match') {
      return {
        ok: true,
        agent_dir: agentDir,
        // §6.5 invariant: the DM workspace path IS the L1 dir.
        agent_home_workspace_path: agentDir,
        materialized_at: sentinel.sentinel.materialized_at,
      };
    }
    throw new AgentMaterializeError(
      'agent_dir_collision',
      `agent_dir already materialized with mismatched metadata; ${match.reason}`,
    );
  }

  if (sentinel.kind === 'invalid') {
    // §4.6 case 5 (subcase): a foreign / corrupt sentinel sits
    // in the dir. Treat as collision rather than rewrite —
    // refusing to overwrite is the safer default; an operator
    // can clear the dir and retry.
    throw new AgentMaterializeError(
      'agent_dir_collision',
      `agent_dir has an unrecognized sentinel; ${sentinel.reason}`,
    );
  }

  // 3. No sentinel. Determine whether the dir is missing, empty,
  //    or populated by foreign content.
  let entries: string[] | null;
  try {
    entries = readdirSync(agentDir);
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      // §4.6 case 2 — dir does not exist. Seed it.
      entries = null;
    } else {
      throw classifyFsError(err, `failed to read ${agentDir}`);
    }
  }

  if (entries !== null && entries.length > 0) {
    // §4.6 case 5 — populated foreign dir.
    throw new AgentMaterializeError(
      'agent_dir_collision',
      `agent_dir is not empty and has no sentinel; refusing to overwrite (${entries.length} foreign entries: ${entries.slice(0, 5).join(', ')}${entries.length > 5 ? ', ...' : ''})`,
    );
  }

  // 4. §4.6 case 2 / 3 — seed template + write sentinel.
  //
  // Cindy D2 round-2 P1: the empty-dir check at step 3 closes
  // the SAME-NAME collision window (a foreign writer placing
  // `system_prompt.md` would EEXIST at our `linkSync` step),
  // but a NON-COLLIDING foreign file (e.g. a marker named
  // `foreign-marker`) would slip past `linkSync` because
  // `linkSync` only fails on its specific target path. The
  // post-seed `verifyExpectedTree` scan below closes that
  // window: we re-walk `agent_dir` after seeding and BEFORE
  // writing the sentinel, and refuse to claim the directory
  // if anything outside the template's expected path set is
  // present. The `afterEmptyDirCheck` hook above lets the
  // race-window pin actually exercise this path; production
  // code never passes the hook.
  try {
    if (deps.afterEmptyDirCheck !== undefined) {
      await deps.afterEmptyDirCheck(agentDir);
    }
    seedTemplate(agentDir, template);
    verifyExpectedTree(agentDir, template);
    const materializedAt = now();
    writeSentinelAtomic(agentDir, {
      version: AGENT_HOME_TEMPLATE_VERSION,
      agent_id: params.agent_id,
      template_choice: params.template_choice,
      runtime: params.runtime,
      materialized_at: materializedAt,
    });
    return {
      ok: true,
      agent_dir: agentDir,
      agent_home_workspace_path: agentDir,
      materialized_at: materializedAt,
    };
  } catch (err) {
    if (err instanceof AgentMaterializeError) throw err;
    throw classifyFsError(err, `failed to seed template under ${agentDir}`);
  }
}

function seedTemplate(agentDir: string, template: AgentHomeTemplate): void {
  mkdirSync(agentDir, { recursive: true });
  for (const dir of template.dirs) {
    mkdirSync(join(agentDir, dir), { recursive: true });
  }
  for (const file of template.files) {
    writeFileAtomic(join(agentDir, file.relPath), file.content);
  }
}

/**
 * Verify post-seed that `agentDir` contains ONLY paths from the
 * template's expected set. Closes the non-colliding foreign-content
 * race window (Cindy D2 round-2 P1) — `linkSync` only protects
 * against same-name overwrite, so a foreign writer dropping a file
 * with a different name between the empty-dir check and the
 * sentinel write would otherwise be silently adopted into the
 * agent home.
 *
 * Implementation notes:
 *
 * - The scan asserts `actual ⊆ expected`, NOT equality. A missing
 *   template file would indicate a seed bug (every `writeFileAtomic`
 *   succeeded but the file isn't there), not a race; surfacing that
 *   as `agent_dir_collision` would mask the real failure.
 * - The sentinel file is NOT in the expected set because it has
 *   not been written yet at the point of this scan. If a foreign
 *   writer placed a file at `.materialized` between the empty-dir
 *   check and now, the scan will catch it and refuse to claim
 *   the dir — exactly the safer behaviour.
 * - On failure we throw `agent_dir_collision` and leave the
 *   partially-seeded template files on disk. A retry sees the
 *   foreign content via the §4.6 empty-dir branch and collisions
 *   identically; we never silently overwrite. Cleaning up
 *   our own writes would be lossy (we cannot reliably tell which
 *   files were ours) and is unnecessary.
 * - `tmp` files from `writeFileAtomic` are unlinked in its
 *   `finally` arm before this scan runs, so they cannot appear
 *   here under any path.
 */
function verifyExpectedTree(
  agentDir: string,
  template: AgentHomeTemplate,
): void {
  const expected = new Set<string>();
  for (const dir of template.dirs) expected.add(dir);
  for (const file of template.files) expected.add(file.relPath);
  // Walk every nested directory the template declared so foreign
  // entries inside (e.g.) `notes/foreign.md` are caught too.
  const actual = walkRelative(agentDir);
  const foreign: string[] = [];
  for (const path of actual) {
    if (!expected.has(path)) foreign.push(path);
  }
  if (foreign.length > 0) {
    throw new AgentMaterializeError(
      'agent_dir_collision',
      `post-seed expected-tree scan found foreign content (${foreign.length} entries: ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', ...' : ''}); refusing to write sentinel`,
    );
  }
}

/**
 * Return a flat list of every path under `root`, as relative
 * POSIX-style paths (matches `AgentHomeTemplateFile.relPath`).
 * Directories are emitted as their plain name (e.g. `notes`);
 * files inside them appear separately (e.g. `notes/foo.md`).
 */
function walkRelative(root: string): string[] {
  const out: string[] = [];
  const stack: { absDir: string; relDir: string }[] = [
    { absDir: root, relDir: '' },
  ];
  while (stack.length > 0) {
    const { absDir, relDir } = stack.pop()!;
    const entries = readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) {
        stack.push({ absDir: join(absDir, entry.name), relDir: rel });
      }
    }
  }
  return out;
}

function writeFileAtomic(filePath: string, content: string): void {
  // Cindy D2 P1-3: fail-closed against TOCTOU races between
  // empty-dir detection and final write. Pattern is tmp-write +
  // POSIX `link()`:
  //
  //   1. Write content to a tmp file in the same dir. Atomicity
  //      of the visible content is given by NOT exposing the
  //      target name until step 2.
  //   2. `linkSync(tmp, target)` — POSIX hard link. Unlike
  //      `renameSync`, link FAILS with EEXIST if `target` already
  //      exists. This is the exclusive-create primitive the
  //      handler needs; `rename` would silently overwrite a
  //      concurrent writer's file (the bug Cindy flagged at
  //      handler.ts:171-189 / 224-232).
  //   3. `unlinkSync(tmp)` in the finally arm — best-effort
  //      cleanup; if it fails we leak a hidden file but the
  //      target is correct.
  //
  // `EEXIST` propagates up to `materializeAgent`'s catch arm
  // which routes it to `agent_dir_collision` via `classifyFsError`.
  // A subsequent retry then sees a valid sentinel and returns
  // idempotent ok — exactly the recovery story Cindy described.
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, content, { mode: 0o600 });
    linkSync(tmpPath, filePath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort; the target file (if linked) is what matters.
    }
  }
}

/**
 * Map a Node.js fs error to a typed handler error. The mapping
 * preserves the recoverable / unrecoverable / collision boundary
 * that Cindy D2 pre-gate #3 asked us to keep visible (so the
 * route layer can decide retry / 503 / 507 / 409). Truly
 * unrecognized codes degrade to `internal_error` so they surface
 * in logs as new mappings to add, not as silent collisions.
 */
function classifyFsError(err: unknown, context: string): AgentMaterializeError {
  if (!isErrno(err)) {
    return new AgentMaterializeError(
      'internal_error',
      `${context}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  switch (err.code) {
    case 'ENOSPC':
      return new AgentMaterializeError(
        'fs_quota_exceeded',
        `${context}: ${err.message}`,
      );
    case 'EDQUOT':
      // POSIX disk-quota exceeded — semantically a quota error.
      return new AgentMaterializeError(
        'fs_quota_exceeded',
        `${context}: ${err.message}`,
      );
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new AgentMaterializeError(
        'fs_unavailable',
        `${context}: ${err.message}`,
      );
    case 'EEXIST':
      // Reachable in practice under concurrent materialize attempts
      // (Cindy D2 P1-3): seed + sentinel writes use `linkSync` for
      // exclusive creation, which FAILS with EEXIST if the target
      // file was placed there by a racing writer. Treating that as
      // `agent_dir_collision` lets the loser retry — the next call
      // sees the winner's valid sentinel and returns idempotent ok.
      return new AgentMaterializeError(
        'agent_dir_collision',
        `${context}: ${err.message}`,
      );
    default:
      return new AgentMaterializeError(
        'internal_error',
        `${context}: ${err.message}`,
      );
  }
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

function isErrnoCode(err: unknown, code: string): boolean {
  return isErrno(err) && err.code === code;
}
