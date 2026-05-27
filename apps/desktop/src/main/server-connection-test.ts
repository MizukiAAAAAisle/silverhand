/**
 * D4.a Commit 2 — desktop main-process helper that probes a
 * candidate `server_url` and returns a typed outcome the Setup
 * Wizard / Settings UI can render copy off of.
 *
 * Scope:
 *   - Classify the URL via the shared {@link classifyServerUrl}
 *     primitive (so the wizard and the daemon agree on what's
 *     acceptable — see `packages/shared/src/server-url.ts`).
 *   - Issue `GET <url>/api/server/info` via the standard Node `fetch`
 *     (HTTP for `kind: 'loopback'` / `insecure: true`, HTTPS for
 *     `insecure: false` — Node's default system-CA pipeline does the
 *     verification with NO custom verifier).
 *   - Translate any thrown error to a typed outcome via
 *     {@link classifyTlsError}; non-TLS network errors collapse to
 *     `network_failed`; HTTP non-2xx becomes `http_failed`; body
 *     parse failure becomes `invalid_response`.
 *
 * Pure-ish: takes a `fetcher` seam so unit tests can drive every arm
 * without standing up a real HTTP server.
 */
import {
  ServerInfoSchema,
  apiPaths,
  classifyServerUrl,
  classifyTlsError,
  type ServerInfo,
  type ServerUrlRejectionReason,
  type TlsErrorCode,
} from '@silverhand/shared';

/**
 * Discriminated outcome the renderer branches on.
 *
 * Success kinds (all `ok: true`):
 *   - `system_ca_verified` — remote https; Node's default trust store
 *     verified the chain (§8.1 single accept state for remote TLS).
 *   - `loopback_ok` — loopback http/https; no remote TLS path involved.
 *     The wizard renders "embedded backend" copy.
 *   - `insecure_dev_remote` — non-loopback http with the dev env flag
 *     set. Wizard MUST render a "connection is unencrypted" warning.
 *
 * Failure kinds (all `ok: false`):
 *   - `classify_rejected` — URL shape itself unacceptable; copy is
 *     keyed off the shared `ServerUrlRejectionReason`.
 *   - `tls_failed` — TLS handshake failed; typed code from
 *     {@link classifyTlsError}. Wizard surfaces the runbook §12
 *     pointer per code.
 *   - `http_failed` — handshake succeeded but the server responded
 *     non-2xx (or `/api/server/info` is missing). The renderer
 *     shows status / statusText / a truncated body excerpt.
 *   - `network_failed` — the fetch threw but it's not a TLS error
 *     (DNS, refused, timeout, etc). Caller surfaces a generic
 *     "couldn't reach this URL" message.
 *   - `invalid_response` — server replied 2xx but the body did not
 *     parse to {@link ServerInfo}. Indicates we're talking to
 *     something at that URL but it isn't a Silverhand backend.
 */
export type ProbeServerInfoResult =
  | {
      ok: true;
      kind: 'system_ca_verified' | 'loopback_ok' | 'insecure_dev_remote';
      info: ServerInfo;
    }
  | {
      ok: false;
      kind: 'classify_rejected';
      reason: ServerUrlRejectionReason;
      message: string;
    }
  | {
      ok: false;
      kind: 'tls_failed';
      code: TlsErrorCode;
      message: string;
    }
  | {
      ok: false;
      kind: 'http_failed';
      status: number;
      statusText: string;
      bodyText: string;
    }
  | { ok: false; kind: 'network_failed'; message: string }
  | { ok: false; kind: 'invalid_response'; message: string };

/**
 * Minimal fetch surface. Production callers pass `globalThis.fetch`;
 * tests pass a fake.
 */
export type FetcherFn = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

export interface ProbeServerInfoOptions {
  /** Raw URL the user typed. Trimmed by the caller; this helper does
   *  not normalize whitespace. */
  serverUrl: string;
  /** Value of the `SILVERHAND_ALLOW_INSECURE_REMOTE` env (true when
   *  set to `'1'`). The classifier needs it to decide whether to
   *  admit non-loopback http URLs. */
  allowInsecureRemote: boolean;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetcher?: FetcherFn;
  /** Caller-supplied abort signal — e.g. a future "cancel test" button.
   *  Combined with the internal timeout signal via
   *  `AbortSignal`-style chaining; whichever fires first wins. */
  signal?: AbortSignal;
  /**
   * Timeout in milliseconds for the entire fetch round-trip. Default
   * {@link DEFAULT_PROBE_TIMEOUT_MS} (Cindy D4.a Commit 2 review):
   * a black-hole network would otherwise leave the Wizard stuck in
   * "submitting" until the OS-level TCP timeout (minutes) fires. Pass
   * `null` to disable the timeout (used by some tests).
   *
   * On timeout the result is `{ kind: 'network_failed' }` with a
   * timeout-specific message so the UI can distinguish "took too long"
   * from generic ECONNREFUSED.
   */
  timeoutMs?: number | null;
}

/**
 * Default probe timeout. 10 seconds is long enough for a sane round
 * trip across continents (typical < 1s, but VPN / Tor / satellite can
 * stretch to seconds) without leaving the wizard stuck on a black-hole
 * network for minutes.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Compose `<url>/api/server/info` without losing query / fragment
 * semantics. `URL` does the right thing here: the trailing path is
 * resolved against the base origin, dropping any base path. We
 * deliberately do NOT support a base path on `server_url` — the
 * Wizard / Settings UI accepts only origin-shaped URLs.
 */
