import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DAEMON_HOST_CONFIG_FILENAME,
  DaemonHostConfigSchema,
  HostClaimOrCreateInputSchema,
  INSTALLATION_ID_FILENAME,
  apiPaths,
  type DaemonHostConfig,
  type HostClaimOrCreateInput,
} from '@silverhand/shared';
import { z } from 'zod';

const InstallationIdSchema = z.string().uuid();

export type LocalHostClaimStatus =
  | { status: 'unclaimed'; hostId: null }
  | { status: 'claimed'; hostId: string }
  | { status: 'revoked'; hostId: string | null }
  | { status: 'error'; hostId: string | null }
  // D3.b Commit 2 — daemon supervisor budget exhausted (i.e.
  // `spawnDaemonChild` gave up restarting after exceeding
  // `maxRestarts` within `restartWindowMs`). The local host row is
  // still valid server-side; the renderer can show "Host stopped
  // responding" and prompt the user to restart the app. Strict
  // source rule (Cindy `#task:627` review gate): ONLY the supervisor's
  // `onExit` fatal callback may flip into this state. Attach
  // watchdog timeout / typed `host_outbound_attach` failure / 401 /
  // revoked are NOT routed through `failed`.
  | { status: 'failed'; hostId: string | null };

export function installationIdPath(silverhandDir: string): string {
  return join(silverhandDir, INSTALLATION_ID_FILENAME);
}

export function daemonHostConfigPath(silverhandDir: string): string {
  return join(silverhandDir, DAEMON_HOST_CONFIG_FILENAME);
}

export function loadOrCreateInstallationId(silverhandDir: string): string {
  const path = installationIdPath(silverhandDir);
  if (existsSync(path)) {
    const parsed = InstallationIdSchema.safeParse(readFileSync(path, 'utf8').trim());
    if (parsed.success) return parsed.data;
  }

  const installationId = randomUUID();
  writeSecretFile(path, `${installationId}\n`);
  return installationId;
}

