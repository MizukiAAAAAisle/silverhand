import { z } from 'zod';

export const ServerModeSchema = z.enum(['embedded', 'remote']);
export type ServerMode = z.infer<typeof ServerModeSchema>;

export const ChildSessionLimitsSchema = z.object({
  max_concurrent_per_parent: z.number().int().positive().nullable().default(null),
  spawn_cooldown_seconds: z.number().int().nonnegative().nullable().default(null),
  // max_depth is hard-coded to 1 in code; field reserved for future
  max_depth: z.literal(1).default(1),
});
export type ChildSessionLimits = z.infer<typeof ChildSessionLimitsSchema>;

export const ServerConfigSchema = z.object({
  mode: ServerModeSchema,
  url: z.string().url(),
  auth_token: z.string().min(16).optional(),
  refresh_token: z.string().nullable().default(null),
  child_sessions: ChildSessionLimitsSchema.default({
    max_concurrent_per_parent: null,
    spawn_cooldown_seconds: null,
    max_depth: 1,
  }),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const SERVER_CONFIG_FILENAME = 'server-config.json';
export const INSTALLATION_ID_FILENAME = 'installation_id';
export const DAEMON_HOST_CONFIG_FILENAME = 'daemon-config.json';
export const EMBEDDED_BOOTSTRAP_FILENAME = 'embedded-bootstrap';
export const EVENT_WS_SESSION_COOKIE = 'silverhand_event_ws_session';
export const AUTH_TOKEN_HEADER = 'authorization';

export const DaemonHostConfigSchema = z.object({
  server_url: z.string().url(),
  host_id: z.string().min(1),
  host_token: z.string().min(1),
}).strict();
export type DaemonHostConfig = z.infer<typeof DaemonHostConfigSchema>;

/**
 * Environment variable names the `silverhand` CLI reads at every
 * invocation. Spawned agents inherit these from the backend's
 * ConversationManager (phase 1A/C). The CLI never accepts them as
 * arguments — agents must not override them, and the per-(cid, aid)
 * auth token is the integrity boundary that prevents impersonation
 * via a manual env override.
 *
 * These constants are exported here so both the spawn-side (backend
 * conversation-manager) and the read-side (`packages/cli`) reference
 * the same string and cannot drift.
 */
export const SILVERHAND_CONVERSATION_ID_ENV = 'SILVERHAND_CONVERSATION_ID';
export const SILVERHAND_AGENT_ID_ENV = 'SILVERHAND_AGENT_ID';
export const SILVERHAND_SERVER_URL_ENV = 'SILVERHAND_SERVER_URL';
export const SILVERHAND_AUTH_TOKEN_ENV = 'SILVERHAND_AUTH_TOKEN';

/**
 * D4.a Commit 1 — dev-only escape hatch that widens the server-URL
 * classifier to accept non-loopback http://... URLs (classified as
 * `{ kind: 'remote', insecure: true }`).
 *
 * Scope-locked invariant (Cindy review on slicing v2): this flag
 * ONLY affects acceptance of non-loopback http URLs. It does NOT:
 *   - relax TLS certificate verification on https:// URLs (those
 *     still go through Node's system-default CA pipeline),
 *   - widen the scheme allowlist (ws/wss/file/ftp still rejected),
 *   - affect the loopback http path (which never needed it).
 *
 * The flag value is intentionally NOT persisted to the server
 * connection profile (`docs/remote-backend-d4-design.md` §7.2): if it
 * were, toggling the env would cause profile↔runtime drift. Profile
 * acceptance is re-evaluated on every read against current env.
 *
 * Read site (Commit 1): pure constant only. Wiring into the daemon /
 * Setup Wizard / Settings consumers lands in subsequent D4.a commits.
 */
export const SILVERHAND_ALLOW_INSECURE_REMOTE_ENV =
  'SILVERHAND_ALLOW_INSECURE_REMOTE';

/**
 * Helper: read the dev-only insecure-remote env flag from a `process.env`
 * snapshot. Returns true iff the env value is exactly `'1'`.
 *
 * Strict equality (not truthiness) is deliberate: `'0'`, `'false'`,
 * `'off'`, and empty string all mean "off" — only the explicit `'1'`
 * activates the escape hatch. This matches the existing convention
 * already used by `SILVERHAND_DISABLE_SIGNUP` in
 * `packages/backend/src/auth/config.ts`.
 */
export function readAllowInsecureRemoteFlag(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[SILVERHAND_ALLOW_INSECURE_REMOTE_ENV] === '1';
}
