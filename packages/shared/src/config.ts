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
  user_id: z.string().nullable().default(null),
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
export const AUTH_TOKEN_ENV = 'AGENT_HUB_AUTH_TOKEN';
