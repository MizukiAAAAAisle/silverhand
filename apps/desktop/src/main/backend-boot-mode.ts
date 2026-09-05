/**
 * D4.a Commit 3 — boot-mode decision primitive.
 *
 * Per `docs/auth-and-host-model.md §3.2` (Server connection profile; boundary lock):
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
 * **Scope**: this module owns the decision + the env reader only.
 * Acting on it is `bootstrap()`'s job — the real remote-mode branch
 * (skip `startEmbeddedSilverhandServer`, stand up a
 * `RemoteBackendHandle` facade, route `requireBackend()` callers
 * through it, gate `bootstrapEmbeddedUserSession`, drive daemon attach
 * against the remote URL) has been live since D4.a Commit 5.
 *
 * **Why refusing beats falling back to embedded**: when a profile says
 * remote but cannot be honored, silently booting embedded would (a)
 * violate the user's explicit configuration choice — Cindy's "no
 * `partial_apply_pending` for boot mode" framing, the user's intent is
 * data, not a hint — and (b) hide a regression in the profile pipeline
 * behind a working embedded UI. Refusing is correct: the two typed
 * refusals are {@link ProfileUnusableError} (profile present but the
 * classifier rejected it) and
 * {@link RemoteOnlyServerProfileRequiredError} (remote-only package
 * with no usable remote profile), and the dev escape hatch is
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
 *     through the remote transport (live since D4.a Commit 5).
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
       * `true` when the URL was admitted only because this client
       * explicitly allows non-loopback http (via dev env or packaged
       * build option). Bootstrap consumers should emit a visible WARN
       * line referencing the runbook on this branch.
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
   * what bootstrap already has on hand (the full profile
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
 *      transport (live since D4.a Commit 5).
 *   5. Profile URL fails classification → `profile_invalid`.
 *      Real-world drift cases this covers: writer ran under
 *      `allowInsecureRemote: true` but that caller-side opt-in is now
 *      off, an older binary persisted an obfuscated loopback or
 *      non-origin URL, a future schema migration widened the persisted shape.
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
 * `mode: 'profile_invalid'` — a profile is present but the boot-
 * time classifier refused it. This error surfaces the underlying
 * classifier message so the operator can fix the profile (clear it
 * in Settings, or restore the caller-side opt-in that made the URL
 * acceptable at write time).
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
        `Repair options: ` +
        `(1) restore the caller-side opt-in that made the URL acceptable ` +
        `at write time (for example the packaged insecure-remote build ` +
        `option, or SILVERHAND_ALLOW_INSECURE_REMOTE=1 in dev) and relaunch; ` +
        `(2) set SILVERHAND_FORCE_EMBEDDED=1 to boot the embedded backend ` +
        `(this ignores the profile but does NOT delete it — once the UI ` +
        `is up you can clear the profile via Settings → "Connect to ` +
        `backend…" → Clear saved profile, then unset FORCE_EMBEDDED).`,
    );
    this.name = 'ProfileUnusableError';
    this.profileUrl = decision.profileUrl;
    this.classifyMessage = decision.classifyMessage;
  }
}

/**
 * A remote-only package (`--server-url` at package time) refused to boot
 * an embedded backend because no usable remote profile was available.
 *
 * Lives beside {@link ProfileUnusableError} because it is the same kind
 * of thing: an explicit, named boot-gate refusal with one determinate
 * repair, not an unexpected crash. `reason` carries the short,
 * greppable "why this boot decision" clause so the startup failure exit
 * can show it without the constructor's full repair text
 * (#task:1641 review, @Alice).
 */
export class RemoteOnlyServerProfileRequiredError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(
      `This Silverhand Desktop package was built as remote-only, but no ` +
        `usable remote server profile is available. ${reason} ` +
        `Repackage with --server-url <https-origin>, or save a non-loopback ` +
        `remote server profile before launching this build.`,
    );
    this.name = 'RemoteOnlyServerProfileRequiredError';
    this.reason = reason;
  }
}

