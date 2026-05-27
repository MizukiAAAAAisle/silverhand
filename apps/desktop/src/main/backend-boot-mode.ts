/**
 * D4.a Commit 3 — boot-mode decision primitive.
 *
 * Per `docs/remote-backend-d4-design.md` §4.2 (Cindy boundary lock):
 *
 *   > Desktop main detects `server_url` config and **skips** the
 *   > embedded `startBackend(...)` call when configured to remote.
 *
 * This module is the pure decision: given a server connection profile
 * view (from {@link readServerConnectionProfileViewOrNull}) and the
 * current env, decide whether the desktop main process should boot
 * the embedded backend or talk to a remote one.
 *
 * **Why a separate pure module**: bootstrap-time state machines that
 * silently fan out across many branches inside `index.ts` are
 * historically how desktop apps grow boot regressions ("which env
 * combo lands me in which mode?"). By extracting the decision to a
 * pure function, every arm of the matrix is unit-tested, the
 * discriminator is typed, and `bootstrap()` only consumes the result.
 *
 * **Scope discipline (Commit 3 only)**:
 *   - This commit adds the decision primitive + env reader + tests.
 *   - This commit wires the primitive into {@link bootstrap} as a
 *     **trip wire**: if the decision says `remote`, bootstrap throws
 *     a typed `RemoteModeNotYetWiredError` so we cannot silently fall
 *     through to embedded (drift) AND cannot accidentally ship a
 *     half-wired remote path to users.
 *   - The actual remote-mode bootstrap branch (skip
 *     `startEmbeddedSilverhandServer`, stand up a `RemoteBackendHandle`
 *     facade, route `requireBackend()` callers through it, gate
 *     `bootstrapEmbeddedUserSession`, etc.) is **Commit 5**.
 *   - Today no UI commits a remote profile (D4.a Commit 2's
 *     `handleProfileSaveWithTest` returns `remote_backend_not_yet_supported`
 *     for non-loopback URLs), so the trip wire is **structurally
 *     unreachable** for current users — it is a forward-compat
 *     regression gate for Commit 5 only.
 *
 * **Why the trip wire vs. fallback-to-embedded**: silently falling
 * back to embedded when remote was requested would (a) violate the
 * user's explicit configuration choice — Cindy "no `partial_apply_pending`
 * for boot mode" framing, the user's intent is data, not a hint —
 * and (b) hide a regression in the profile pipeline behind a working
 * embedded UI. Throwing is correct: the dev escape hatch is
 * `SILVERHAND_FORCE_EMBEDDED=1`, which the decision honors at the
 * top of the matrix and surfaces as `mode: 'embedded', reason:
 * 'forced_by_env'`.
 *
 * R1/R2/R4 framing:
 *   - R1 (one backend codebase): this module DOES NOT branch the
 *     backend protocol. It chooses **which transport adapter** the
 *     desktop sets up before the protocol runs (embedded loopback vs
 *     remote WS). The protocol surface is identical on both arms.
 *   - R2 (UI is remote-first): the renderer is unchanged; only main
 *     decides whether to spawn an embedded backend or talk to a
 *     remote one.
 *   - R4 (wire protocol is deployment-invariant): the daemon does
 *     not read the profile (§7.2) and does not read this flag
 *     (§ JSDoc on `SILVERHAND_FORCE_EMBEDDED_ENV`). Daemon ↔ backend
 *     semantics are not forked.
 */

import {
  classifyServerUrl,
  type ServerConnectionProfileView,
} from '@silverhand/shared';

/**
 * Result of {@link decideBackendBootMode}. Discriminated on
 * `mode`. The `reason` field on the embedded arm tracks which input
 * landed the decision there so bootstrap can log it actionable
 * ("forced by env" vs "no profile yet" vs "profile URL is loopback")
 * without re-deriving from the inputs.
 *
 * **Three terminal arms** (Cindy D4.a Commit 3 review P1-B):
 *
 *   - `mode: 'embedded'` — bootstrap proceeds with the existing
 *     embedded path. ONLY reached for forced_by_env (dev escape),
 *     no_profile (first run), or profile_is_loopback (user's
 *     committed URL is a loopback literal and we treat it as
 *     "embedded backend is correct"). NEVER reached as a silent
 *     fallback from a present-but-unacceptable profile.
 *
 *   - `mode: 'remote'` — bootstrap MUST skip embedded and route
 *     through the remote transport. Commit 3 trip-wires this via
 *     {@link RemoteModeNotYetWiredError}; Commit 5 lands the actual
 *     branch.
 *
 *   - `mode: 'profile_invalid'` — a profile is present on disk but
 *     the boot-time classifier refused it (e.g. obfuscated loopback
 *     persisted by an older binary, http remote URL committed under
 *     a dev flag that's now off, non-origin URL committed by a
 *     pre-Commit-2 binary). Bootstrap MUST refuse to boot embedded
 *     on this branch — silently falling back would (a) violate the
 *     user's explicit configuration intent (a present profile is
 *     data, not a hint) and (b) muddle "configured remote backend
 *     is broken; please fix" with "no profile yet; using embedded".
 *     The dev escape is `SILVERHAND_FORCE_EMBEDDED=1`, which the
 *     decision honors at the top of the matrix and which surfaces
 *     as `embedded/forced_by_env`. There is no implicit escape.
 *
 * Why no auto-rewrite of an unusable profile: automatic cleanup of
 * persisted config that the user can see in the file system is a
 * footgun (A.4 secret-handling review precedent). The repair path
 * is "operator explicitly clears the profile via Settings or sets
 * `SILVERHAND_FORCE_EMBEDDED=1`", not "main process silently
 * deletes user data on launch".
 */
