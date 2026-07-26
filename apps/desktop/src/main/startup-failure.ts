/**
 * Startup failure classification — the ONE place that decides what a
 * fail-closed launch tells the user.
 *
 * Startup is fail-closed by design: the layout migration and the
 * boot-mode gate refuse to continue rather than merge, copy, or fall
 * back (`docs/app-data-layout-v2.md` §5/§6, D4.a Commit 3 boot gate).
 * Refusing correctly is worthless if the user sees nothing, so
 * `index.ts` catches the rethrow and shows one failure exit built from
 * this notice.
 *
 * **There is deliberately no "your data was not modified" claim here**
 * (#task:1641 review, @Cindy + @Alice). The tempting version graded it
 * by error class — `LayoutMigrationError` reads like a pre-write
 * refusal — and that is false: the engine renames the session pass,
 * facet children, and the adopted registry (`layout-migration/engine.ts`
 * `:762` / `:781` / `:822` / `:933`) and then throws the SAME class from
 * `:766` / `:785` / `:935` / `:982`, so the class straddles pre- and
 * post-write, and so do individual codes (`layout_unreadable` on both
 * sides). `ProfileUnusableError` is a genuine pre-write refusal but is
 * evaluated AFTER the migration, so for the launch as a whole it cannot
 * promise nothing moved either. A claim that can only be made
 * sometimes, and cannot be derived from the error, is not made at all:
 * the window states which layer failed, one line of specifics, and
 * where the logs are.
 *
 * Detail is one short line on purpose. Both typed errors carry
 * operator-facing messages (repair options, absolute paths); that
 * belongs in the log file the exit points at, not in a window whose job
 * is to convey one fact.
 */
import { LayoutMigrationError } from './layout-migration/engine.js';
import { ProfileUnusableError } from './backend-boot-mode.js';

export interface StartupFailureNotice {
  /** Which layer refused to start, in product terms. */
  headline: string;
  /** Stable code an operator can grep the logs for. */
  code: string;
  /** One short line of specifics, or null when there is nothing short to say. */
  detail: string | null;
}

const DETAIL_LIMIT = 200;

function shorten(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= DETAIL_LIMIT) return collapsed;
  return `${collapsed.slice(0, DETAIL_LIMIT - 1)}…`;
}

export function describeStartupFailure(error: unknown): StartupFailureNotice {
  if (error instanceof LayoutMigrationError) {
    return {
      headline: 'Silverhand could not migrate its data folder.',
      code: error.code,
      detail: shorten(error.message),
    };
  }
  if (error instanceof ProfileUnusableError) {
    return {
      headline: 'The saved server address cannot be used by this build.',
      code: 'profile_invalid',
      // The error's own message is a multi-clause repair essay; the
      // window shows the address and the classifier's reason, which is
      // what identifies the profile to fix.
      detail: shorten(`${error.profileUrl} — ${error.classifyMessage}`),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    headline: 'Silverhand could not finish starting.',
    code: 'startup_failed',
    detail: message.trim().length > 0 ? shorten(message) : null,
  };
}
