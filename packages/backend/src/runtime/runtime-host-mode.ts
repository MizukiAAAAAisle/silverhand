/**
 * `SILVERHAND_RUNTIME_HOST` env switch — parsing and rollback gate.
 *
 * Source of truth shared by `apps/desktop/src/main` and
 * `packages/backend/src/index.ts` so the two layers cannot drift on:
 *   - the accepted set (`legacy` | `daemon`)
 *   - the default (`daemon` — the supported runtime path. `legacy` remains
 *     reachable as an explicit rollback during the cleanup soak window
 *     and will be removed in a later commit once the in-process
 *     ConversationManager surfaces are deleted.)
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

/**
 * Default mode when the env var is unset / empty.
 *
 * Flipped from `'legacy'` to `'daemon'` as Commit A of the cleanup
 * sequence (PR-2 step 2 commit 5 unit 2b-iii post-cleanup), after Option
 * A v2 daemon-mode delivery (incl. codex) was hand-verified end-to-end.
 * `SILVERHAND_RUNTIME_HOST=legacy` remains a working explicit rollback
 * until the legacy ConversationManager surfaces are deleted in a later
 * commit — do NOT delete the legacy code path and this env switch in the
 * same diff.
 */
export const DEFAULT_AGENT_RUNTIME_HOST_MODE: AgentRuntimeHostMode = 'daemon';

/** Canonical env var name. Use this constant — never the bare string. */
export const SILVERHAND_RUNTIME_HOST_ENV = 'SILVERHAND_RUNTIME_HOST';

const ModeSchema = z.enum(['legacy', 'daemon']);

/**
 * Parse `SILVERHAND_RUNTIME_HOST`'s raw env value into a discriminator.
 *
 * Semantics:
 *   - `undefined` / `''` (env var unset or empty)  → `'daemon'`
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
        'agent runtime: daemon path (silverhand-daemon via RuntimeBridge) — default. ' +
        `If anything misbehaves, restart with ${SILVERHAND_RUNTIME_HOST_ENV}=legacy ` +
        'to fall back to the in-process ConversationManager spawn path (rollback ' +
        'remains available until the legacy code is deleted in a follow-up commit).',
    };
  }
  return {
    mode,
    rollback: `unset ${SILVERHAND_RUNTIME_HOST_ENV} (or set it to 'daemon')`,
    note:
      'agent runtime: legacy path (in-process ConversationManager spawn) — ' +
      `explicit rollback from the default daemon path via ${SILVERHAND_RUNTIME_HOST_ENV}=legacy. ` +
      'This path is scheduled for removal once the daemon soak completes; ' +
      'unset the variable (or set it to \'daemon\') to return to the default.',
  };
}