/**
 * D4.a Commit 3 fixup (Cindy P1-A) → Commit 5d lift — the persistence
 * guard that `handleProfileSaveWithTest` consults BEFORE writing a
 * probed URL to disk.
 *
 * **Original purpose (D4.a Commit 3)**: refuse to persist remote
 * URLs while the boot path still trip-wired remote mode as
 * unimplemented. Persisting a remote profile under that trip wire
 * would have turned a "click Save in Setup Wizard" into a crash on
 * next launch.
 *
 * **Lifted in Commit 5d**: now that the boot path includes a real
 * remote-mode branch (skips embedded backend, builds
 * `RemoteBackendHandle`, drives daemon attach against the remote
 * URL — see `index.ts` bootstrap), every probe-success kind is safe
 * to persist:
 *   - `loopback_ok` → embedded boot (unchanged).
 *   - `system_ca_verified` → remote boot, https / valid CA chain.
 *   - `insecure_dev_remote` → remote boot, admitted by
 *     explicit insecure-remote opt-in.
 *
 * The guard's discriminated `allow: false` arm is kept in the type
 * surface (rather than collapsed to `boolean`) for two reasons:
 *   1. **Forward use.** Future TLS-policy / remote-prerequisite gates
 *      (e.g. "this build refuses non-Tailscale remote URLs",
 *      "remote-mode requires a host claim before persistence") will
 *      slot into the `allow: false` arm without rewriting the IPC
 *      contract.
 *   2. **Wire stability.** The renderer's `commit_guard` failure arm
 *      in `DesktopProfileSaveWithTestResult` references this shape;
 *      keeping it typed avoids a pre-A.4 binary's renderer choking
 *      on a narrowed `boolean` if a 5d-or-later main rolls back
 *      partially.
 *
 * Today the function returns `{ allow: true }` for every supported
 * probe kind. The persistence ↔ boot invariant test in
 * `backend-boot-mode.test.ts` pins this: anything the guard permits
 * MUST land in a non-throwing boot-mode arm
 * (`embedded` or `remote`), never `profile_invalid`.
 *
 * Inputs: the discriminator of {@link ProbeServerInfoResult} on the
 * success path. Accepting the kind directly (not the whole result)
 * keeps `backend-boot-mode.ts` free of `server-connection-test.ts`
 * dependencies.
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
  // Commit 5d: every probe-success kind is now safe to persist. The
  // boot path covers all three (loopback → embedded; system_ca / dev
  // remote → remote-mode handle). The exhaustive switch keeps the
  // door open for future kinds: adding a new arm to
  // `ProbeSuccessKind` makes `kind` non-`never` here, forcing the
  // author to make an explicit allow/deny decision.
  switch (probeKind) {
    case 'loopback_ok':
    case 'system_ca_verified':
    case 'insecure_dev_remote':
      return { allow: true };
    default: {
      const exhaustive: never = probeKind;
      throw new Error(
        `evaluateProfileCommitGuard: unhandled probe success kind: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * D4.a Commit 5d — pure adapter that converts a {@link BackendBootMode}
 * decision into a startup plan the bootstrap site executes.
 *
 * **Why this exists (Cindy 5d review boundary 5)**: the decision
 * (`decideBackendBootMode`) tells you _what_ the desktop should do
 * (boot embedded / talk to remote / refuse). The bootstrap site
 * (`index.ts`) executes that plan but is hard to unit-test directly
 * because it owns Electron, the file system, daemon spawn, and the
 * HTTP listener. By extracting a pure adapter, every "what should
 * happen on this arm" assertion lives in a unit test:
 *   - "for every embedded decision, the plan says embedded with the
 *     same reason" → guards against a refactor accidentally turning
 *     an embedded reason into a remote plan.
 *   - "for the remote decision, the plan carries the canonical
 *     `serverUrl` and `insecure` flag verbatim" → guards against a
 *     refactor losing the insecure flag mid-pipe.
 *   - "for `profile_invalid`, the plan is `refuse` and carries the
 *     classifier message" → guards against the bootstrap site
 *     silently swallowing the diagnosis.
 *
 * **Why discriminated `mode: 'refuse'` instead of throwing here**:
 * `planBackendStartup` is pure and throw-free; the bootstrap site
 * remains the only place that decides whether to throw
 * {@link ProfileUnusableError}. This keeps the adapter pinned by
 * type tests (every arm of the input maps to exactly one arm of the
 * output) without dragging the error class' constructor surface into
 * the adapter test.
 */
