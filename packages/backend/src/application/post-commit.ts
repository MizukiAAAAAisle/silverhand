import type { BackendLogger } from '../context.js';

/**
 * A side-effect that must run AFTER a use case's DB transaction has
 * committed — event publishing, runtime delivery, best-effort notifications.
 * Per the application-layer spec (`docs/use-case-layer-p0-spec.md` §2/§5):
 * the use case collects these inside the transaction (push closures, do not
 * execute) and runs them once the commit succeeds, so a rolled-back
 * transaction never emits a phantom event.
 */
export type PostCommitEffect = () => void | Promise<void>;

/**
 * Execute collected {@link PostCommitEffect}s in collection order. Effects
 * are best-effort: a thrown effect is logged and the remaining effects still
 * run — a failed publish must never undo an already-committed DB fact.
 *
 * Deliberately a thin tool (spec §5, Cindy review constraint ④): it does NOT
 * own the transaction. The use case keeps the unit-of-work visible
 * (`db.transaction(() => { ...; effects.push(...) })()`) and calls this only
 * for the post-commit drain.
 */
export async function runPostCommitEffects(
  effects: readonly PostCommitEffect[],
  logger: BackendLogger,
): Promise<void> {
  for (const effect of effects) {
    try {
      await effect();
    } catch (err) {
      logger.warn({ err }, 'post-commit effect failed');
    }
  }
}
