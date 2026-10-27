import type { LocalHostSaveServerUrlResult } from "@silverhand/client";
import { t } from "@/lib/i18n";

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
  result: LocalHostSaveServerUrlResult,
): SaveServerUrlBanner {
  if (result.ok) {
    switch (result.kind) {
      case "reloaded":
        return {
          tone: "success",
          title: t("settings.save.reconnected"),
          description: t("settings.save.verifiedIn", { duration: formatMs(result.elapsedMs) }),
        };
      case "unchanged":
        // No-op write. The bytes were already what the user typed —
        // probably a "saved without changing anything" pass. The
        // copy explicitly avoids claiming connectivity status
        // (the existing connection is whatever it was before).
        return {
          tone: "info",
          title: t("settings.save.unchanged"),
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
          title: t("settings.connection.savedReconnecting"),
          description: t("settings.save.noConfirm", { duration: formatMs(result.elapsedMs) }),
          dismissOnReady: true,
        };
      case "reloaded_remote":
        return {
          tone: "info",
          title: t("settings.connection.savedReconnecting"),
          description: t("settings.save.watchStatus"),
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
        title: t("appShell.unreachable.saveFailed"),
        description: t("settings.save.failedDetail"),
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
        description: retryable ? t("settings.save.tryAgain") : "",
      };
    }
    case "no_attachment_controller":
      // Mode-specific edge: the address was saved but this backend
      // mode lacks a controller to observe the resulting connection.
      // Bytes are saved; verification is structurally impossible. Raw
      // message withheld — it names an internal controller type.
      return {
        tone: "info",
        title: t("settings.save.noCheck"),
        description: t("settings.save.noCheckDetail"),
      };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

function describeClassifyReason(
  reason: Extract<LocalHostSaveServerUrlResult, { kind: "classify_rejected" }>["reason"],
): string {
  switch (reason) {
    case "malformed_url":
      return t("settings.save.malformed");
    case "unsupported_scheme":
      return t("settings.save.scheme");
    case "non_origin_url":
      return t("settings.save.origin");
    case "insecure_remote_http_disallowed":
      return t("settings.save.insecure");
    case "obfuscated_loopback_disallowed":
      return t("settings.save.obfuscated");
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function describeReloadReason(
  reason: Extract<LocalHostSaveServerUrlResult, { kind: "reload_rejected" }>["reason"],
): string {
  switch (reason) {
    case "not_attached":
      return t("settings.save.notAttached");
    case "config_unreadable":
      return t("settings.save.readFailed");
    case "parse_failed":
      return t("settings.save.applyFailed");
    case "invalid_server_url":
      return t("settings.save.rejected");
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
