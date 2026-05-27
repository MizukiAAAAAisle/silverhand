/**
 * D4.a Commit 5c-2 — phase-2 orchestrator triggered by a profile commit.
 *
 * Per `docs/remote-backend-d4-design.md` §7.5:
 *
 *   When user updates `server_url` from Settings:
 *     Phase 0 — validate (`probeServerInfo` — owned by the IPC caller)
 *     Phase 1 — commit profile (`writeServerConnectionProfile`)
 *     Phase 2 — derive daemon-config and reload [THIS MODULE]
 *       - Build new daemon-config from
 *         `{profile.version, profile.server_url, host_id, host_token}`
 *       - Write daemon-config to temp file, fsync, rename.
 *       - Send `host_outbound_reload` IPC to daemon.
 *       - Await daemon's reload ack frame.
 *
 * Failure handling for phase 2 (§7.5):
 *
 *   If phase 2 fails (daemon-config write / IPC / reload ack any step):
 *   profile is **already** at the new version, daemon is **still**
 *   running on the old config. Mark in-memory desktop state
 *   `partial_apply_pending = true`. Recovery is exposed via:
 *     - User-driven Retry button → re-run phase 2.
 *     - Desktop restart → reconciliation pass at boot (5c-3).
 *     - Daemon restart → supervisor re-derives daemon-config from
 *       current profile.
 *
 * Distinct from `performOutboundReload` (the legacy
 * settings:saveServerUrl path) in three ways:
 *
 *   1. Input is a {@link ServerConnectionProfile}, not a raw user URL.
 *      The profile has already been classified (origin-only invariant
 *      §7.1) and committed atomically by `writeServerConnectionProfile`,
 *      so this orchestrator does NOT re-classify or re-validate.
 *
 *   2. The daemon-config bumps `profile_version` to `profile.version`
 *      (5b additive field). 5b's fingerprint inclusion guarantees a
 *      version-only change still triggers a real reload.
 *
 *   3. No `currentProfileVersion` carry-through dep — phase-2 BY
 *      DEFINITION sets `profile_version` to the freshly committed
 *      profile.version, never preserves an older value.
 *
 * Pre-auth Setup Wizard scenario: when no host claim exists yet
 * (`currentLocalHostId() === null`), phase-2 returns the
 * `no_op_no_host_claim` arm. The next sign-in's
 * `claimLocalHostForUserSession` (5c-1) reads the just-committed
 * profile and stamps `profile_version` into the daemon-config it
 * writes — natural convergence, no `partial_apply_pending` state
 * because there was nothing to reconcile.
 */
import type {
  DaemonHostConfig,
  ServerConnectionProfile,
} from '@silverhand/shared';
import type { HostWsAttachment } from '@silverhand/backend';
import type {
  HostOutboundReloadFailureReason,
  HostOutboundReloadResult,
} from '@silverhand/host';
import {
  startAttachWatchdog,
  type AttachWatchdogDeps,
  type AttachWatchdogOutcome,
  type ExpectedAttachWindow,
} from './outbound-attach.js';
import type {
  GetHostAttachmentFn,
  HostOutboundReloadFn,
  WriteDaemonHostConfigFn,
} from './outbound-reload.js';

