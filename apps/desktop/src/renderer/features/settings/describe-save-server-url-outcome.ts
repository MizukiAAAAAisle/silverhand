/**
 * D3.c Commit 4 — pure mapper from `DesktopSaveServerUrlResult` to
 * the visual surface the user sees after pressing Save.
 *
 * Why this lives in its own file (and as a pure function): the copy
 * keys MUST stay distinct per discriminator arm so the renderer
 * cannot collapse `reloaded` and `connectivity_unverified` into a
 * single "Connected" string — Cindy `#task:634` review note 1. By
 * extracting the mapping we get unit tests pinning every arm, so a
 * future "let's simplify the copy" refactor can't quietly merge
 * arms that carry different connectivity claims.
 *
 * The mapper does not know about JSX — callers render the returned
 * `{tone, title, description}` triple however they like (the pane
 * uses a status banner). `tone` drives the chrome (success
 * accent / warn yellow / error red); `title` is the headline copy;
 * `description` is the diagnostic detail (raw URL, elapsed ms,
 * underlying error). Description is intentionally allowed to be
 * empty when the title already says everything.
 */
import type { DesktopSaveServerUrlResult } from '../../../preload/api';

export interface SaveServerUrlBanner {
  /**
   * Visual tone:
   *   - 'success' — the daemon swapped and the backend confirmed a
   *     fresh attachment. The server URL is saved AND verified
   *     connecting.
   *   - 'info'    — partial confirmation. `unchanged` (nothing to
   *     do) or `connectivity_unverified` (saved, but not yet
   *     reconnected) both land here so the UI never claims
   *     "connected" without observation.
   *   - 'error'   — something rejected the save; the daemon is
   *     either untouched or refused to swap. Renderer surfaces
   *     the actionable reason.
   */
  tone: 'success' | 'info' | 'error';
  /** Short headline. Imperative or status-form (≤ ~60 chars). */
  title: string;
  /**
   * Optional diagnostic sub-line. Empty string when the title is
   * already self-contained — callers can `description &&` to skip
   * the second row.
   */
  description: string;
}

export function describeSaveServerUrlOutcome(
  result: DesktopSaveServerUrlResult,
): SaveServerUrlBanner {
  if (result.ok) {
    switch (result.kind) {
      case 'reloaded':
        return {
          tone: 'success',
          title: 'Saved — daemon reconnected to the new server.',
          description: `Fresh attachment observed in ${formatMs(result.elapsedMs)}.`,
        };
      case 'unchanged':
        // No-op write. The bytes were already what the user typed —
        // probably a "saved without changing anything" pass. The
        // copy explicitly avoids claiming connectivity status
        // (the existing connection is whatever it was before).
        return {
          tone: 'info',
          title: 'No changes — server URL was already that value.',
          description: '',
        };
      case 'connectivity_unverified':
        // CRITICAL: Cindy `#task:634` review note 1 — this MUST
        // NOT be rendered as "Connected". The user's CONFIG is
        // saved (the daemon acked the reload); we just didn't
        // observe the new WS landing within the watchdog budget,
        // which most often means the new backend is unreachable.
        // Copy is deliberately "saved" + "still reconnecting" so
        // the user knows to either wait or undo the URL change.
        return {
          tone: 'info',
          title: 'Saved — still reconnecting to the new server.',
          description: `No connection observed within ${formatMs(result.elapsedMs)}. The previous connection has been dropped; the new one may still be in progress, or the server may be unreachable.`,
        };
      default: {
        // Exhaustiveness gate — adding a new ok arm without
        // updating this switch fails the typecheck loud.
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }
  switch (result.kind) {
    case 'classify_rejected':
      return {
        tone: 'error',
        title: describeClassifyReason(result.reason),
        // Surface the classifier's raw message — it carries the
        // specific token that failed (e.g. the obfuscated IP, the
        // unsupported scheme name) which the per-reason headline
        // can't include without runtime substitution.
        description: result.message,
      };
    case 'remote_backend_not_yet_supported':
      // D4.a Commit 1 — the classifier admitted a remote URL but the
      // Settings → save pipeline is still loopback-only in this
      // build. Render an honest banner so the user knows the URL
      // shape is fine but the *feature* isn't wired through yet.
      // Removed when Commit 5 lands the profile update flow.
      return {
        tone: 'error',
        title: 'Remote backend support is not yet enabled in this build.',
        description: result.message,
      };
    case 'config_write_failed':
      return {
        tone: 'error',
        title: 'Could not write daemon config to disk.',
        description: result.message,
      };
    case 'reload_rejected':
      return {
        tone: 'error',
        title: describeReloadReason(result.reason),
        description: result.message,
      };
    case 'no_attachment_controller':
      // Mode-specific edge: daemon acked the reload but the
      // backend mode lacks a `HostWsController` to observe the
      // resulting attachment. Bytes are saved; verification is
      // structurally impossible in this build.
      return {
        tone: 'info',
        title: 'Saved — connection verification not available in this mode.',
        description: result.message,
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function describeClassifyReason(
  reason: Extract<
    DesktopSaveServerUrlResult,
    { kind: 'classify_rejected' }
  >['reason'],
): string {
  switch (reason) {
    case 'malformed_url':
      return 'Server URL is not a valid URL.';
    case 'unsupported_scheme':
      return 'Server URL must start with http:// or https://.';
    case 'insecure_remote_http_disallowed':
      // D4.a Commit 1 — replaces D3's `non_loopback_host` copy. The
      // user is most likely typing a LAN box or public domain over
      // http; point them at the two valid options.
      return 'Server URL must use https:// for non-loopback addresses (or set SILVERHAND_ALLOW_INSECURE_REMOTE=1 for dev use).';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function describeReloadReason(
  reason: Extract<
    DesktopSaveServerUrlResult,
    { kind: 'reload_rejected' }
  >['reason'],
): string {
  switch (reason) {
    case 'not_attached':
      return 'No active daemon connection to refresh — sign in first.';
    case 'config_unreadable':
      return 'Daemon could not read the new config file. Retry the save.';
    case 'parse_failed':
      return 'Daemon rejected the new config bytes. Retry the save.';
    case 'invalid_server_url':
      return 'Daemon rejected the new server URL.';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
