/**
 * Stage D3.c Commit 3 — desktop main orchestrator for the Settings
 * "save server URL" flow.
 *
 * Background:
 *   Pre-D3.c, the desktop bootstrapped the outbound WS exactly once
 *   per login via `host_outbound_attach` (D3.a Commit 4) and never
 *   revisited that decision until the next login. D3.c adds a
 *   Settings affordance where the user edits the server URL (V1:
 *   loopback only) and saves — which has to atomically rewrite
 *   `daemon-config.json` AND inform the daemon to swap to the new
 *   bytes AND verify a fresh attachment landed at the backend, all
 *   without taking down the in-flight outbound on a typo / network
 *   blip / bad bytes.
 *
 *   D3.c Commit 2 already shipped the `host_outbound_reload` daemon
 *   IPC: stat-first safe-read, validate-first-then-swap, no silent
 *   fallback to attach, fingerprint-aware `unchanged` arm. This
 *   orchestrator wires it into the desktop Settings save path
 *   without leaking the lifecycle bookkeeping (snapshot before
 *   write, watchdog after `action: 'reloaded'`, skip watchdog on
 *   `action: 'unchanged'`) into renderer-visible code.
 *
 * What this module owns:
 *   - The "save Settings" pipeline as a SINGLE pure function with
 *     injected deps — every fan-out point (classify / atomic-write /
 *     IPC / watchdog) is a dep so the same orchestration logic is
 *     unit-tested end-to-end without touching disk / WS / IPC.
 *   - The typed `OutboundReloadOutcome` discriminated union exposed
 *     to the IPC handler in `index.ts`.
 *
 * What this module does NOT own:
 *   - The actual IPC handler (`index.ts` registers it and supplies
 *     real deps — `hostClient.hostOutboundReload`, real
 *     `writeDaemonHostConfig`, real `HostWsServerController.getAttachment`).
 *   - Renderer Settings UI (Commit 4 lands separately).
 *   - The user-facing `local_host_status` enum — this orchestrator's
 *     outcome is a diagnostic / save-confirmation signal, not a
 *     status mutation. The 5-value `local_host_status` enum is fed
 *     by the supervisor's restart-budget classifier only (per
 *     `local-host-claim.ts` Stage B.4 lock + D3.a/D3.d scope note).
 *
 * Three review anchors Cindy named for D3.c final (#task:634):
 *   1. raw input classify in main BEFORE atomic write — defense in
 *      depth (renderer also validates, but main must not trust it).
 *   2. atomic write BEFORE reload IPC — reload must never read a
 *      partial write. Reused via `writeDaemonHostConfig` which
 *      already does tmp + writeFileSync(0o600) + renameSync with
 *      tmp cleanup on error.
 *   3. reload `action: 'reloaded'` is NOT proof of connectivity —
 *      caller MUST await a fresh attachment via the same predicate
 *      `attachmentSatisfies` used at attach time (D3.a Commit 4).
 *      `action: 'unchanged'` skips the watchdog because the daemon
 *      kept the live client (no swap → no reconnect to wait for).
 */
import type {
  DaemonHostConfig,
  ServerUrlClassification,
  ServerUrlRejectionReason,
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

/**
 * Outcome the IPC handler returns to the renderer. Three success
 * arms (`reloaded` / `unchanged` / `connectivity_unverified`) and a
 * single failure arm with a discriminated reason. The renderer
 * surfaces user-facing copy keyed off the reason; the message field
 * is diagnostic.
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
      kind: 'reloaded';
      /** ms from save-start to fresh attachment observed. */
      elapsedMs: number;
      /** `attachedAt` from the fresh attachment, for diagnostics. */
      attachedAt: number;
    }
  | {
      ok: true;
      kind: 'unchanged';
    }
  | {
      ok: true;
      kind: 'connectivity_unverified';
      /** ms elapsed before the watchdog budget expired. */
      elapsedMs: number;
    }
  | {
      ok: false;
      kind: 'classify_rejected';
      /** Mirrors `ServerUrlClassification` failure reasons so the
       *  renderer can key off the same set the live input validator
       *  does. */
      reason: ServerUrlRejectionReason;
      message: string;
    }
  | {
      ok: false;
      kind: 'config_write_failed';
      message: string;
    }
  | {
      ok: false;
      kind: 'reload_rejected';
      reason: HostOutboundReloadFailureReason;
      message: string;
    }
  | {
      ok: false;
      kind: 'no_attachment_controller';
      message: string;
    };

/**
 * Atomic write contract — caller provides a function that writes
 * the new `daemon-config.json` AND fsyncs / renames such that any
 * concurrent reader sees either the old bytes or the new bytes,
 * never a partial. Production binding is
 * `writeDaemonHostConfig(silverhandDir, config)` in
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
export type GetHostAttachmentFn = (
  hostId: string,
) => HostWsAttachment | null;

/**
 * IPC binding — `HostClient.hostOutboundReload()` exactly.
 * Decoupled here so unit tests can fake the daemon's response
 * arms without spinning up a real socket.
 */
export type HostOutboundReloadFn = () => Promise<HostOutboundReloadResult>;

/**
 * URL classifier binding — `classifyServerUrl` from
 * `@silverhand/shared`. Pulled as a dep so tests can swap in a
 * fixed-response fake; production callers always pass the real
 * function.
 */
export type ClassifyServerUrlFn = (input: string) => ServerUrlClassification;