export type BackendBootMode =
  | {
      mode: 'embedded';
      reason: 'no_profile' | 'forced_by_env' | 'profile_is_loopback';
      /**
       * Present on `'profile_is_loopback'`: the raw URL string from
       * the profile (for log lines). Empty string on the other
       * embedded reasons. Note: even when the classifier admitted
       * the URL as loopback, the profile's URL is NOT (yet —
       * Commit 5 may change this) what the embedded backend binds
       * to; embedded boots its default loopback bind.
       */
      profileUrl: string;
    }
  | {
      mode: 'remote';
      /**
       * The classifier-validated remote URL. Bootstrap consumers
       * should use this string as the source of truth — do NOT
       * re-read the profile bytes separately to avoid TOCTOU.
       */
      serverUrl: string;
      /**
       * `true` when the URL was admitted only because
       * `SILVERHAND_ALLOW_INSECURE_REMOTE=1` was set (non-loopback
       * http). Bootstrap consumers should emit a visible WARN line
       * referencing the runbook on this branch.
       */
      insecure: boolean;
    }
  | {
      /**
       * A profile is present but the boot-time classifier refused
       * it. Bootstrap throws {@link ProfileUnusableError}; never
       * silently falls through to embedded (Cindy D4.a Commit 3
       * review P1-B). Repair path: user clears the profile in
       * Settings, or sets `SILVERHAND_FORCE_EMBEDDED=1` to override.
       */
      mode: 'profile_invalid';
      /** Raw URL string from the profile (for log lines + UI). */
      profileUrl: string;
      /**
       * The classifier's raw message so the error / log carries
       * enough context to debug without round-tripping through the
       * file. Typically points at the specific gate that fired
       * ("non-loopback http requires SILVERHAND_ALLOW_INSECURE_REMOTE=1",
       * "disguised loopback form", etc.).
       */
      classifyMessage: string;
    };

/**
 * Inputs to {@link decideBackendBootMode}. Kept as a plain options
 * object so callers can read the env / profile once and pass the
 * snapshot in (no hidden global reads inside the decision function).
 */
export interface DecideBackendBootModeInput {
  /**
   * The redacted profile view from
   * {@link readServerConnectionProfileViewOrNull}, or `null` when
   * the profile file is absent (first run) or unreadable. We accept
   * the **view** rather than the full profile because (a) the
   * decision only needs `server_url`, and (b) the redacted view is
   * what bootstrap already has on hand (the encrypted full profile
   * is read only when the writer needs to bump version).
   */
  profileView: ServerConnectionProfileView | null;
  /**
   * Value of `readForceEmbeddedFlag(process.env)`. When `true` the
   * decision short-circuits to `embedded/forced_by_env` regardless
   * of profile state — see {@link SILVERHAND_FORCE_EMBEDDED_ENV}.
   */
  forceEmbedded: boolean;
  /**
   * Value of `readAllowInsecureRemoteFlag(process.env)`. Passed
   * through to {@link classifyServerUrl} so a loopback-shaped URL
   * always admits (the flag does not affect loopback), an https
   * remote URL admits, and an http remote URL admits only when the
   * flag is on. Without this we'd classify-fail any http remote
   * profile on every boot even when the user explicitly committed
   * it under the dev flag.
   */
  allowInsecureRemote: boolean;
}

