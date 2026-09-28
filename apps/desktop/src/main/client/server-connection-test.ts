import {
  ServerInfoSchema,
  apiPaths,
  classifyServerUrl,
  classifyTlsError,
  type ServerInfo,
  type ServerUrlRejectionReason,
  type TlsErrorCode,
} from "@silverhand/shared";

/**
 * Discriminated outcome the renderer branches on.
 *
 * Success kinds (all `ok: true`):
 *   - `system_ca_verified` — remote https; Node's default trust store
 *     verified the chain (§8.1 single accept state for remote TLS).
 *   - `loopback_ok` — loopback http/https; no remote TLS path involved.
 *     The wizard renders "embedded backend" copy.
 *   - `insecure_dev_remote` — non-loopback http admitted by explicit
 *     insecure-remote opt-in. Wizard MUST render a "connection is
 *     unencrypted" warning.
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
      kind: "system_ca_verified" | "loopback_ok" | "insecure_dev_remote";
      info: ServerInfo;
      /**
       * Examples (post-classification — values that PASS the probe):
       *   `http://localhost:3000/` → `http://localhost:3000`
       *   `https://example.com`    → `https://example.com`
       *   `https://example.com:443`→ `https://example.com`
       *   `http://[::1]:8080/`     → `http://[::1]:8080`
       */
      originUrl: string;
    }
  | {
      ok: false;
      kind: "classify_rejected";
      reason: ServerUrlRejectionReason;
      message: string;
    }
  | {
      ok: false;
      kind: "tls_failed";
      code: TlsErrorCode;
      message: string;
    }
  | {
      ok: false;
      kind: "http_failed";
      status: number;
      statusText: string;
      bodyText: string;
    }
  | { ok: false; kind: "network_failed"; message: string }
  | { ok: false; kind: "invalid_response"; message: string };

export interface ProbeServerInfoOptions {
  /** Raw URL the user typed. Trimmed by the caller; this helper does
   *  not normalize whitespace. */
  serverUrl: string;
  /** Caller-side policy bit. The classifier needs it to decide whether
   *  to admit non-loopback http URLs. */
  allowInsecureRemote: boolean;
}

/**
 * Default probe timeout. 10 seconds is long enough for a sane round
 * trip across continents (typical < 1s, but VPN / Tor / satellite can
 * stretch to seconds) without leaving the wizard stuck on a black-hole
 * network for minutes.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

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
    case "host_tls_chain_invalid":
      return "TLS chain not trusted";
    case "host_tls_hostname_mismatch":
      return "TLS hostname mismatch";
    case "host_tls_expired":
      return "TLS certificate expired or not yet valid";
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
      kind: "classify_rejected",
      reason: classification.reason,
      message: classification.message,
    };
  }
  const url = serverInfoUrl(classification.url);
  // Bound the connection/header wait; body parsing is handled below.
  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    const tls = classifyTlsError(err);
    if (tls !== null) {
      return {
        ok: false,
        kind: "tls_failed",
        code: tls,
        message: describeTlsCodeShort(tls),
      };
    }
    if (timedOut) {
      return {
        ok: false,
        kind: "network_failed",
        message: `Request to ${url} timed out after ${DEFAULT_PROBE_TIMEOUT_MS} ms.`,
      };
    }
    return {
      ok: false,
      kind: "network_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!res.ok) {
    const bodyText = await safeReadText(res);
    return {
      ok: false,
      kind: "http_failed",
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
      kind: "invalid_response",
      message:
        err instanceof Error
          ? `Failed to read response body: ${err.message}`
          : "Failed to read response body",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    return {
      ok: false,
      kind: "invalid_response",
      message:
        err instanceof Error
          ? `Response body is not valid JSON: ${err.message}`
          : "Response body is not valid JSON",
    };
  }
  const schema = ServerInfoSchema.safeParse(parsed);
  if (!schema.success) {
    return {
      ok: false,
      kind: "invalid_response",
      message: `/api/server/info response did not match schema: ${schema.error.message}`,
    };
  }
  // Pick the success arm based on the classification — keep this
  // mapping in one place so the renderer can rely on the
  // discriminator.
  const successKind: "loopback_ok" | "insecure_dev_remote" | "system_ca_verified" =
    classification.kind === "loopback"
      ? "loopback_ok"
      : classification.insecure
        ? "insecure_dev_remote"
        : "system_ca_verified";
  return {
    ok: true,
    kind: successKind,
    info: schema.data,
    // §7.1 origin-only invariant — `classifyServerUrl` already
    // rejected non-origin URLs upstream, so `classification.url.origin`
    // is the canonical persistable form of the user-typed URL.
    originUrl: classification.url.origin,
  };
}

async function safeReadText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
