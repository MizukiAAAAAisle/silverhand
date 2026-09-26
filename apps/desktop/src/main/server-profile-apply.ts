import type { DaemonHostConfig, ServerConnectionProfile } from "@silverhand/shared";
import type { HostOutboundReloadFailureReason, HostOutboundReloadResult } from "@silverhand/host";
import { startAttachWatchdog, type ExpectedAttachWindow } from "./outbound-attach.js";
import type {
  GetHostAttachmentFn,
  HostOutboundReloadFn,
  WriteDaemonHostConfigFn,
} from "./outbound-reload.js";
import type { ReadProfileResult } from "./server-connection-profile.js";

export type ServerProfileApplyOutcome =
  | {
      kind: "fully_applied";
      profileVersion: number;
      reloadKind: "reloaded" | "unchanged" | "connectivity_unverified";
      /** ms elapsed in the observable phase (write → IPC → watchdog),
       *  for diagnostic logging. */
      elapsedMs: number;
    }
  | {
      kind: "no_op_no_host_claim";
      profileVersion: number;
    }
  | {
      kind: "partial_apply_pending";
      profileVersion: number;
      reason:
        | "config_write_failed"
        | "reload_rejected"
        | "no_attachment_controller"
        | "host_token_missing";
      /** Surfaces the daemon's reload-rejection reason verbatim when
       *  applicable (`reason: 'reload_rejected'`); for write/no-controller/
       *  host-token-missing arms this is null. */
      reloadRejectionReason: HostOutboundReloadFailureReason | null;
      /** Operator-readable detail string. Renderer surfaces a copy
       *  derived from `reason`; this is the diagnostic content. */
      detail: string;
    };

export interface ApplyServerProfileInput {
  /** The profile that was just committed (post-`writeServerConnectionProfile`).
   *  The version field MUST be the freshly-committed generation. */
  profile: ServerConnectionProfile;
}

export interface ApplyServerProfileDeps {
  /** Local desktop/package policy bit for non-loopback http:// remote
   *  URLs. Not profile state; profile application stamps it into daemon-config so
   *  the daemon validates reload/attach with the same local opt-in that
   *  admitted the profile. */
  allowInsecureRemote?: boolean;
  /** Atomic write to `daemon-config.json`. Production binding is
   *  `writeDaemonHostConfig(daemonConfigPath, config)`. */
  writeDaemonHostConfig: WriteDaemonHostConfigFn;
  /** Daemon IPC — `HostClient.hostOutboundReload`. */
  hostOutboundReload: HostOutboundReloadFn;
  /** Backend attachment snapshot — `HostWsServerController.getAttachment`.
   *  Null when the controller is not available in this mode (matches
   *  the legacy reload orchestrator semantics). */
  getAttachment: GetHostAttachmentFn | null;
  /** Returns the local host id this desktop is currently bound to,
   *  or null when no claim is active. Profile application short-circuits with
   *  `no_op_no_host_claim` (NOT `partial_apply_pending`) when null —
   *  this is genuinely the pre-auth path (no claim, nothing stale to
   *  reconcile). Cindy 5c-2 review P1: distinct from
   *  `currentHostToken === null`, which IS partial_apply_pending. */
  currentLocalHostId: () => string | null;
  /** Returns the current `host_token` to persist alongside the new
   *  server URL. Pulled lazily so the token never appears in caller-
   *  supplied input. Null when daemon-config is missing/corrupt or
   *  has no token field — combined with a non-null `currentLocalHostId`,
   *  this surfaces as `partial_apply_pending/host_token_missing`. */
  currentHostToken: () => string | null;
}