/**
 * Outcome of one phase-2 attempt.
 *
 * **`kind: 'fully_applied'`** — the daemon's view (running config) is
 * now at `profile.version`. Three sub-arms reflect the reload IPC
 * action plus the post-IPC connectivity observation, but all three
 * mean "config and daemon are in sync at this generation":
 *
 *   - `reloaded` — daemon swapped to fresh bytes, watchdog observed
 *     a fresh outbound attachment.
 *   - `unchanged` — daemon kept the live client (fingerprint
 *     identical; no swap needed).
 *   - `connectivity_unverified` — daemon swapped, watchdog timed
 *     out before observing the new attachment. The CONFIG is in
 *     sync; reachability is the user's next problem (matches the
 *     §7.5 "save successful + connection re-establishing" UX).
 *
 * **`kind: 'no_op_no_host_claim'`** — there is no current host claim
 * (Setup Wizard pre-auth, or post-revoke / pre-relogin where the
 * `localHostClaim` is no longer `claimed`). Phase-2 cannot run because
 * there is no claimed host id to anchor a daemon-config to. This is
 * NOT `partial_apply_pending` — there is nothing to reconcile; the
 * next sign-in's `claimLocalHostForUserSession` naturally picks up
 * the profile.
 *
 * **`kind: 'partial_apply_pending'`** — phase-2 failed at one of
 * write / IPC / ack / token-lookup. Profile is at the new version;
 * daemon is at the previous version. Caller MUST set in-memory state
 * so the renderer banner + Retry button surface, and so the next
 * desktop restart's reconciliation pass (5c-3) re-attempts.
 *
 * The `host_token_missing` reason — distinct from
 * `no_op_no_host_claim` — surfaces when we DO have a claimed host id
 * but daemon-config is missing/corrupt/unreadable so we can't recover
 * the host token. The profile commit upstream already landed, so
 * collapsing this to "fully_applied" would silently mask the daemon
 * still running on the previous-generation config. The Retry path
 * (which re-reads daemon-config) or 5c-3 boot reconciliation is the
 * convergence route. Cindy 5c-2 review P1.
 */
export type ProfilePhase2Outcome =
  | {
      kind: 'fully_applied';
      profileVersion: number;
      reloadKind: 'reloaded' | 'unchanged' | 'connectivity_unverified';
      /** ms elapsed in the observable phase (write → IPC → watchdog),
       *  for diagnostic logging. */
      elapsedMs: number;
    }
  | {
      kind: 'no_op_no_host_claim';
      profileVersion: number;
    }
  | {
      kind: 'partial_apply_pending';
      profileVersion: number;
      reason:
        | 'config_write_failed'
        | 'reload_rejected'
        | 'no_attachment_controller'
        | 'host_token_missing';
      /** Surfaces the daemon's reload-rejection reason verbatim when
       *  applicable (`reason: 'reload_rejected'`); for write/no-controller/
       *  host-token-missing arms this is null. */
      reloadRejectionReason: HostOutboundReloadFailureReason | null;
      /** Operator-readable detail string. Renderer surfaces a copy
       *  derived from `reason`; this is the diagnostic content. */
      detail: string;
    };

export interface PerformProfilePhase2Input {
  /** The profile that was just committed (post-`writeServerConnectionProfile`).
   *  The version field MUST be the freshly-committed generation. */
  profile: ServerConnectionProfile;
}

export interface PerformProfilePhase2Deps {
  /** Atomic write to `daemon-config.json`. Production binding is
   *  `writeDaemonHostConfig(silverhandDir, config)`. */
  writeDaemonHostConfig: WriteDaemonHostConfigFn;
  /** Daemon IPC — `HostClient.hostOutboundReload`. */
  hostOutboundReload: HostOutboundReloadFn;
  /** Backend attachment snapshot — `HostWsServerController.getAttachment`.
   *  Null when the controller is not available in this mode (matches
   *  the legacy reload orchestrator semantics). */
  getAttachment: GetHostAttachmentFn | null;
  /** Returns the local host id this desktop is currently bound to,
   *  or null when no claim is active. Phase-2 short-circuits with
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
  /** Test seam for `startAttachWatchdog`. Production passes
   *  `startAttachWatchdog` from `outbound-attach.ts`; tests supply a
   *  fake that resolves deterministically. */
  startWatchdog?: (
    window: ExpectedAttachWindow,
    watchdogDeps: AttachWatchdogDeps,
  ) => { promise: Promise<AttachWatchdogOutcome>; abort(): void };
  /** Test clock; defaults to `Date.now`. */
  now?: () => number;
  /** Watchdog tuning — defaults match `outbound-attach.ts` (250ms / 10s). */
  watchdogPollIntervalMs?: number;
  watchdogTimeoutMs?: number;
}

