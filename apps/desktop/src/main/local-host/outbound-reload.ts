import { classifyServerUrl } from "@silverhand/shared";
import type { DaemonHostConfig, ServerUrlRejectionReason } from "@silverhand/shared";
import type { OutboundAttachmentSnapshot } from "./outbound-attach.js";
import type { HostOutboundReloadFailureReason, HostOutboundReloadResult } from "@silverhand/host";
import { startAttachWatchdog, type ExpectedAttachWindow } from "./outbound-attach.js";

/**
 * Outcome the IPC handler returns to the renderer. Four success
 * arms (`reloaded` / `unchanged` / `connectivity_unverified` /
 * `reloaded_remote`) and a single failure arm with a discriminated
 * reason. The renderer surfaces user-facing copy keyed off the reason;
 * the message field is diagnostic.
 *
 * Why `connectivity_unverified` is success-arm (not failure):
 *   The daemon DID swap to the new bytes (action: 'reloaded' on the
 *   IPC return). The watchdog timeout means we didn't observe a
 *   fresh backend attachment within the budget — which most often
 *   means the backend is unreachable on the new URL, not that the
 *   save failed. The user's CONFIG has been updated; the
 *   downgraded confirmation tells them so without claiming the
 *   new URL is reachable. Mirrors the D3.a attach watchdog policy
 *   (UI status stays `connecting`; no `connecting_timeout` enum).
 */
export type OutboundReloadOutcome =
  | {
      ok: true;
      kind: "reloaded";
      /** ms from save-start to fresh attachment observed. */
      elapsedMs: number;
      /** `attachedAt` from the fresh attachment, for diagnostics. */
      attachedAt: number;
    }
  | {
      ok: true;
      kind: "unchanged";
    }
  | {
      ok: true;
      kind: "connectivity_unverified";
      /** ms elapsed before the watchdog budget expired. */
      elapsedMs: number;
    }
  | {
      ok: true;
      kind: "reloaded_remote";
    }
  | {
      ok: false;
      kind: "classify_rejected";
      reason: ServerUrlRejectionReason;
      message: string;
    }
  | {
      ok: false;
      kind: "config_write_failed";
      message: string;
    }
  | {
      ok: false;
      kind: "reload_rejected";
      reason: HostOutboundReloadFailureReason;
      message: string;
    }
  | {
      ok: false;
      kind: "no_attachment_controller";
      message: string;
    };

/**
 * Atomic write contract — caller provides a function that writes
 * the new `daemon-config.json` AND fsyncs / renames such that any
 * concurrent reader sees either the old bytes or the new bytes,
 * never a partial. Production binding is
 * `writeDaemonHostConfig(daemonConfigPath, config)` in
 * `local-host-claim.ts`, which already uses tmp + writeFileSync +
 * renameSync with tmp cleanup on error.
 *
 * Throws on write failure (caller surfaces as
 * `config_write_failed`).
 */
export type WriteDaemonHostConfigFn = (config: DaemonHostConfig) => void;

/**
 * Returns a snapshot of the current backend attachment for the
 * given host id, or null when no attachment exists. Production
 * binding is `backend.context.hostWsController()?.getAttachment(id)`.
 * Returning `null` (rather than `undefined`) keeps the contract
 * boring for `attachmentSatisfies`.
 */
export type GetHostAttachmentFn = (hostId: string) => OutboundAttachmentSnapshot | null;

/**
 * IPC binding — `HostClient.hostOutboundReload()` exactly.
 * Decoupled here so unit tests can fake the daemon's response
 * arms without spinning up a real socket.
 */
export type HostOutboundReloadFn = () => Promise<HostOutboundReloadResult>;

export interface PerformOutboundReloadDeps {
  /**
   * Explicit caller-side opt-in for non-loopback http:// remote URLs.
   * This is a client/package policy bit, not profile state; production
   * binds it from the packaged desktop flag / dev env. The accepted
   * value is also stamped into daemon-config so the daemon applies the
   * same local policy during reload/attach.
   */
  allowInsecureRemote?: boolean;
  /** Atomic write to `daemon-config.json`. */
  writeDaemonHostConfig: WriteDaemonHostConfigFn;
  /** Daemon IPC — `HostClient.hostOutboundReload`. */
  hostOutboundReload: HostOutboundReloadFn;
  /** Backend attachment snapshot — `HostWsServerController.getAttachment`. */
  getAttachment: GetHostAttachmentFn | null;
  remoteMode?: boolean;
  /**
   * Returns the local host id this desktop is currently bound to,
   * or null if no claim is active. Reload requires `claimed`; the
   * orchestrator short-circuits with `reload_rejected/not_attached`
   * when null because reload is by-definition a per-host operation.
   */
  currentLocalHostId: () => string | null;
  /**
   * Returns the current `host_token` to persist alongside the new
   * server URL. Pulled lazily so the token never appears in the
   * caller-supplied input (renderer NEVER sends tokens; main owns
   * the bytes). Null when no current attachment.
   */
  currentHostToken: () => string | null;
  currentProfileVersion?: () => number | undefined;
}

