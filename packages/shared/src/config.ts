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
  auth_token: z.string().min(16),
  refresh_token: z.string().nullable().default(null),
  child_sessions: ChildSessionLimitsSchema.default({
    max_concurrent_per_parent: null,
    spawn_cooldown_seconds: null,
    max_depth: 1,
  }),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const SERVER_CONFIG_FILENAME = 'server-config.json';
export const AUTH_TOKEN_HEADER = 'authorization';

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