export async function applyServerProfile(
  input: ApplyServerProfileInput,
  deps: ApplyServerProfileDeps,
): Promise<ServerProfileApplyOutcome> {
  const startedAt = Date.now();
  const profileVersion = input.profile.version;

  // Pre-auth path: no host claim → nothing to reload AND nothing
  // stale to reconcile. Setup Wizard commits the profile before
  // sign-in; the next claim picks up the profile naturally via 5c-1.
  // Distinct from `partial_apply_pending` because there is no
  // inconsistency between profile and daemon-config — we just
  // haven't created daemon-config yet.
  //
  const hostId = deps.currentLocalHostId();
  if (hostId === null) {
    return { kind: "no_op_no_host_claim", profileVersion };
  }

  const hostToken = deps.currentHostToken();
  if (hostToken === null) {
    return {
      kind: "partial_apply_pending",
      profileVersion,
      reason: "host_token_missing",
      reloadRejectionReason: null,
      detail: "no host token in daemon-config for claimed host",
    };
  }

  const expectAttachSince = startedAt;
  const prevAttachment = deps.getAttachment ? deps.getAttachment(hostId) : null;
  const previousConnectionId = prevAttachment?.connectionId ?? null;

  const newConfig: DaemonHostConfig = {
    server_url: input.profile.server_url,
    host_id: hostId,
    host_token: hostToken,
    profile_version: profileVersion,
    ...(deps.allowInsecureRemote === true ? { allow_insecure_remote: true } : {}),
  };
  try {
    deps.writeDaemonHostConfig(newConfig);
  } catch (err) {
    return {
      kind: "partial_apply_pending",
      profileVersion,
      reason: "config_write_failed",
      reloadRejectionReason: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Reload IPC. Daemon's response arms (`not_attached` /
  // `config_unreadable` / `parse_failed` / `invalid_server_url`)
  // pass through verbatim so the renderer can key off the same
  // reason set the daemon defines.
  let reload: HostOutboundReloadResult;
  try {
    reload = await deps.hostOutboundReload();
  } catch (err) {
    // Transport-level failure (socket closed, daemon dead). Treat as
    // partial_apply_pending — daemon-config IS written but daemon
    // didn't ack the swap.
    return {
      kind: "partial_apply_pending",
      profileVersion,
      reason: "reload_rejected",
      reloadRejectionReason: "not_attached",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!reload.reloaded) {
    return {
      kind: "partial_apply_pending",
      profileVersion,
      reason: "reload_rejected",
      reloadRejectionReason: reload.reason,
      detail: reload.message ?? reload.reason,
    };
  }

  // `unchanged` — daemon's fingerprint matched, no swap. This means
  // the previous config already had this profile_version (e.g. user
  // saved Settings with the same URL twice). Still `fully_applied`.
  if (reload.action === "unchanged") {
    return {
      kind: "fully_applied",
      profileVersion,
      reloadKind: "unchanged",
      elapsedMs: Date.now() - startedAt,
    };
  }

  // `reloaded` — daemon spawned a fresh outbound client. Watch the
  // backend `HostWsServerController` for the resulting attachment
  // using the same freshness predicate `outbound-attach.ts` uses.
  if (!deps.getAttachment) {
    return {
      kind: "partial_apply_pending",
      profileVersion,
      reason: "no_attachment_controller",
      reloadRejectionReason: null,
      detail: "backend HostWsServerController unavailable in this mode",
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
      kind: "fully_applied",
      profileVersion,
      reloadKind: "reloaded",
      elapsedMs: Date.now() - startedAt,
    };
  }
  // Watchdog timeout / abort — daemon swapped, config is saved, we
  // just couldn't observe the new attachment within the budget.
  // Same downgrade-to-success as the legacy reload path uses (per
  // `outbound-reload.ts` `connectivity_unverified` rationale): the
  // user's CONFIG is updated; the new URL just may not be reachable
  // yet, which is a separate diagnostic concern. NOT
  // `partial_apply_pending`.
  return {
    kind: "fully_applied",
    profileVersion,
    reloadKind: "connectivity_unverified",
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Four kinds:
 *   - `fully_applied` — profile + daemon-config in sync at this
 *     generation, OR there is genuinely nothing to reconcile (e.g.
 *     pre-claim). No banner.
 *   - `no_profile` — no profile is committed (Setup Wizard never
 *     completed, or `profile:clear` was invoked). Distinct from
 *     `fully_applied` for telemetry / future UX even though both
 *     render no banner today.
 *   - `unusable_profile` — profile file exists but the storage layer
 *     could not parse it (`parse_failed`). Cindy 5c-1 review note: profile read
 *     failure ≠ profile absent — the typed repair state must
 *     surface so the renderer offers a "reset profile" affordance
 *     instead of pretending the profile is in-sync.
 *   - `partial_apply_pending` — profile present, daemon drifted (or
 *     profile application IPC failed). Renderer surfaces banner + Retry button.
 */
export type PartialApplyState =
  | { kind: "fully_applied" }
  | { kind: "no_profile" }
  | {
      kind: "unusable_profile";
      reason: "parse_failed";
      detail: string;
      lastReadAt: number;
    }
  | {
      kind: "partial_apply_pending";
      profileVersion: number;
      reason:
        | "config_write_failed"
        | "reload_rejected"
        | "no_attachment_controller"
        | "host_token_missing";
      reloadRejectionReason: HostOutboundReloadFailureReason | null;
      detail: string;
      lastAttemptAt: number;
    };

export function derivePartialApplyState(
  outcome: ServerProfileApplyOutcome,
  attemptedAt: number,
): PartialApplyState {
  if (outcome.kind === "partial_apply_pending") {
    return {
      kind: "partial_apply_pending",
      profileVersion: outcome.profileVersion,
      reason: outcome.reason,
      reloadRejectionReason: outcome.reloadRejectionReason,
      detail: outcome.detail,
      lastAttemptAt: attemptedAt,
    };
  }
  return { kind: "fully_applied" };
}

export interface ReconcilePartialApplyDeps {
  readProfile: () => ReadProfileResult;
  readDaemonHostConfig: () => DaemonHostConfig | null;
  applyProfile: (profile: ServerConnectionProfile) => Promise<ServerProfileApplyOutcome>;
}

export async function reconcilePartialApplyAtBoot(
  deps: ReconcilePartialApplyDeps,
): Promise<PartialApplyState> {
  const read = deps.readProfile();
  if (!read.ok) {
    if (read.reason === "not_found") {
      return { kind: "no_profile" };
    }
    return {
      kind: "unusable_profile",
      reason: read.reason,
      detail: read.detail,
      lastReadAt: Date.now(),
    };
  }
  const profile = read.profile;
  const daemonConfig = deps.readDaemonHostConfig();

  if (daemonConfig !== null && daemonConfig.profile_version === profile.version) {
    return { kind: "fully_applied" };
  }

  const outcome = await deps.applyProfile(profile);
  return derivePartialApplyState(outcome, Date.now());
}