/**
 * Pure decision: which backend transport should bootstrap stand up?
 *
 * Evaluation order (first-match wins):
 *   1. `forceEmbedded === true` → `embedded/forced_by_env`. The dev
 *      escape always wins; profile is ignored entirely on this arm
 *      (no classifier call) so a broken-on-disk profile cannot
 *      block the developer from booting embedded.
 *   2. `profileView === null` → `embedded/no_profile`. First-run
 *      default; bootstrap proceeds with the existing embedded path.
 *   3. Profile URL classifies as `loopback` → `embedded/profile_is_loopback`.
 *      The user has explicitly committed a loopback URL (e.g. via
 *      Settings save against the embedded backend's own URL); in V1
 *      the embedded backend boots its default bind anyway, so this
 *      branch is semantically equivalent to `no_profile` for the
 *      current build. Reason is distinct so log lines can tell
 *      "user has a saved loopback profile" from "fresh install".
 *   4. Profile URL classifies as `remote` → `remote/serverUrl`.
 *      Bootstrap MUST skip embedded and route through the remote
 *      transport (Commit 5 wires this; Commit 3 trip-wires it via
 *      {@link RemoteModeNotYetWiredError}).
 *   5. Profile URL fails classification → `profile_invalid`.
 *      Real-world drift cases this covers: writer ran under
 *      `allowInsecureRemote: true` but that env flag is now off, an
 *      older binary persisted an obfuscated loopback or non-origin
 *      URL, a future schema migration widened the persisted shape.
 *      Bootstrap MUST throw {@link ProfileUnusableError} on this
 *      arm — silently falling back to embedded would violate the
 *      "profile present is data, not a hint" boundary (Cindy
 *      D4.a Commit 3 review P1-B). The dev escape is
 *      `SILVERHAND_FORCE_EMBEDDED=1`, which is honored at the top
 *      of the matrix; this arm has no implicit fallback.
 *
 * The function is pure, throw-free, and deterministic over its
 * inputs — bootstrap can unit-test every arm without standing up
 * Electron or the file system.
 */
export function decideBackendBootMode(
  input: DecideBackendBootModeInput,
): BackendBootMode {
  if (input.forceEmbedded) {
    return {
      mode: 'embedded',
      reason: 'forced_by_env',
      profileUrl: input.profileView?.server_url ?? '',
    };
  }
  if (input.profileView === null) {
    return {
      mode: 'embedded',
      reason: 'no_profile',
      profileUrl: '',
    };
  }
  const classification = classifyServerUrl(input.profileView.server_url, {
    allowInsecureRemote: input.allowInsecureRemote,
  });
  if (!classification.ok) {
    return {
      mode: 'profile_invalid',
      profileUrl: input.profileView.server_url,
      classifyMessage: classification.message,
    };
  }
  if (classification.kind === 'loopback') {
    return {
      mode: 'embedded',
      reason: 'profile_is_loopback',
      profileUrl: input.profileView.server_url,
    };
  }
  return {
    mode: 'remote',
    // Use the classifier's normalized origin so downstream consumers
    // never see the user's raw input (which classifier accepted but
    // may have casing / trailing-slash differences). Commit 5's
    // canonicalization-on-write (Cindy fixup nit on Commit 2) will
    // make this a tautology, but we already do the right thing at
    // read time so the downstream contract is "always origin".
    serverUrl: classification.url.origin,
    insecure: classification.insecure,
  };
}

/**
 * Thrown by bootstrap when {@link decideBackendBootMode} returns
 * `mode: 'remote'` in Commit 3 (the trip wire). Carries the
 * decision payload so the caller (and crash log) can see exactly
 * what was attempted.
 *
 * Commit 5 deletes this throw site and replaces it with the actual
 * remote-bootstrap branch; the error class itself can remain as a
 * sentinel for any future "remote-mode prerequisite missing" path
 * (e.g. no host claim yet).
 */
export class RemoteModeNotYetWiredError extends Error {
  readonly serverUrl: string;
  readonly insecure: boolean;
  constructor(decision: Extract<BackendBootMode, { mode: 'remote' }>) {
    super(
      `Remote-mode bootstrap is not yet implemented (D4.a Commit 3 trip wire). ` +
        `Server connection profile is at '${decision.serverUrl}' ` +
        `(insecure=${decision.insecure}). ` +
        `Set SILVERHAND_FORCE_EMBEDDED=1 to boot the embedded backend instead, ` +
        `or wait for D4.a Commit 5 which lands the remote-mode bootstrap branch.`,
    );
    this.name = 'RemoteModeNotYetWiredError';
    this.serverUrl = decision.serverUrl;
    this.insecure = decision.insecure;
  }
}

/**
 * Thrown by bootstrap when {@link decideBackendBootMode} returns
 * `mode: 'profile_invalid'` — a profile is present but the boot-
 * time classifier refused it. This error surfaces the underlying
 * classifier message so the operator can fix the profile (clear it
 * in Settings, or set the env flag that made the URL acceptable at
 * write time, e.g. `SILVERHAND_ALLOW_INSECURE_REMOTE=1`).
 *
 * Rationale (Cindy D4.a Commit 3 review P1-B): silently falling
 * back to embedded when the user has a present-but-unusable profile
 * would (a) violate the user's explicit configuration intent and
 * (b) hide a profile-pipeline regression behind a working embedded
 * UI. Throwing is correct; the dev escape is
 * `SILVERHAND_FORCE_EMBEDDED=1`, NOT an implicit fallback.
 */
