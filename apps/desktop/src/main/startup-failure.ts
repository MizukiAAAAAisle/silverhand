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

export function describeStartupFailure(error: unknown): StartupFailureNotice {
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
