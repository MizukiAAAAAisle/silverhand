import {
  DaemonLayoutMigrationCodeSchema,
  type DaemonLayoutMigrationCode,
} from '@silverhand/shared';

/** Private one-shot child result discriminator. This is launcher IPC, not part
 * of the daemon/server wire protocol. */
export const WORKSPACE_PREFLIGHT_RESULT_EVENT =
  'workspace_startup_preflight_complete' as const;

/**
 * #task:1815 — the FAILURE counterpart. The preflight child is the process that
 * refuses the launch, and its exit status alone told the launcher nothing: the
 * startup-failure window could only say `startup_failed` plus "exited with code
 * 1", so the one report a permanently-stuck user can produce named neither the
 * layer nor the reason.
 *
 * The frame carries the closed-set diagnostics code and NOTHING ELSE. Not the
 * child's message, not a path, not an errno, not the stage: the child's messages
 * are operator text with absolute paths and env values in them, and the window is
 * a product surface. The desktop derives every user-visible word from the code
 * alone, so nothing that crosses this boundary can leak into a window, and the
 * two sides cannot drift apart in what they claim happened. Operator detail stays
 * in the host-local log the window points at.
 *
 * Emitted on stdout exactly like the success frame — one JSON line, one frame per
 * run, either the success discriminator or this one, never both.
 */
export const WORKSPACE_PREFLIGHT_FAILURE_EVENT =
  'workspace_startup_preflight_failed' as const;

/**
 * The launcher-side typed failure: a preflight child that refused with a code we
 * recognize. `code` is a member of the daemon diagnostics closed set (the child
 * maps every throw through `daemonLayoutMigrationCode`, so an unrecognized throw
 * arrives as the `'unknown'` MEMBER — never as an arbitrary string), and the
 * `message` is launcher-generated, never the child's text.
 */
export class WorkspaceStartupPreflightFailure extends Error {
  constructor(readonly code: DaemonLayoutMigrationCode) {
    super(`workspace startup preflight refused the launch (${code})`);
    this.name = 'WorkspaceStartupPreflightFailure';
  }
}

/**
 * Read a failure frame out of the child's stdout, or `null` when there is none
 * (no frame, extra lines, non-JSON, wrong discriminator, or a code outside the
 * closed set). A `null` keeps the caller on its existing generic error: the point
 * of this frame is to ADD a named cause, never to invent one.
 */
export function parseWorkspacePreflightFailureFrame(
  stdout: string,
): DaemonLayoutMigrationCode | null {
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!);
  } catch {
    return null;
  }
  const frame = parsed as { event?: unknown; code?: unknown };
  if (frame.event !== WORKSPACE_PREFLIGHT_FAILURE_EVENT) return null;
  const code = DaemonLayoutMigrationCodeSchema.safeParse(frame.code);
  return code.success ? code.data : null;
}

/** Serialize the one failure frame the child writes to stdout. */
export function serializeWorkspacePreflightFailureFrame(
  code: DaemonLayoutMigrationCode,
): string {
  return `${JSON.stringify({
    event: WORKSPACE_PREFLIGHT_FAILURE_EVENT,
    code,
  })}\n`;
}