export function readDaemonHostConfig(
  silverhandDir: string,
): DaemonHostConfig | null {
  const path = daemonHostConfigPath(silverhandDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = DaemonHostConfigSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeDaemonHostConfig(
  silverhandDir: string,
  config: DaemonHostConfig,
): void {
  const parsed = DaemonHostConfigSchema.parse(config);
  writeSecretFile(
    daemonHostConfigPath(silverhandDir),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}

export function removeDaemonHostConfig(silverhandDir: string): void {
  try {
    unlinkSync(daemonHostConfigPath(silverhandDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function buildHostClaimInput(input: {
  installationId: string;
  existingConfig: DaemonHostConfig | null;
  label?: string;
}): HostClaimOrCreateInput {
  return HostClaimOrCreateInputSchema.parse({
    installation_id: input.installationId,
    label: input.label ?? hostname(),
    ...(input.existingConfig
      ? { current_host_id: input.existingConfig.host_id }
      : {}),
  });
}

/** Normalize a renderer-supplied path to its pathname, stripping
 *  query strings and fragments. The renderer hands us strings like
 *  `/api/hosts/<id>/rotate-token?x=1` or `.../revoke#frag`; the
 *  pathname is what `backendUrl()` ultimately routes against on the
 *  Hono side, so all sensitive matching MUST be done against the
 *  pathname rather than the raw string.
 *
 *  This helper is intentionally lossy and does NOT validate the
 *  input — anything `new URL(input, base)` can resolve becomes a
 *  pathname (including absolute URLs like `http://evil/api/x` and
 *  bare strings like `not-a-path`). Callers that need to reject
 *  non-relative input (e.g. {@link assertApiProxyPath}) must run a
 *  raw check on the original string FIRST. */
export function pathnameOf(rawPath: string): string {
  try {
    return new URL(rawPath, 'http://silverhand.local').pathname;
  } catch {
    return rawPath;
  }
}

/** Routes that the desktop main process owns end-to-end and that
 *  must NEVER be reachable through the generic renderer proxy
 *  (`backend:request` / `backend:upload`). Two reasons:
 *
 *  - `claim-or-create` and `rotate-token` responses carry cleartext
 *    `host_token` bytes that belong in `daemon-config.json`, not in
 *    any value the renderer can read.
 *  - `revoke` has a local side-effect (clearing daemon-config when
 *    the user revokes the current host) that only the dedicated
 *    main IPC performs. Letting the renderer hit the route through
 *    the proxy would leave the local daemon-config out of sync.
 *
 *  GET `/api/hosts` is intentionally NOT in this set — it is owner-
 *  filtered server-side and returns no token. The renderer uses the
 *  generic proxy to populate the Hosts settings page.
 *
 *  IMPORTANT: matching is done against the normalized pathname (no
 *  query, no fragment). A naive `endsWith('/rotate-token')` against
 *  the raw input would let `/api/hosts/<id>/rotate-token?x=1` slip
 *  past, and the renderer could then receive cleartext `host_token`
 *  bytes via the generic proxy. */
export function isMainManagedHostPath(path: string): boolean {
  const pathname = pathnameOf(path);
  if (pathname === apiPaths.hostClaimOrCreate) return true;
  if (pathname.startsWith('/api/hosts/') && pathname.endsWith('/rotate-token')) return true;
  if (pathname.startsWith('/api/hosts/') && pathname.endsWith('/revoke')) return true;
  return false;
}

/** @deprecated Stage B.4 superseded by {@link isMainManagedHostPath}.
 *  The old guard only covered `claim-or-create`; the new name covers
 *  the full main-managed surface (claim + rotate + revoke). Kept as
 *  a re-export so external callers don't break, but new code should
 *  reference {@link isMainManagedHostPath} directly. */
export const isTokenBearingHostClaimPath = isMainManagedHostPath;

/** Gate applied to every renderer-issued `backend:request` /
 *  `backend:upload` proxy call. Two layers:
 *
 *  1. RAW startsWith `/api/`. This rejects absolute URLs
 *     (`http://evil.example/api/x`) and protocol-relative URLs
 *     (`//evil.example/api/x`) before any normalization happens.
 *     Without this layer, `pathnameOf()` would happily extract
 *     `/api/x` from an attacker-controlled origin, the deny-list
 *     would miss because the path isn't in the main-managed set, and
 *     `backendUrl()` (which uses `new URL(path, backendBase)` —
 *     `new URL('http://evil/api/x', base)` keeps the evil origin)
 *     would then forward the user's session bearer to the
 *     attacker's host.
 *  2. Main-managed deny-list (`isMainManagedHostPath`). After the
 *     raw gate accepts only relative `/api/...` strings, this
 *     normalizes the pathname (stripping `?` and `#`) and rejects
 *     claim / rotate / revoke so renderer can't reach those routes
 *     through the generic proxy. */
export function assertApiProxyPath(path: string): void {
  if (!path.startsWith('/api/')) {
    throw new Error(`desktop backend proxy only accepts /api/* paths: ${path}`);
  }
  if (isMainManagedHostPath(path)) {
    throw new Error(`desktop backend proxy refuses main-managed host route: ${path}`);
  }
}

/** Persist a freshly rotated host token. Pure side-effect helper —
 *  reused by the `hosts:rotate` IPC and unit-tested separately. The
 *  main process wraps this in network I/O + token bookkeeping. */
export function applyRotateSideEffects(input: {
  silverhandDir: string;
  serverUrl: string;
  hostId: string;
  hostToken: string;
}): void {
  writeDaemonHostConfig(input.silverhandDir, {
    server_url: input.serverUrl,
    host_id: input.hostId,
    host_token: input.hostToken,
  });
}

/** Reconcile local daemon-config when a host is revoked. Returns
 *  `'cleared'` when the revoked host id matches the desktop's current
 *  local-host binding (config dropped), `'unchanged'` otherwise. */
export function applyRevokeSideEffects(input: {
  silverhandDir: string;
  hostId: string;
}): 'cleared' | 'unchanged' {
  const existing = readDaemonHostConfig(input.silverhandDir);
  if (existing?.host_id !== input.hostId) return 'unchanged';
  removeDaemonHostConfig(input.silverhandDir);
  return 'cleared';
}

function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup only.
    }
    throw err;
  }
}
