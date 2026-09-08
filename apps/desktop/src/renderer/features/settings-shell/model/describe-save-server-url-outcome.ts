import type { DesktopSaveServerUrlResult } from "../../../../preload/api";

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
  tone: "success" | "info" | "error";
  /** Short headline. Imperative or status-form (≤ ~60 chars). */
  title: string;
  /**
   * Optional diagnostic sub-line. Empty string when the title is
   * already self-contained — callers can `description &&` to skip
   * the second row.
   */
  description: string;
  /**
   * The saved config is waiting for a live readiness proof. Surfaces
   * that observe a separate connection-state signal may dismiss this
   * banner once that signal reports Ready for the current save.
   */
  dismissOnReady?: true;
}

export function describeSaveServerUrlOutcome(
  result: DesktopSaveServerUrlResult,
): SaveServerUrlBanner {
  if (result.ok) {
    switch (result.kind) {
      case "reloaded":
        return {
          tone: "success",
          title: "Saved. Reconnected to the server.",
          description: `Verified in ${formatMs(result.elapsedMs)}.`,
        };
      case "unchanged":
        // No-op write. The bytes were already what the user typed —
        // probably a "saved without changing anything" pass. The
        // copy explicitly avoids claiming connectivity status
        // (the existing connection is whatever it was before).
        return {
          tone: "info",
          title: "No changes — the address was already that value.",
          description: "",
        };
      case "connectivity_unverified":
        // CRITICAL: Cindy `#task:634` review note 1 — this MUST
        // NOT be rendered as "Connected". The user's address is
        // saved (the daemon acked the reload); we just didn't
        // observe the new connection landing within the watchdog
        // budget, which most often means the new server is
        // unreachable. Copy is deliberately "saved" + "reconnecting"
        // so the user knows to either wait or undo the change.
        return {
          tone: "info",
          title: "Saved. Reconnecting…",
          description: `No connection was confirmed within ${formatMs(result.elapsedMs)}. The server may still be starting or unreachable.`,
          dismissOnReady: true,
        };
      case "reloaded_remote":
        return {
          tone: "info",
          title: "Saved. Reconnecting…",
          description: "Watch “This computer” for the live connection status.",
          dismissOnReady: true,
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
    case "classify_rejected":
      return {
        tone: "error",
        title: describeClassifyReason(result.reason),
        // Surface the classifier's raw message — it carries the
        // specific token that failed (e.g. the obfuscated IP, the
        // unsupported scheme name) which the per-reason headline
        // can't include without runtime substitution.
        description: result.message,
      };
    case "config_write_failed":
      return {
        tone: "error",
        title: "Could not save the address.",
        description: "Check that Silverhand can write to its app data folder, then try again.",
      };
    case "reload_rejected": {
      // The raw daemon message is deliberately NOT surfaced: it carries
      // implementation language (daemon / config / parse) that this
      // product surface must not show. The title already names the
      // failure; only retryable reasons get a short next-step line.
      const retryable = result.reason === "config_unreadable" || result.reason === "parse_failed";
      return {
        tone: "error",
        title: describeReloadReason(result.reason),
        description: retryable ? "Try saving the address again." : "",
      };
    }
    case "no_attachment_controller":
      // Mode-specific edge: the address was saved but this backend
      // mode lacks a controller to observe the resulting connection.
      // Bytes are saved; verification is structurally impossible. Raw
      // message withheld — it names an internal controller type.
      return {
        tone: "info",
        title: "Saved. Connection check is not available in this mode.",
        description: "The address was saved, but this build cannot verify the connection.",
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function describeClassifyReason(
  reason: Extract<DesktopSaveServerUrlResult, { kind: "classify_rejected" }>["reason"],
): string {
  switch (reason) {
    case "malformed_url":
      return "Server URL is not a valid URL.";
    case "unsupported_scheme":
      return "Server URL must start with http:// or https://.";
    case "non_origin_url":
      return "Server URL must be an origin (scheme + host + port). Drop the path / query / fragment.";
    case "insecure_remote_http_disallowed":
      return "Server URL must use https:// for non-loopback addresses (or set SILVERHAND_ALLOW_INSECURE_REMOTE=1 for dev use).";
    case "obfuscated_loopback_disallowed":
      return "Server URL looks like a disguised loopback address (e.g. 0x7f000001 / [0:0:0:0:0:0:0:1]). Use a literal loopback host (127.0.0.1, localhost, [::1]) if loopback was intended.";
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function describeReloadReason(
  reason: Extract<DesktopSaveServerUrlResult, { kind: "reload_rejected" }>["reason"],
): string {
  switch (reason) {
    case "not_attached":
      return "This computer is not connected yet — sign in first.";
    case "config_unreadable":
      return "Could not read the saved address. Retry the save.";
    case "parse_failed":
      return "Could not apply the saved address. Retry the save.";
    case "invalid_server_url":
      return "The saved address was rejected.";
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
