/**
 * D4.a Commit 5d — `RemoteBackendHandle` facade for remote-mode boot.
 *
 * **Purpose** (per `docs/remote-backend-architecture-notes.md §3`):
 *   - Desktop main detects a remote `server_url` profile and **skips**
 *     the embedded `startBackend(...)` call. There is no
 *     in-process backend on this arm — every HTTP / SSE / WS request
 *     leaves the desktop and lands on the configured remote backend.
 *   - But the rest of the desktop main process (renderer-facing
 *     `backend:request` proxy, event WS origin override, settings UI
 *     snapshot, shutdown teardown) still wants a single object to
 *     read `url` from. This module provides the embedded counterpart's
 *     remote sibling.
 *
 * **Scope discipline** (Cindy review style):
 *   - This module is a pure factory + a typed handle. **No I/O**, no
 *     side effects, no logger, no env reads. The caller hands in the
 *     decision payload from `decideBackendBootMode` and gets back the
 *     handle.
 *   - The handle's `close()` is a no-op `Promise.resolve()`. There is
 *     no in-process backend to tear down. Daemon + hostClient lifecycle
 *     remain owned by `index.ts` shutdown — they outlive the backend
 *     handle on both arms (the embedded arm closes its `RunningBackend`
 *     before tearing down hostClient/daemon for the same reason).
 *
 * **R1–R4 framing**:
 *   - **R1 / one backend codebase**: this module does NOT branch the
 *     backend protocol. It picks **which transport adapter** the
 *     desktop sets up before the protocol runs (embedded loopback vs
 *     remote WSS / HTTPS). Every HTTP route, every event-WS frame,
 *     every intent envelope is identical on both arms — the desktop
 *     just talks to a remote process instead of an in-process one.
 *   - **R2 / UI is remote-first**: the renderer is unchanged; only
 *     main decides whether to spawn an embedded backend or talk to a
 *     remote one. The Settings / Setup Wizard URL editor and the
 *     `backend:request` proxy already work against any URL; this
 *     handle just supplies the URL.
 *   - **R3 / one codebase, multiple deployment adapters**: handler
 *     code does not fork. The handle is a transport-side adapter
 *     specifically — a marker plus a URL — not a parallel backend
 *     implementation.
 *   - **R4 / wire protocol is deployment-invariant**: the daemon does
 *     NOT read this handle. Daemon ↔ backend semantics are unchanged;
 *     the daemon dials whatever URL `daemon-config.json.server_url`
 *     resolves to. This handle describes what the **desktop main
 *     process** does, not what the daemon does.
 *
 * This IPC is local supervisor/control, not server↔daemon formal
 * semantics — same disclaimer the rest of the D3.b/c IPC carries.
 */

/**
 * The remote-mode counterpart of `RunningBackend` (which the embedded
 * arm produces). Discriminated by `kind: 'remote'` so callers narrow
 * cleanly against the embedded arm in the union.
 *
 * Field surface deliberately tiny: the only thing the desktop main
 * process actually reads off the embedded `RunningBackend` apart from
 * `url` is `context.serverConfig.mode` (used to gate the
 * embedded-bootstrap token path) and `context.hostWsController` (used
 * by graceful-shutdown detach). On remote there is no embedded
 * server, so:
 *   - "mode" is implicit from `kind: 'remote'`.
 *   - `hostWsController` does not exist locally; the WS attachment
 *     registry runs on the remote backend, observed via daemon-emitted
 *     frames, not via an in-process getter.
 */
export interface RemoteBackendHandle {
  /** Discriminator — pairs with the `embedded` arm in the union. */
  readonly kind: 'remote';
  /**
   * Canonical origin URL of the remote backend (already classified
   * + origin-normalized by `decideBackendBootMode` / the writer
   * canonicalization in 5a). Includes the scheme; never has a
   * trailing slash, never carries path/query/fragment.
   *
   * **Source of truth**: `BackendBootMode { mode: 'remote' }.serverUrl`.
   * Callers that need to build a URL against this base should treat
   * it as an origin and append paths via `new URL(path, base)`.
   */
  readonly url: string;
  /**
   * `true` when the remote URL was admitted only because
   * `SILVERHAND_ALLOW_INSECURE_REMOTE=1` was set at boot
   * (non-loopback http). Used by callers that want to surface a
   * "this is a dev / insecure connection" indicator (boot WARN line,
   * Settings banner, future `/readyz` smoke). Persisted nowhere —
   * re-derived from the env flag every boot.
   */
  readonly insecure: boolean;
  /**
   * No-op teardown. The embedded counterpart's `close()` shuts down
   * the in-process Hono server, runtime host, scheduler, etc.; the
   * remote arm has none of those, so there is nothing to tear down
   * on this object. Daemon + hostClient teardown happens separately
   * in `index.ts` shutdown — they are not owned by the backend
   * handle on either arm.
   *
   * Returns a resolved promise (rather than being a sync function)
   * to keep the call site shape identical to the embedded arm
   * (`await backend.close()`). Callers must not depend on this for
   * sequencing — there is no observable side effect.
   */
  close(): Promise<void>;
}

/**
 * Input to {@link buildRemoteBackendHandle}. Mirrors the
 * `BackendBootMode { mode: 'remote' }` arm field-for-field so the
 * caller can pass the decision result directly without re-shaping.
 *
 * Kept as a plain interface (not a type alias of the boot-mode arm)
 * so this module does not depend on `backend-boot-mode.ts` — the two
 * modules are siblings, not parent/child.
 */
export interface RemoteBackendHandleInput {
  /** Canonical origin URL (post-classify + origin-normalize). */
  serverUrl: string;
  /** Whether the URL was admitted via the insecure-remote dev flag. */
  insecure: boolean;
}

/**
 * Pure factory: produce a {@link RemoteBackendHandle} from a boot
 * decision payload. Throw-free, deterministic, no I/O.
 *
 * The function is intentionally trivial today; it exists as a named
 * constructor so:
 *   - callers can pin a single import in `index.ts` instead of
 *     scattering inline object literals,
 *   - the unit test surface has a stable name to assert against,
 *   - future remote-mode validation that needs to run BEFORE the
 *     handle is usable (e.g. a `/readyz` ping, a TLS info snapshot)
 *     can live behind this constructor without changing the call site.
 */
export function buildRemoteBackendHandle(
  input: RemoteBackendHandleInput,
): RemoteBackendHandle {
  return {
    kind: 'remote',
    url: input.serverUrl,
    insecure: input.insecure,
    close: () => Promise.resolve(),
  };
}
