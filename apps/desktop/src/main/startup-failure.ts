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
 * Detail is one short line on purpose. For a migration failure that
 * line is derived from the diagnostics code (see `MIGRATION_DETAIL`),
 * never from the error's own text: those messages are operator text with
 * absolute paths and env variable names in them, and they reach this
 * module from two different carriers, so deriving from the code is also
 * what keeps the two from describing one condition two ways. The
 * remaining arms do quote their errors, whose messages are short and
 * identify the thing to fix; the repair essays those errors append
 * belong in the log file the exit points at.
 */
import {
  DaemonLayoutMigrationCodeSchema,
  type DaemonLayoutMigrationCode,
} from '@silverhand/shared';
import { WorkspaceStartupPreflightFailure } from '@silverhand/host';
import { LayoutMigrationError } from './layout-migration/engine.js';
import {
  ProfileUnusableError,
  RemoteOnlyServerProfileRequiredError,
} from './backend-boot-mode.js';

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

const DATA_FOLDER_HEADLINE = 'Silverhand could not migrate its data folder.';

/**
 * #task:1815 — the product sentence for a migration failure, keyed by
 * diagnostics code.
 *
 * Two properties are deliberate.
 *
 * **Grouped by KIND of failure, not one sentence per code.** The
 * `flatten_` / `layout_` / `relocation_` prefixes name which pass
 * refused — an implementation coordinate the user cannot act on. What
 * differs for the user is whether a disk write failed, something changed
 * underfoot, a location was occupied, or a setting is wrong, so codes
 * that share a kind share a sentence, and the map is exhaustive over the
 * closed set (a new member fails compilation instead of silently landing
 * in a generic bucket).
 *
 * **Only three sentences promise anything.** Free space / permissions,
 * "quit the other thing that is writing", and the non-absolute config
 * directory are the failures whose repair action is known and
 * user-performable (#task:1641 criterion), and every startup re-runs the
 * idempotent pass, so "reopen" is a real repair for them. The rest state
 * the fact and stop: reopening does not clear an occupied destination or
 * an unsafe id, and offering another try would sell a loop — the same
 * reason this window has no Retry. The way out of those is the code plus
 * `Reveal Logs`, where the operator text lives.
 *
 * Wording follows the PRODUCER set, not the code name: `relocation_*` is
 * thrown by both `layout-relocation.ts` and `opaque-copy.ts`, so
 * `*_move_failed` covers clone/copy staging and publish as well as the
 * marker write — which is why it speaks of writing to disk in general
 * rather than naming one file.
 */
const DISK_WRITE_DETAIL =
  'Silverhand could not finish writing to disk. Check free space and folder permissions, then reopen Silverhand.';
const CHANGED_WHILE_MOVING_DETAIL =
  "Another program changed Silverhand's data while it was being moved. Close other Silverhand windows and command-line sessions, then reopen Silverhand.";
const SESSION_STORE_ROOT_DETAIL =
  'The configured session storage directory must be an absolute path. Clear that setting or change it to an absolute path, then reopen Silverhand.';
const OCCUPIED_DETAIL =
  'Silverhand found unexpected or conflicting contents where it needed to move data, and stopped instead of merging them.';
const UNREADABLE_DETAIL = 'Silverhand could not read part of its own data.';
const SPECIAL_FILE_DETAIL =
  "Part of Silverhand's data is not a regular file or folder.";
const UNVERIFIABLE_LOCATION_DETAIL =
  'Silverhand could not verify one of its own data locations.';
const MARKER_UNSUPPORTED_DETAIL =
  "Silverhand does not support this data folder's migration marker version.";

const MIGRATION_DETAIL: Record<DaemonLayoutMigrationCode, string | null> = {
  flatten_conflict: OCCUPIED_DETAIL,
  flatten_unreadable: UNREADABLE_DETAIL,
  flatten_invalid_id: UNVERIFIABLE_LOCATION_DETAIL,
  flatten_move_failed: DISK_WRITE_DETAIL,
  layout_conflict: OCCUPIED_DETAIL,
  layout_unreadable: UNREADABLE_DETAIL,
  layout_special_file: SPECIAL_FILE_DETAIL,
  layout_move_failed: DISK_WRITE_DETAIL,
  relocation_conflict: OCCUPIED_DETAIL,
  relocation_unreadable: UNREADABLE_DETAIL,
  relocation_special_file: SPECIAL_FILE_DETAIL,
  relocation_unstable: CHANGED_WHILE_MOVING_DETAIL,
  relocation_move_failed: DISK_WRITE_DETAIL,
  relocation_unverifiable: UNVERIFIABLE_LOCATION_DETAIL,
  relocation_marker_unsupported: MARKER_UNSUPPORTED_DETAIL,
  session_store_root_unverifiable: SESSION_STORE_ROOT_DETAIL,
  // Nothing short is known about an unrecognized throw; the window still
  // carries the headline, the code, and the way to the logs.
  unknown: null,
};

/**
 * The sentence for a code in the daemon closed set, or `undefined` when
 * the code is desktop-local (`layout_registry_rewrite_blocked`,
 * `layout_marker_corrupt`) and so has no shared entry.
 *
 * Consulted by BOTH carriers on purpose. `session_store_root_unverifiable`
 * is refused by the daemon preflight child (arriving as a code-only
 * frame) AND by the desktop's own engine (arriving as a
 * `LayoutMigrationError` whose message is operator text naming the env
 * variable). Deriving from the code in both places is what makes "one
 * condition, one code, one sentence" hold at the last inch — otherwise
 * the same machine reads a product sentence or a log line depending on
 * which process happened to run the pass.
 */
function namedMigrationDetail(code: string): string | null | undefined {
  const parsed = DaemonLayoutMigrationCodeSchema.safeParse(code);
  return parsed.success ? MIGRATION_DETAIL[parsed.data] : undefined;
}

export function describeStartupFailure(error: unknown): StartupFailureNotice {
  if (error instanceof WorkspaceStartupPreflightFailure) {
    // The frame carries the code and nothing else, and this error's own
    // message is launcher-generated ("refused the launch (<code>)"), so
    // the map is the only source of user-visible words here.
    return {
      headline: DATA_FOLDER_HEADLINE,
      code: error.code,
      detail: MIGRATION_DETAIL[error.code],
    };
  }
  if (error instanceof LayoutMigrationError) {
    const named = namedMigrationDetail(error.code);
    return {
      headline: DATA_FOLDER_HEADLINE,
      code: error.code,
      // A shared code takes the product sentence; a desktop-local code
      // keeps its operator message, the only description it has.
      // (`unknown` is not in this error's union, so the one `null` entry
      // cannot swallow a message here.)
      detail: named === undefined ? shorten(error.message) : named,
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
  if (error instanceof RemoteOnlyServerProfileRequiredError) {
    return {
      headline: 'This build needs a remote server address to start.',
      code: 'remote_profile_required',
      // `reason` is the one fact that distinguishes this refusal (which
      // boot decision was reached); the error's own message appends the
      // repackage/repair options, which belong in the log.
      detail: shorten(error.reason),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    headline: 'Silverhand could not finish starting.',
    code: 'startup_failed',
    detail: message.trim().length > 0 ? shorten(message) : null,
  };
}