export type BackendStartupPlan =
  | {
      mode: 'embedded';
      /**
       * Mirrors `BackendBootMode.embedded.reason` — preserved so the
       * bootstrap site's log line and any future "embedded but for
       * what reason" UI keeps the same discriminator.
       */
      embeddedReason: 'no_profile' | 'forced_by_env' | 'profile_is_loopback';
    }
  | {
      mode: 'remote';
      /** Canonical origin URL (post-classify + origin-normalize). */
      serverUrl: string;
      /** Admitted via explicit insecure-remote opt-in. */
      insecure: boolean;
    }
  | {
      /**
       * `profile_invalid` decision arm — the bootstrap site MUST
       * throw {@link ProfileUnusableError} on this plan. The
       * adapter does not throw; bootstrap consumes the plan and
       * decides what to do, so all "if I see this plan I do X"
       * branches are visible in one place.
       */
      mode: 'refuse';
      reason: 'profile_invalid';
      profileUrl: string;
      classifyMessage: string;
    };

export function planBackendStartup(decision: BackendBootMode): BackendStartupPlan {
  switch (decision.mode) {
    case 'embedded':
      return { mode: 'embedded', embeddedReason: decision.reason };
    case 'remote':
      return {
        mode: 'remote',
        serverUrl: decision.serverUrl,
        insecure: decision.insecure,
      };
    case 'profile_invalid':
      return {
        mode: 'refuse',
        reason: 'profile_invalid',
        profileUrl: decision.profileUrl,
        classifyMessage: decision.classifyMessage,
      };
    default: {
      const exhaustive: never = decision;
      throw new Error(
        `planBackendStartup: unhandled boot decision: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * D4.a Commit 5d fixup (Cindy P1-1 review) — executor adapter.
 *
 * **Why this exists**: Cindy review found that `bootstrap()` was
 * calling `loadOrCreateServerConfig()` BEFORE the boot-mode decision,
 * which meant a remote-profile boot still touched (and on missing /
 * corrupt files, **wrote**) the embedded-only `server-config.json`.
 * That contradicted the 5d remote-arm comment ("server-config is
 * embedded-only artifact") and broke the §4.2 hard gate (a broken
 * legacy config could fail the boot before remote arm was reached).
 *
 * The fix is structural: a small executor adapter that takes the
 * plan + injectable deps and dispatches to the right arm. The
 * embedded arm is the ONLY one that calls `deps.loadOrCreateServerConfig`;
 * the remote / refuse arms must not.
 *
 * **Production dispatch — what actually executes through the adapter**:
 *
 *   - Embedded plans: dispatched through the adapter — load config,
 *     start embedded, persist resolved port.
 *   - Remote plans: dispatched through the adapter — `buildRemoteHandle`
 *     only; no embedded artifact touched.
 *   - Refuse plans: in `bootstrap()`, intercepted by a pre-daemon
 *     `if (startupPlan.mode === 'refuse')` guard and thrown as
 *     `ProfileUnusableError` BEFORE the adapter is invoked. That
 *     pre-daemon guard exists because we want fail-loud to land
 *     before any daemon spawn / IPC subscribe / WS init runs.
 *
 *     The adapter's `refuse` arm is therefore **defense-in-depth
 *     seam** — kept in the type union so a future refactor that
 *     drops the pre-daemon guard still fails loud (the executor
 *     would call `deps.refuse(plan)` and throw). Production never
 *     reaches it under the current call ordering.
 *
 * **Test seam (Cindy 5d-fixup constraint)**: the unit test injects
 * spies for `loadOrCreateServerConfig` / `startEmbeddedAndPersistConfig`
 * / `buildRemoteHandle` / `refuse` and pins:
 *   - embedded plan calls `loadOrCreateServerConfig` then
 *     `startEmbeddedAndPersistConfig`; does NOT call `buildRemoteHandle`
 *     or `refuse`
 *   - remote plan calls `buildRemoteHandle` ONLY; does NOT call
 *     `loadOrCreateServerConfig` or any embedded helper
 *   - refuse plan calls `refuse` ONLY; does NOT call any embedded
 *     helper or `buildRemoteHandle`
 *
 * This is the load-bearing pin Cindy asked for — typecheck alone
 * cannot tell you whether the legacy config loader runs on the
 * remote path; only an injected spy can.
 *
 * **Generic over `RunningBackendT` and `RemoteBackendHandleT`** so
 * the adapter does not depend on the embedded backend / remote
 * handle modules at compile time. The bootstrap site fills in the
 * real types; tests fill in lightweight fakes.
 */
export interface ExecuteBackendStartupDeps<RunningBackendT, RemoteBackendHandleT> {
  /**
   * Reads `~/.silverhand/server-config.json`, creates a fresh embedded
   * default if missing/corrupt. Embedded-only — calling on a remote
   * profile would touch the legacy artifact (the bug 5d-fixup is
   * preventing).
   */
  loadOrCreateServerConfig: () => Promise<unknown>;
  /**
   * Starts the embedded backend with the given config and persists
   * the resolved `serverConfig` (with the chosen port) back to disk.
   * The two side effects are bundled here because they are always
   * paired in bootstrap and have the same embedded-only scope.
   */
  startEmbeddedAndPersistConfig: (config: unknown) => Promise<RunningBackendT>;
  /**
   * Builds the remote-arm handle from the plan's serverUrl + insecure
   * flag. Trivial in production (`buildRemoteBackendHandle`); a fake
   * in tests.
   */
  buildRemoteHandle: (input: {
    serverUrl: string;
    insecure: boolean;
  }) => RemoteBackendHandleT;
  /**
   * Refuse arm — defense-in-depth seam. In production `bootstrap()`
   * intercepts `startupPlan.mode === 'refuse'` BEFORE invoking the
   * adapter and throws `ProfileUnusableError` itself, so the
   * executor's refuse branch is unreachable under current call
   * ordering. Kept here so a future refactor that drops the
   * pre-daemon guard still fails loud (the adapter calls
   * `deps.refuse(plan)` which is typed `(plan) => never`). Tests
   * cover both the called-and-throws and called-and-buggy-returns
   * cases for that scenario.
   */
  refuse: (plan: Extract<BackendStartupPlan, { mode: 'refuse' }>) => never;
}

export type ExecutedBackendHandle<RunningBackendT, RemoteBackendHandleT> =
  | { kind: 'embedded'; running: RunningBackendT }
  | RemoteBackendHandleT;

export async function executeBackendStartup<
  RunningBackendT,
  RemoteBackendHandleT,
>(
  plan: BackendStartupPlan,
  deps: ExecuteBackendStartupDeps<RunningBackendT, RemoteBackendHandleT>,
): Promise<ExecutedBackendHandle<RunningBackendT, RemoteBackendHandleT>> {
  switch (plan.mode) {
    case 'refuse':
      // Defense-in-depth path. Production `bootstrap()` intercepts
      // `mode === 'refuse'` BEFORE calling the adapter (so a profile
      // classifier reject fails loud before any daemon spawn / IPC
      // subscribe / WS init), which means this arm is unreachable
      // under current call ordering. We keep it here so a future
      // refactor that drops the pre-daemon guard still fails loud:
      // `deps.refuse(plan)` is typed `(plan) => never` and throws
      // `ProfileUnusableError`. The trailing throw catches a buggy
      // refuse impl that returns instead of throwing (regression
      // bait).
      deps.refuse(plan);
      throw new Error(
        'executeBackendStartup: refuse() returned (expected `never`)',
      );
    case 'embedded': {
      const config = await deps.loadOrCreateServerConfig();
      const running = await deps.startEmbeddedAndPersistConfig(config);
      return { kind: 'embedded', running };
    }
    case 'remote':
      return deps.buildRemoteHandle({
        serverUrl: plan.serverUrl,
        insecure: plan.insecure,
      });
    default: {
      const exhaustive: never = plan;
      throw new Error(
        `executeBackendStartup: unhandled plan: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
