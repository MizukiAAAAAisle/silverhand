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
          title: 'Saved. Reconnected to the server.',
          description: `Verified in ${formatMs(result.elapsedMs)}.`,
        };
      case 'unchanged':
        // No-op write. The bytes were already what the user typed —
        // probably a "saved without changing anything" pass. The
        // copy explicitly avoids claiming connectivity status
        // (the existing connection is whatever it was before).
        return {
          tone: 'info',
          title: 'No changes — the address was already that value.',
          description: '',
        };
      case 'connectivity_unverified':
        // CRITICAL: Cindy `#task:634` review note 1 — this MUST
        // NOT be rendered as "Connected". The user's address is
        // saved (the daemon acked the reload); we just didn't
        // observe the new connection landing within the watchdog
        // budget, which most often means the new server is
        // unreachable. Copy is deliberately "saved" + "reconnecting"
        // so the user knows to either wait or undo the change.
        return {
          tone: 'info',
          title: 'Saved. Reconnecting…',
          description: `No connection was confirmed within ${formatMs(result.elapsedMs)}. The server may still be starting or unreachable.`,
        };
      case 'reloaded_remote':
        // `#task:1021` — REMOTE backend. The address is saved and the
        // daemon spawned a fresh outbound client, but the in-process
        // attachment registry is absent in remote mode (same root cause
        // as the #task:1010 pill), so connectivity isn't observed from
        // main. It IS shown live by the "This computer" indicator (which
        // polls the remote backend's host-status `availability`). Point
        // the user there — do NOT claim "connection check is not
        // available in this mode" (it is, via that indicator). Copy is
        // deliberately direction-free (no "above"/"below"): the banner
        // and the indicator are different sections of ConnectionPane and
        // their relative order can change (Cindy `#task:1021` review P2).
        return {
          tone: 'info',
          title: 'Saved. Reconnecting…',
          description:
            'Watch “This computer” for the live connection status.',
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
    case 'config_write_failed':
      return {
        tone: 'error',
        title: 'Could not save the address.',
        description:
          'Check that Silverhand can write to its app data folder, then try again.',
      };
    case 'reload_rejected': {
      // The raw daemon message is deliberately NOT surfaced: it carries
      // implementation language (daemon / config / parse) that this
      // product surface must not show. The title already names the
      // failure; only retryable reasons get a short next-step line.
      const retryable =
        result.reason === 'config_unreadable' ||
        result.reason === 'parse_failed';
      return {
        tone: 'error',
        title: describeReloadReason(result.reason),
        description: retryable ? 'Try saving the address again.' : '',
      };
    }
    case 'no_attachment_controller':
      // Mode-specific edge: the address was saved but this backend
      // mode lacks a controller to observe the resulting connection.
      // Bytes are saved; verification is structurally impossible. Raw
      // message withheld — it names an internal controller type.
      return {
        tone: 'info',
        title: 'Saved. Connection check is not available in this mode.',
        description: 'The address was saved, but this build cannot verify the connection.',
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
    case 'non_origin_url':
      // D4.a Commit 2 fixup — origin-only invariant (no path / query /
      // fragment). The classifier rejects so probe and persistence
      // cannot drift apart.
      return 'Server URL must be an origin (scheme + host + port). Drop the path / query / fragment.';
    case 'insecure_remote_http_disallowed':
      // D4.a Commit 1 — replaces D3's `non_loopback_host` copy. The
      // user is most likely typing a LAN box or public domain over
      // http; point them at the two valid options.
      return 'Server URL must use https:// for non-loopback addresses (or set SILVERHAND_ALLOW_INSECURE_REMOTE=1 for dev use).';
    case 'obfuscated_loopback_disallowed':
      // D4.a Commit 1 review — disguised loopback form (raw host
      // looks remote but URL parser resolves it to a loopback IP).
      // Tell the user the gate caught the mismatch and what the two
      // legitimate intents are.
      return 'Server URL looks like a disguised loopback address (e.g. 0x7f000001 / [0:0:0:0:0:0:0:1]). Use a literal loopback host (127.0.0.1, localhost, [::1]) if loopback was intended.';
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
      return 'This computer is not connected yet — sign in first.';
    case 'config_unreadable':
      return 'Could not read the saved address. Retry the save.';
    case 'parse_failed':
      return 'Could not apply the saved address. Retry the save.';
    case 'invalid_server_url':
      return 'The saved address was rejected.';
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
