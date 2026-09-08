export interface RemoteBackendHandle {
  /** Discriminator — pairs with the `embedded` arm in the union. */
  readonly kind: "remote";
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
export function buildRemoteBackendHandle(input: RemoteBackendHandleInput): RemoteBackendHandle {
  return {
    kind: "remote",
    url: input.serverUrl,
    insecure: input.insecure,
    close: () => Promise.resolve(),
  };
}
