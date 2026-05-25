export interface AuthRuntimeConfig {
  readonly signupEnabled: boolean;
  readonly sessionTtlMs: number;
}

export const DEFAULT_AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function resolveAuthRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthRuntimeConfig {
  const ttlDays = readPositiveInt(env.SILVERHAND_AUTH_SESSION_TTL_DAYS);
  return Object.freeze({
    signupEnabled: env.SILVERHAND_DISABLE_SIGNUP !== '1',
    sessionTtlMs: ttlDays
      ? ttlDays * 24 * 60 * 60 * 1000
      : DEFAULT_AUTH_SESSION_TTL_MS,
  });
}

function readPositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