export class ProfileUnusableError extends Error {
  readonly profileUrl: string;
  readonly classifyMessage: string;
  constructor(
    decision: Extract<BackendBootMode, { mode: 'profile_invalid' }>,
  ) {
    super(
      `A server connection profile is present but the boot-time URL ` +
        `classifier refused it (D4.a Commit 3 boot gate). ` +
        `Profile URL: '${decision.profileUrl}'. ` +
        `Classifier message: ${decision.classifyMessage} ` +
        `Repair: clear the profile via Settings → "Connect to backend…" → ` +
        `Clear saved profile, or set the env flag that made the URL ` +
        `acceptable at write time (e.g. SILVERHAND_ALLOW_INSECURE_REMOTE=1 ` +
        `for http remote URLs), or set SILVERHAND_FORCE_EMBEDDED=1 to ` +
        `boot the embedded backend and ignore the profile.`,
    );
    this.name = 'ProfileUnusableError';
    this.profileUrl = decision.profileUrl;
    this.classifyMessage = decision.classifyMessage;
  }
}

/**
 * D4.a Commit 3 review fixup (Cindy P1-A) — guard that
 * `handleProfileSaveWithTest` consults BEFORE persisting a probed
 * URL.
 *
 * The hazard: the test-then-commit pipeline accepts any URL the
 * classifier admits (loopback, system_ca_verified, insecure_dev_remote).
 * For Commit 3, persisting a remote URL is unsafe — the next launch
 * would land on the {@link RemoteModeNotYetWiredError} trip wire,
 * turning a "click Save in Setup Wizard" action into a crash on
 * next launch. We MUST refuse to commit remote profiles until
 * Commit 5 lands the actual remote-mode bootstrap branch.
 *
 * Why a separate pure guard (not inlined in `handleProfileSaveWithTest`):
 *   - The decision is exactly the same shape as the boot-mode
 *     decision — "is the desktop ready to consume this URL?". Keeping
 *     both pure-decision sites in this file lets us unit-test the
 *     full commit→boot lifecycle invariant in one place: anything
 *     the guard permits to write MUST be a boot-time `embedded` or
 *     `remote` arm; nothing the guard rejects can land on disk.
 *   - Pure helpers are easy to extend in Commit 5 (delete the
 *     remote-arm refusal; commit will then succeed and boot will
 *     route through `RemoteBackendHandle`).
 *
 * Discriminated outcome:
 *   - `{ allow: true }` — caller may proceed to write.
 *   - `{ allow: false, reason: 'remote_backend_not_yet_supported',
 *        message }` — caller MUST NOT write; surface `reason` to the
 *      renderer so it renders the typed "this build cannot connect
 *      to a remote backend yet" banner.
 *
 * Inputs: the discriminator of {@link ProbeServerInfoResult} on the
 * success path. We accept the kind directly (not the whole
 * result) so this module does not need to import `ProbeServerInfoResult`
 * — the types are in different bytecode units and this keeps
 * `backend-boot-mode.ts` free of `server-connection-test.ts` deps.
 */
export type ProbeSuccessKind =
  | 'loopback_ok'
  | 'system_ca_verified'
  | 'insecure_dev_remote';

export type ProfileCommitGuardOutcome =
  | { allow: true }
  | {
      allow: false;
      reason: 'remote_backend_not_yet_supported';
      message: string;
    };

export function evaluateProfileCommitGuard(
  probeKind: ProbeSuccessKind,
): ProfileCommitGuardOutcome {
  if (probeKind === 'loopback_ok') {
    return { allow: true };
  }
  // `system_ca_verified` and `insecure_dev_remote` are both remote
  // arms — the URL is non-loopback and will activate remote-mode
  // boot on next launch. Commit 3 has no remote bootstrap path
  // implemented, so persisting here would create a "save → restart
  // → crash" footgun. Refuse with a typed reason the renderer
  // already knows from D4.a Commit 1 / `outbound-reload.ts`.
  return {
    allow: false,
    reason: 'remote_backend_not_yet_supported',
    message:
      probeKind === 'insecure_dev_remote'
        ? `This build cannot connect to a remote backend yet. The URL was admitted only because SILVERHAND_ALLOW_INSECURE_REMOTE=1 is set; remote-mode bootstrap lands in D4.a Commit 5. Use a loopback URL (127.0.0.1 / localhost / [::1]) for now.`
        : `This build cannot connect to a remote backend yet. Remote-mode bootstrap lands in D4.a Commit 5. Use a loopback URL (127.0.0.1 / localhost / [::1]) for now.`,
  };
}