function serverInfoUrl(base: URL): string {
  // `URL` always emits a trailing slash on origins, so concatenation
  // works without a manual normalization step. Use `apiPaths.serverInfo`
  // so this stays in sync with the backend route registration.
  const u = new URL(apiPaths.serverInfo, base);
  return u.toString();
}

function describeTlsCodeShort(code: TlsErrorCode): string {
  // Caller wraps for log lines; the renderer keys i18n off the
  // typed `code` directly.
  switch (code) {
    case 'host_tls_chain_invalid':
      return 'TLS chain not trusted';
    case 'host_tls_hostname_mismatch':
      return 'TLS hostname mismatch';
    case 'host_tls_expired':
      return 'TLS certificate expired or not yet valid';
  }
}

export async function probeServerInfo(
  opts: ProbeServerInfoOptions,
): Promise<ProbeServerInfoResult> {
  const classification = classifyServerUrl(opts.serverUrl, {
    allowInsecureRemote: opts.allowInsecureRemote,
  });
  if (!classification.ok) {
    return {
      ok: false,
      kind: 'classify_rejected',
      reason: classification.reason,
      message: classification.message,
    };
  }
  const fetcher = opts.fetcher ?? (globalThis.fetch as FetcherFn);
  const url = serverInfoUrl(classification.url);
  // Timeout + caller-signal composition (Cindy D4.a Commit 2 review
  // fixup): we MUST own the timeout in main so a black-hole network
  // does not leave the Wizard stuck for the OS-level TCP timeout. The
  // internal `AbortController` races against any caller-supplied
  // signal; whichever fires first aborts the fetch. We track WHICH
  // source triggered the abort so the error message is honest about
  // the cause (timeout vs caller cancel vs network), and we always
  // clear the timer and detach the caller listener via `finally` so
  // there are no lingering timers / listeners after a fast response.
  const timeoutMs =
    opts.timeoutMs === undefined ? DEFAULT_PROBE_TIMEOUT_MS : opts.timeoutMs;
  const controller = new AbortController();
  // Mutable cell so TypeScript does NOT narrow based on the visible
  // synchronous assignments — the `setTimeout` closure writes
  // `value = 'timeout'` asynchronously which TS can't track through
  // control flow, and a plain `let abortedBy` would get narrowed away
  // by the time we read it after `await`.
  const abortedBy: { value: 'timeout' | 'caller' | null } = { value: null };
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const onCallerAbort = (): void => {
    if (abortedBy.value === null) abortedBy.value = 'caller';
    controller.abort();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      abortedBy.value = 'caller';
      controller.abort();
    } else {
      opts.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }
  if (timeoutMs !== null && abortedBy.value === null) {
    timeoutHandle = setTimeout(() => {
      if (abortedBy.value === null) abortedBy.value = 'timeout';
      controller.abort();
    }, timeoutMs);
  }
  let res: Awaited<ReturnType<FetcherFn>>;
  try {
    res = await fetcher(url, { signal: controller.signal });
  } catch (err) {
    const tls = classifyTlsError(err);
    if (tls !== null) {
      return {
        ok: false,
        kind: 'tls_failed',
        code: tls,
        message: describeTlsCodeShort(tls),
      };
    }
    // Honest abort attribution: a timeout-induced AbortError gets a
    // dedicated message so the wizard can render "took too long"
    // copy; a caller-induced one says "canceled"; anything else falls
    // through to the underlying error message. We deliberately do NOT
    // mint a separate `kind` for timeout (Cindy review: AbortError
    // stays under `network_failed`, only the message differentiates)
    // — the renderer keys i18n off the discriminator, and proliferating
    // arms for what's structurally the same failure (no HTTP
    // round-trip completed) would make the UI surface noisier without
    // adding remediation value.
    if (abortedBy.value === 'timeout') {
      return {
        ok: false,
        kind: 'network_failed',
        message: `Request to ${url} timed out after ${timeoutMs} ms.`,
      };
    }
    if (abortedBy.value === 'caller') {
      return {
        ok: false,
        kind: 'network_failed',
        message: 'Connection test canceled.',
      };
    }
    return {
      ok: false,
      kind: 'network_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    if (opts.signal) {
      opts.signal.removeEventListener('abort', onCallerAbort);
    }
  }
  if (!res.ok) {
    const bodyText = await safeReadText(res);
    return {
      ok: false,
      kind: 'http_failed',
      status: res.status,
      statusText: res.statusText,
      bodyText,
    };
  }
  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch (err) {
    return {
      ok: false,
      kind: 'invalid_response',
      message:
        err instanceof Error
          ? `Failed to read response body: ${err.message}`
          : 'Failed to read response body',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    return {
      ok: false,
      kind: 'invalid_response',
      message:
        err instanceof Error
          ? `Response body is not valid JSON: ${err.message}`
          : 'Response body is not valid JSON',
    };
  }
  const schema = ServerInfoSchema.safeParse(parsed);
  if (!schema.success) {
    return {
      ok: false,
      kind: 'invalid_response',
      message: `/api/server/info response did not match schema: ${schema.error.message}`,
    };
  }
  // Pick the success arm based on the classification — keep this
  // mapping in one place so the renderer can rely on the
  // discriminator.
  const successKind: 'loopback_ok' | 'insecure_dev_remote' | 'system_ca_verified' =
    classification.kind === 'loopback'
      ? 'loopback_ok'
      : classification.insecure
        ? 'insecure_dev_remote'
        : 'system_ca_verified';
  return { ok: true, kind: successKind, info: schema.data };
}

async function safeReadText(res: {
  text(): Promise<string>;
}): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
