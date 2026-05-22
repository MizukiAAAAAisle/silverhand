/**
 * `SILVERHAND_RUNTIME_HOST` env switch — parsing and post-cleanup gate.
 *
 * Source of truth shared by `apps/desktop/src/main` and
 * `packages/backend/src/index.ts` so the two layers cannot drift on:
 *   - the accepted set (`legacy` | `daemon`)
 *   - the default (`daemon` — the only supported runtime path post
 *     Commit B of the cleanup sequence. `legacy` is retained as a parse
 *     value for one more commit so an operator who pinned it during the
 *     soak window sees a clear "removed" boot message instead of an
 *     unrelated parse failure; `legacy` no longer runs a different
 *     runtime — both backend and Electron main throw at boot with an
 *     explicit Commit B removed-message. The env switch itself
 *     disappears entirely in Commit C.)
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
 * Flipped from `'legacy'` to `'daemon'` in Commit A of the cleanup
 * sequence, after Option A v2 daemon-mode delivery (incl. codex) was
 * hand-verified end-to-end. Commit B then deleted the legacy
 * `ConversationManager` runtime, leaving daemon as the only runtime
 * path. `=legacy` survives one more commit only as a parse value
 * whose only effect is producing a precise removed-message at boot.
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
 * mistake that decides whether the boot proceeds or surfaces a
 * removed-message immediately.
 *
 * `'legacy'` parses successfully but the dispatch sites (backend
 * `startBackend` / Electron main bootstrap) throw at boot with a
 * Commit B removed-message; this is intentional so a stale `=legacy`
 * pin during the soak window produces a precise diagnostic rather
 * than a parse failure.
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
        `Accepted values are 'legacy' or 'daemon'. Unset the variable to use ` +
        `the default daemon runtime; setting ${SILVERHAND_RUNTIME_HOST_ENV}=legacy ` +
        `now throws at boot with an explicit Commit B removed-message rather ` +
        `than running a different runtime.`,
    );
  }
  return parsed.data;
}

/**
 * Human-readable banner line for boot logs. Both `apps/desktop/src/main`
 * and `packages/backend/src/index.ts` log this so operators see mode +
 * recovery hint in one place. Post Commit B the describer reflects
 * "daemon is the only runtime; legacy throws":
 *
 *   - `daemon`: no runtime rollback (the legacy CM runtime was removed
 *     in Commit B). The recovery hint points at fixing daemon
 *     connectivity, NOT at `=legacy` — Cindy `0aTZCqe07rmqA08k` blocker
 *     1: rollback 字段不要再 sell `=legacy` as a real recovery path.
 *   - `legacy`: retained parse value that boot-throws. The recovery
 *     hint is "unset (or set it to 'daemon')" — that's the only way
 *     to reach a working runtime.
 */
export function describeAgentRuntimeHostMode(mode: AgentRuntimeHostMode): {
  mode: AgentRuntimeHostMode;
  rollback: string;
  note: string;
} {
  if (mode === 'daemon') {
    return {
      mode,
      rollback:
        '(no runtime fallback — the legacy ConversationManager runtime was ' +
        'removed in Commit B; if daemon mode misbehaves, fix the daemon ' +
        'spawn / HostClient connection)',
      note:
        'agent runtime: daemon path (silverhand-daemon via RuntimeBridge) — the only supported runtime. ' +
        'The legacy in-process ConversationManager runtime was removed in Commit B of the cleanup sequence; ' +
        `${SILVERHAND_RUNTIME_HOST_ENV}=legacy is retained as a parse value for one more commit and now ` +
        'throws at boot with an explicit removed-message rather than wiring a different runtime. ' +
        'If daemon mode misbehaves, fix the silverhand-daemon spawn / HostClient connection — ' +
        'there is no runtime fallback.',
    };
  }
  return {
    mode,
    rollback: `unset ${SILVERHAND_RUNTIME_HOST_ENV} (or set it to 'daemon')`,
    note:
      'agent runtime: legacy parse value retained from PR-2 cleanup — ' +
      'the in-process ConversationManager runtime was removed in Commit B. ' +
      `${SILVERHAND_RUNTIME_HOST_ENV}=legacy now throws at boot with an ` +
      'explicit removed-message rather than running a different runtime; ' +
      'this is not a runtime recovery path away from the default daemon. ' +
      `Recovery: unset ${SILVERHAND_RUNTIME_HOST_ENV} (or set it to 'daemon').`,
  };
}
