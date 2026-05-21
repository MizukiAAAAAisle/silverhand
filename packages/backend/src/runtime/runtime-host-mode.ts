/**
 * `SILVERHAND_RUNTIME_HOST` env switch — parsing and rollback gate.
 *
 * Source of truth shared by `apps/desktop/src/main` and
 * `packages/backend/src/index.ts` so the two layers cannot drift on:
 *   - the accepted set (`legacy` | `daemon`)
 *   - the default (`legacy` — a power-off-and-back-on rollback path)
 *   - the failure mode on an invalid value (loud throw, never silent fallback)
 *
 * This module is intentionally **pure**: it imports only `zod`, has no
 * side effects, and does not pull in DB / logger / Node server modules.
 * Electron main can import it during early bootstrap without dragging in
 * the entire backend module graph (per Cindy `Q48i12KhABcPcnK1`).
 */
import { z } from 'zod';

/** Discriminator returned by {@link parseAgentRuntimeHostMode}. */
export type AgentRuntimeHostMode = 'legacy' | 'daemon';

/** Default mode when the env var is unset / empty. */
export const DEFAULT_AGENT_RUNTIME_HOST_MODE: AgentRuntimeHostMode = 'legacy';

/** Canonical env var name. Use this constant — never the bare string. */
export const SILVERHAND_RUNTIME_HOST_ENV = 'SILVERHAND_RUNTIME_HOST';

const ModeSchema = z.enum(['legacy', 'daemon']);

/**
 * Parse `SILVERHAND_RUNTIME_HOST`'s raw env value into a discriminator.
 *
 * Semantics:
 *   - `undefined` / `''` (env var unset or empty)  → `'legacy'`
 *   - `'legacy'` / `'daemon'`                       → that value
 *   - anything else                                → throw a labelled
 *     `Error` naming the invalid value and the legal set.
 *
 * We deliberately do not coerce or lowercase. A typo like `Daemon` or
 * `LEGACY` will throw — silent canonicalisation would mask a config
 * mistake that decides whether we run with rollback safety or not.
 *
 * @throws Error when `raw` is a non-empty, non-`legacy|daemon` string.
 */
export function parseAgentRuntimeHostMode(
  raw: string | undefined,
): AgentRuntimeHostMode {
  if (raw === undefined || raw === '') {
    return DEFAULT_AGENT_RUNTIME_HOST_MODE;
  }
  const parsed = ModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${SILVERHAND_RUNTIME_HOST_ENV}: invalid value ${JSON.stringify(raw)}. ` +
        `Accepted values are 'legacy' or 'daemon'. To roll back to the ` +
        `default runtime path unset the variable or set it to 'legacy'.`,
    );
  }
  return parsed.data;
}

/**
 * Human-readable banner line for boot logs. Both `apps/desktop/src/main`
 * and `packages/backend/src/index.ts` log this so rollback instructions
 * appear in both places when something goes wrong.
 */
export function describeAgentRuntimeHostMode(mode: AgentRuntimeHostMode): {
  mode: AgentRuntimeHostMode;
  rollback: string;
  note: string;
} {
  if (mode === 'daemon') {
    return {
      mode,
      rollback: `${SILVERHAND_RUNTIME_HOST_ENV}=legacy`,
      note:
        'agent runtime: daemon path (silverhand-daemon via RuntimeBridge). ' +
        `If anything misbehaves, restart with ${SILVERHAND_RUNTIME_HOST_ENV}=legacy ` +
        'to fall back to the in-process ConversationManager spawn path.',
    };
  }
  return {
    mode,
    rollback: `(none — already on the safe default)`,
    note:
      'agent runtime: legacy path (in-process ConversationManager spawn). ' +
      `Set ${SILVERHAND_RUNTIME_HOST_ENV}=daemon to opt into the daemon path ` +
      'for testing; rollback by unsetting the variable.',
  };
}