export interface PerformOutboundReloadDeps {
  /** D3.c-1 shared classifier, defense-in-depth on raw input. */
  classifyServerUrl: ClassifyServerUrlFn;
  /** Atomic write to `daemon-config.json`. */
  writeDaemonHostConfig: WriteDaemonHostConfigFn;
  /** Daemon IPC — `HostClient.hostOutboundReload`. */
  hostOutboundReload: HostOutboundReloadFn;
  /** Backend attachment snapshot — `HostWsServerController.getAttachment`. */
  getAttachment: GetHostAttachmentFn | null;
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
  /**
   * Test seam for `startAttachWatchdog`. Production passes
   * `startAttachWatchdog` from `outbound-attach.ts`; tests supply a
   * fake that resolves deterministically.
   */
  startWatchdog?: (
    window: ExpectedAttachWindow,
    watchdogDeps: AttachWatchdogDeps,
  ) => { promise: Promise<AttachWatchdogOutcome>; abort(): void };
  /** Test clock; defaults to `Date.now`. */
  now?: () => number;
  /** Watchdog tuning. Defaults match `outbound-attach.ts` (250ms / 10s). */
  watchdogPollIntervalMs?: number;
  watchdogTimeoutMs?: number;
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

/**
 * The orchestrator. Pure-ish: side effects flow through deps. The
 * sequence is strict — each step's success is a precondition for
 * the next, and the snapshot for the freshness predicate is
 * captured BEFORE the atomic write (anchor 3 cross-references
 * D3.a's freshness contract: the daemon may attach the new bytes
 * before its IPC ack returns).
 *
 *   1. classifyServerUrl(input) — reject up-front; no write.
 *   2. currentLocalHostId() / currentHostToken() — reload requires
 *      both. Missing → `reload_rejected/not_attached` (mirrors the
 *      daemon's own reject reason rather than minting a new one).
 *   3. Snapshot { previousConnectionId, expectAttachSince } —
 *      BEFORE write so the watchdog accepts an attachment whose
 *      `attachedAt` precedes the write.
 *   4. writeDaemonHostConfig(newConfig) — atomic. Throws → caller
 *      receives `config_write_failed`; reload IPC is NEVER fired
 *      after a write failure (would race a partial state).
 *   5. hostOutboundReload() — daemon swaps if and only if the new
 *      bytes validate. Failure arms passed through verbatim.
 *   6a. action: 'unchanged' — daemon kept the live client. Skip
 *       watchdog and return success. No WS bounce.
 *   6b. action: 'reloaded' — daemon spawned a fresh client. Start
 *       the watchdog with the pre-write snapshot. Watchdog success
 *       → `reloaded`; timeout → `connectivity_unverified`
 *       (success arm, downgraded confirmation — the user's config
 *       IS saved).
 */
export async function performOutboundReload(
  input: PerformOutboundReloadInput,
  deps: PerformOutboundReloadDeps,
): Promise<OutboundReloadOutcome> {
  const now = deps.now ?? (() => Date.now());

  // 1. Classify raw input. Anchor 1: defense-in-depth on the V1
  //    loopback policy. The renderer also validates, but main MUST
  //    NOT trust renderer-sent values for security-bearing fields.
  const classified = deps.classifyServerUrl(input.serverUrl);
  if (!classified.ok) {
    return {
      ok: false,
      kind: 'classify_rejected',
      reason: classified.reason,
      message: classified.message,
    };
  }

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
      kind: 'reload_rejected',
      reason: 'not_attached',
      message:
        hostId === null
          ? 'no local host claim — sign in before changing server URL'
          : 'no host token in memory — log out + log in to recover',
    };
  }

  // 3. Snapshot BEFORE write. The lower bound must precede every
  //    side-effect that could result in an attachment being
  //    registered server-side, so the watchdog's `attachedAt >=
  //    expectAttachSince` branch is well-defined for ANY observed
  //    attachment that this save could have caused. Mirrors
  //    `captureAttachWindow` in `index.ts` for the attach path.
  const expectAttachSince = now();
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
  };
  try {
    deps.writeDaemonHostConfig(newConfig);
  } catch (err) {
    return {
      ok: false,
      kind: 'config_write_failed',
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
      kind: 'reload_rejected',
      reason: 'not_attached',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!reload.reloaded) {
    return {
      ok: false,
      kind: 'reload_rejected',
      reason: reload.reason,
      message: reload.message ?? reload.reason,
    };
  }

  // 6a. `unchanged` — daemon kept the live client. Skip watchdog;
  //     there's no reconnect to wait for and starting one would
  //     just timeout in `connectivity_unverified` even though the
  //     save was a no-op.
  if (reload.action === 'unchanged') {
    return { ok: true, kind: 'unchanged' };
  }

  // 6b. `reloaded` — daemon spawned a fresh outbound client.
  //     Watch the backend `HostWsServerController` for the
  //     resulting attachment using the same freshness predicate
  //     `outbound-attach.ts` uses. The watchdog already handles
  //     the two-branch OR (connectionId change OR attachedAt
  //     lower bound) per Cindy's earlier review on D3.a.
  if (!deps.getAttachment) {
    // No controller (mode-specific edge — e.g. headless test).
    // Caller still saw `reloaded: true` from the daemon, so the
    // config is updated; we just can't verify the WS landed.
    return {
      ok: false,
      kind: 'no_attachment_controller',
      message: 'backend HostWsServerController unavailable in this mode',
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
      ok: true,
      kind: 'reloaded',
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
    kind: 'connectivity_unverified',
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
  controller:
    | { getAttachment(hostId: string): HostWsAttachment | null }
    | null,
): GetHostAttachmentFn | null {
  if (controller === null) return null;
  return hostId => controller.getAttachment(hostId);
}