export interface PerformOutboundReloadInput {
  /**
   * Raw server URL string the user typed in Settings. NOT trusted —
   * the orchestrator classifies it BEFORE writing anything (anchor 1).
   * Renderer's live validator is convenience, not a security
   * boundary.
   */
  serverUrl: string;
}

export async function performOutboundReload(
  input: PerformOutboundReloadInput,
  deps: PerformOutboundReloadDeps,
): Promise<OutboundReloadOutcome> {
  // 1. Classify raw input. Anchor 1: defense-in-depth on the V1
  //    loopback policy. The renderer also validates, but main MUST
  //    NOT trust renderer-sent values for security-bearing fields.
  const classified = classifyServerUrl(input.serverUrl, {
    allowInsecureRemote: deps.allowInsecureRemote === true,
  });
  if (!classified.ok) {
    return {
      ok: false,
      kind: "classify_rejected",
      reason: classified.reason,
      message: classified.message,
    };
  }
  // 1b. Remote acceptance has landed: the classifier admits
  //     non-loopback https as `kind: 'remote'`, the daemon WS layer
  //     (`hostConnectWebSocketUrl`) converts it to `wss://`, and the
  //     boot path already attaches remote backends. So a classified
  //     remote URL flows straight through to the reload pipeline
  //     below — no Settings-layer short-circuit. Insecure non-loopback
  //     http is still rejected upstream by `classifyServerUrl`
  //     (`classify_rejected` / `insecure_remote_http_disallowed`)
  //     unless the caller explicitly opted this client/build into
  //     insecure remote HTTP, so removing this guard does not open
  //     an insecure hole.

  // 2. Reload precondition — must have a current attachment to
  //    refresh. Missing host id or token means there's nothing to
  //    reload; the daemon would itself reject with `not_attached`
  //    so we short-circuit here without firing the IPC (saves a
  //    round-trip and avoids logging a misleading "reload failed"
  //    when the state is just "user hasn't logged in").
  const hostId = deps.currentLocalHostId();
  const hostToken = deps.currentHostToken();
  if (hostId === null || hostToken === null) {
    return {
      ok: false,
      kind: "reload_rejected",
      reason: "not_attached",
      message:
        hostId === null
          ? "no local host claim — sign in before changing server URL"
          : "no host token in memory — log out + log in to recover",
    };
  }

  // 3. Snapshot BEFORE write. The lower bound must precede every
  //    side-effect that could result in an attachment being
  //    registered server-side, so the watchdog's `attachedAt >=
  //    expectAttachSince` branch is well-defined for ANY observed
  //    attachment that this save could have caused. Mirrors
  //    `captureAttachWindow` in `index.ts` for the attach path.
  const expectAttachSince = Date.now();
  const prevAttachment = deps.getAttachment ? deps.getAttachment(hostId) : null;
  const previousConnectionId = prevAttachment?.connectionId ?? null;

  // 4. Atomic write. `writeDaemonHostConfig` rewrites via tmp file
  //    + renameSync so concurrent readers see either the old bytes
  //    or the new bytes, never a partial. Throws on disk failure;
  //    we surface as `config_write_failed` without firing the
  //    reload IPC (the daemon would either see the OLD bytes and
  //    no-op, or see partial bytes — both wrong outcomes).
  //
  //    The normalized URL from the classifier (which has the `URL`
  //    constructor's normalization applied — e.g. default port
  //    stripping) is preferred over the raw input here. The
  //    classifier's raw-authority loopback check already accepted
  //    the input, and writing the normalized form keeps the
  //    on-disk config tidy across save-after-save cycles.
  const newConfig: DaemonHostConfig = {
    server_url: classified.url.toString(),
    host_id: hostId,
    host_token: hostToken,
    ...(deps.allowInsecureRemote === true ? { allow_insecure_remote: true } : {}),
    // 5c-1 carry-through. Legacy settings:saveServerUrl is not a
    // profile commit, so the daemon's `<none>` ↔ explicit-value
    // distinction must reflect only profile commits — not raw URL
    // edits. When `currentProfileVersion` is unwired (legacy callers
    // / tests), or the on-disk config has no field, omit it so the
    // serialized JSON matches the previous state.
    ...(deps.currentProfileVersion?.() !== undefined
      ? { profile_version: deps.currentProfileVersion!() }
      : {}),
  };
  try {
    deps.writeDaemonHostConfig(newConfig);
  } catch (err) {
    return {
      ok: false,
      kind: "config_write_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 5. Reload IPC. The daemon's response is a tagged union; failure
  //    arms (`not_attached` / `config_unreadable` / `parse_failed`
  //    / `invalid_server_url`) are passed through verbatim so the
  //    renderer can key off the same reason set the daemon defines.
  //    Note: `parse_failed` after our schema-validated write would
  //    indicate a race or external mutation; surfaced as-is for
  //    operator visibility.
  let reload: HostOutboundReloadResult;
  try {
    reload = await deps.hostOutboundReload();
  } catch (err) {
    // Transport-level failure (socket closed, daemon dead). Map to
    // `not_attached` because the user's recovery is the same — we
    // can't reload what's not connected. Caller logs the underlying
    // err for diagnostics.
    return {
      ok: false,
      kind: "reload_rejected",
      reason: "not_attached",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!reload.reloaded) {
    return {
      ok: false,
      kind: "reload_rejected",
      reason: reload.reason,
      message: reload.message ?? reload.reason,
    };
  }

  // 6a. `unchanged` — daemon kept the live client. Skip watchdog;
  //     there's no reconnect to wait for and starting one would
  //     just timeout in `connectivity_unverified` even though the
  //     save was a no-op.
  if (reload.action === "unchanged") {
    return { ok: true, kind: "unchanged" };
  }

  // 6b. `reloaded` — daemon spawned a fresh outbound client.
  //     Watch the backend `HostWsServerController` for the
  //     resulting attachment using the same freshness predicate
  //     `outbound-attach.ts` uses. The watchdog already handles
  //     the two-branch OR (connectionId change OR attachedAt
  //     lower bound) per Cindy's earlier review on D3.a.
  if (!deps.getAttachment) {
    // No in-process attachment registry to watch. Two very different
    // reasons land here:
    if (deps.remoteMode) {
      return { ok: true, kind: "reloaded_remote" };
    }
    // Headless / unsupported edge — no controller AND no indicator to
    // defer to. Caller still saw `reloaded: true` from the daemon, so
    // the config is updated; we just can't verify the WS landed.
    return {
      ok: false,
      kind: "no_attachment_controller",
      message: "backend HostWsServerController unavailable in this mode",
    };
  }
  const window: ExpectedAttachWindow = {
    expectedHostId: hostId,
    previousConnectionId,
    expectAttachSince,
  };
  const watchdog = startAttachWatchdog(window, {
    getAttachment: (id) => (deps.getAttachment ? deps.getAttachment(id) : null),
  });
  const outcome = await watchdog.promise;
  if (outcome.ok) {
    return {
      ok: true,
      kind: "reloaded",
      elapsedMs: outcome.elapsedMs,
      attachedAt: outcome.attachment.attachedAt,
    };
  }
  // Timeout / aborted both surface as `connectivity_unverified` —
  // the daemon swapped, the config is saved; we just don't have
  // observation of the new WS connecting yet. Renderer can show
  // "saved; reconnecting…" without claiming failure.
  return {
    ok: true,
    kind: "connectivity_unverified",
    elapsedMs: outcome.elapsedMs,
  };
}

/**
 * Bind the orchestrator's `GetHostAttachmentFn` dep to a controller
 * snapshot. Returns `null` (NOT a function returning null) when the
 * controller is itself null so the orchestrator's
 * `no_attachment_controller` arm is reachable — Cindy `#task:634`
 * review P2.
 *
 * The naive form `(hostId) => controller?.getAttachment(hostId) ?? null`
 * looks equivalent but is subtly wrong: the orchestrator can't
 * distinguish "controller exists but returns no attachment for this
 * id" from "controller doesn't exist at all", so it always starts
 * the watchdog. When the controller is structurally missing (mode-
 * specific edge), that watchdog polls nothing for its full 10s
 * budget and surfaces as `connectivity_unverified` instead of
 * `no_attachment_controller` — wasting the budget AND lying about
 * what kind of mode-specific edge happened.
 */
export function bindAttachmentAccessor(
  controller: { getAttachment(hostId: string): OutboundAttachmentSnapshot | null } | null,
): GetHostAttachmentFn | null {
  if (controller === null) return null;
  return (hostId) => controller.getAttachment(hostId);
}
