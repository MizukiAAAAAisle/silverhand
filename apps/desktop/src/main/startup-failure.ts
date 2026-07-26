/**
 * Startup failure classification — the ONE place that decides what a
 * fail-closed launch is allowed to tell the user.
 *
 * Startup is fail-closed by design: the layout migration and the
 * boot-mode gate both refuse to continue rather than merge, copy, or
 * fall back (`docs/app-data-layout-v2.md` §5/§6, D4.a Commit 3 boot
 * gate). Refusing correctly is worthless if the user sees nothing, so
 * `index.ts` catches the rethrow and shows a single failure exit built
 * from this notice.
 *
 * Two rules live here, and only here:
 *
 *   1. **"Your data was not modified" is a claim, not a comfort line.**
 *      It may only be made for the typed refusals that are proven to
 *      abort before mutating anything (`LayoutMigrationError` —
 *      everything stages then activates with one rename;
 *      `ProfileUnusableError` — the classifier refuses the profile
 *      before any backend/daemon work). An unknown crash may have
 *      happened anywhere, including mid-write, so it says nothing.
 *   2. **Detail is one short line, never the raw essay.** Both typed
 *      errors carry operator-facing messages (repair options, paths);
 *      that belongs in the log file the exit points at, not in a window
 *      the user has to read to find the one fact they need.
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
  /** True only for typed refusals that abort before writing anything. */
  dataUntouched: boolean;
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
      dataUntouched: true,
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
      dataUntouched: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    headline: 'Silverhand could not finish starting.',
    code: 'startup_failed',
    detail: message.trim().length > 0 ? shorten(message) : null,
    dataUntouched: false,
  };
}