export async function performProfilePhase2(
  input: PerformProfilePhase2Input,
  deps: PerformProfilePhase2Deps,
): Promise<ProfilePhase2Outcome> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const profileVersion = input.profile.version;

  // Pre-auth path: no host claim → nothing to reload AND nothing
  // stale to reconcile. Setup Wizard commits the profile before
  // sign-in; the next claim picks up the profile naturally via 5c-1.
  // Distinct from `partial_apply_pending` because there is no
  // inconsistency between profile and daemon-config — we just
  // haven't created daemon-config yet.
  //
  // Cindy 5c-2 fixup nit — read `hostId` first and short-circuit
  // BEFORE touching `currentHostToken()`. The pre-auth path then
  // makes literally zero `daemon-config.json` reads, which keeps
  // this branch safe to call from contexts where daemon-config is
  // structurally absent (no claim ever happened).
  const hostId = deps.currentLocalHostId();
  if (hostId === null) {
    return { kind: 'no_op_no_host_claim', profileVersion };
  }
  // Claimed host but no token in daemon-config (missing / corrupt /
  // partial-write). The profile is durable at the new generation;
  // the daemon (if running) is on the previous-generation config.
  // This is structurally `partial_apply_pending` — collapsing it to
  // `no_op_no_host_claim` (and thence `fully_applied`) would silently
  // mask real drift between profile and daemon. Convergence routes:
  // (a) Retry — re-reads daemon-config, may pick up a freshly-rotated
  // token; (b) 5c-3 boot reconciliation — re-derives state from
  // profile.version vs daemon-config.profile_version; (c) explicit
  // user re-login — refreshes daemon-config via `claimLocalHost
  // ForUserSession`. Cindy 5c-2 review P1.
  const hostToken = deps.currentHostToken();
  if (hostToken === null) {
    return {
      kind: 'partial_apply_pending',
      profileVersion,
      reason: 'host_token_missing',
      reloadRejectionReason: null,
      detail: 'no host token in daemon-config for claimed host',
    };
  }

  // Snapshot BEFORE write. The lower bound must precede every
  // side-effect that could result in an attachment being registered
  // server-side, so the watchdog's `attachedAt >= expectAttachSince`
  // branch is well-defined for ANY observed attachment that this
  // phase-2 could have caused. Mirrors the freshness contract in
  // `outbound-reload.ts` (D3.a Commit 4).
  const expectAttachSince = startedAt;
  const prevAttachment = deps.getAttachment ? deps.getAttachment(hostId) : null;
  const previousConnectionId = prevAttachment?.connectionId ?? null;

  // Build daemon-config FROM the profile. `profile_version` is set
  // unconditionally to `profile.version` — this orchestrator is the
  // only path that bumps that field. `profile.server_url` is already
  // canonical (origin-only, classifier-validated at write time per
  // §7.1 + 5a canonical-on-write), so no re-normalization here.
  const newConfig: DaemonHostConfig = {
    server_url: input.profile.server_url,
    host_id: hostId,
    host_token: hostToken,
    profile_version: profileVersion,
  };
  try {
    deps.writeDaemonHostConfig(newConfig);
  } catch (err) {
    return {
      kind: 'partial_apply_pending',
      profileVersion,
      reason: 'config_write_failed',
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
      kind: 'partial_apply_pending',
      profileVersion,
      reason: 'reload_rejected',
      reloadRejectionReason: 'not_attached',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!reload.reloaded) {
    return {
      kind: 'partial_apply_pending',
      profileVersion,
      reason: 'reload_rejected',
      reloadRejectionReason: reload.reason,
      detail: reload.message ?? reload.reason,
    };
  }

  // `unchanged` — daemon's fingerprint matched, no swap. This means
  // the previous config already had this profile_version (e.g. user
  // saved Settings with the same URL twice). Still `fully_applied`.
  if (reload.action === 'unchanged') {
    return {
      kind: 'fully_applied',
      profileVersion,
      reloadKind: 'unchanged',
      elapsedMs: now() - startedAt,
    };
  }

  // `reloaded` — daemon spawned a fresh outbound client. Watch the
  // backend `HostWsServerController` for the resulting attachment
  // using the same freshness predicate `outbound-attach.ts` uses.
  if (!deps.getAttachment) {
    // No controller (mode-specific edge — e.g. headless test, or
    // standalone mode with no embedded backend yet). Daemon DID
    // ack reload; we just can't verify the WS landed. We treat
    // this as `partial_apply_pending/no_attachment_controller` to
    // match the 5c-2 contract: "we couldn't observe the post-reload
    // state". The legacy `outbound-reload.ts` path treats the same
    // edge as a typed failure (`no_attachment_controller`) — keeping
    // semantic parity here.
    return {
      kind: 'partial_apply_pending',
      profileVersion,
      reason: 'no_attachment_controller',
      reloadRejectionReason: null,
      detail: 'backend HostWsServerController unavailable in this mode',
    };
  }
  const window: ExpectedAttachWindow = {
    expectedHostId: hostId,
    previousConnectionId,
    expectAttachSince,
  };
  const startWatchdog = deps.startWatchdog ?? startAttachWatchdog;
  const watchdog = startWatchdog(window, {
    getAttachment: id =>
      deps.getAttachment ? deps.getAttachment(id) : null,
    pollIntervalMs: deps.watchdogPollIntervalMs,
    timeoutMs: deps.watchdogTimeoutMs,
    now,
  });
  const outcome = await watchdog.promise;
  if (outcome.ok) {
    return {
      kind: 'fully_applied',
      profileVersion,
      reloadKind: 'reloaded',
      elapsedMs: now() - startedAt,
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
    kind: 'fully_applied',
    profileVersion,
    reloadKind: 'connectivity_unverified',
    elapsedMs: now() - startedAt,
  };
}

/**
 * In-memory state describing whether the desktop's view of the
 * profile has been fully applied to the daemon's running config.
 *
 * Lives on the desktop main process only — NOT serialized to disk
 * (the source of truth is the comparison `profile.version` vs
 * `daemon-config.profile_version`, which 5c-3 reconciliation uses on
 * boot to re-derive this state). NOT crossed into the wire / daemon
 * protocol per §7.6.
 *
 * Initial value is `{ kind: 'fully_applied' }`. Phase-2 transitions
 * it to `partial_apply_pending` on failure; a successful Retry or
 * boot reconciliation transitions it back.
 */
export type PartialApplyPendingState =
  | { kind: 'fully_applied' }
  | {
      kind: 'partial_apply_pending';
      profileVersion: number;
      reason:
        | 'config_write_failed'
        | 'reload_rejected'
        | 'no_attachment_controller'
        | 'host_token_missing';
      reloadRejectionReason: HostOutboundReloadFailureReason | null;
      detail: string;
      lastAttemptAt: number;
    };

/**
 * Deriver: from a phase-2 outcome + the wall clock, compute the
 * partial-apply state to set. `no_op_no_host_claim` and any
 * `fully_applied` arm collapse to `{ kind: 'fully_applied' }`;
 * `partial_apply_pending` arms carry through with a fresh
 * `lastAttemptAt`.
 *
 * Pulled out as a pure helper so the IPC handler + the boot-time
 * reconciliation (5c-3) compute the same state from the same input.
 */
export function derivePartialApplyState(
  outcome: ProfilePhase2Outcome,
  attemptedAt: number,
): PartialApplyPendingState {
  if (outcome.kind === 'partial_apply_pending') {
    return {
      kind: 'partial_apply_pending',
      profileVersion: outcome.profileVersion,
      reason: outcome.reason,
      reloadRejectionReason: outcome.reloadRejectionReason,
      detail: outcome.detail,
      lastAttemptAt: attemptedAt,
    };
  }
  return { kind: 'fully_applied' };
}
