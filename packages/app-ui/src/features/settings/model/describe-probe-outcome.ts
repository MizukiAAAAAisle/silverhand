import type { ProbeServerInfoResult } from "@silverhand/client";

export interface ProbeBanner {
  /** Visual tone — drives the banner chrome color. */
  tone: "success" | "warn" | "error";
  /** Short headline. ≤ ~70 chars; imperative or status form. */
  title: string;
  /** Optional diagnostic sub-line. Empty string when the title
   *  carries the full message. */
  description: string;
}

export function describeProbeOutcome(result: ProbeServerInfoResult): ProbeBanner {
  if (result.ok) {
    switch (result.kind) {
      case "system_ca_verified":
        return {
          tone: "success",
          title: "Connected — TLS verified by your system trust store.",
          description: result.info.signup_enabled
            ? "Signup is enabled on this backend. You can create a new account."
            : "Signup is disabled on this backend. You will need an existing account.",
        };
      case "loopback_ok":
        // Loopback = embedded backend / local dev. No remote TLS path
        // is involved; the copy reflects that without claiming "TLS
        // verified" (which would be misleading on http loopback).
        return {
          tone: "success",
          title: "Connected — local backend.",
          description: result.info.signup_enabled
            ? "Signup is enabled on this backend."
            : "Signup is disabled on this backend.",
        };
      case "insecure_dev_remote":
        // The dev escape hatch: http to a non-loopback host. The
        // warn tone is intentional — the connection is unencrypted
        // and the operator MUST know.
        return {
          tone: "warn",
          title: "Connected — UNENCRYPTED (dev mode).",
          description:
            "This URL uses http:// to a non-loopback host. Traffic is not encrypted. Switch to https:// for production.",
        };
    }
  }
  switch (result.kind) {
    case "classify_rejected":
      // Per-reason copy. Keep the reason strings synced with
      // `ServerUrlRejectionReason` in `@silverhand/shared`.
      switch (result.reason) {
        case "malformed_url":
          return {
            tone: "error",
            title: "That URL is not valid.",
            description: result.message,
          };
        case "unsupported_scheme":
          return {
            tone: "error",
            title: "Only http:// and https:// URLs are accepted.",
            description: result.message,
          };
        case "non_origin_url":
          return {
            tone: "error",
            title: "Backend URL must be an origin (scheme + host + port).",
            description:
              "Drop the path / query / fragment from the URL. Subpath deployments are not supported in this release.",
          };
        case "insecure_remote_http_disallowed":
          return {
            tone: "error",
            title: "Use https:// for non-local backends.",
            description:
              "http:// to a non-loopback host is rejected. For local dev you can set SILVERHAND_ALLOW_INSECURE_REMOTE=1 before launching; for production, use https://.",
          };
        case "obfuscated_loopback_disallowed":
          return {
            tone: "error",
            title: "Use a literal loopback address (127.0.0.1, localhost, or [::1]).",
            description:
              "Obfuscated forms (decimal IP, padded zeros, expanded IPv6) are rejected so the visible URL matches the host that will actually be contacted.",
          };
      }
      // Exhaustiveness — TS catches new reasons added without copy.
      return {
        tone: "error",
        title: "URL rejected.",
        description: result.message,
      };
    case "tls_failed":
      // Per the d4-design §8.2 runbook the three typed codes get
      // distinct copy pointing operators at the right fix.
      switch (result.code) {
        case "host_tls_chain_invalid":
          return {
            tone: "error",
            title: "The server's certificate is not trusted by your system CA store.",
            description:
              "Issue a certificate from a CA your machine already trusts (Let's Encrypt, Tailscale Funnel, or a private CA pre-installed in the system trust store). Self-signed certificates are not supported in this release.",
          };
        case "host_tls_hostname_mismatch":
          return {
            tone: "error",
            title: "The server's certificate does not cover this hostname.",
            description:
              "The certificate is trusted but its Subject Alternative Names do not include the host you typed. Reissue the certificate with the correct hostname, or use a URL that matches the certificate.",
          };
        case "host_tls_expired":
          return {
            tone: "error",
            title: "The server's certificate is expired or not yet valid.",
            description:
              "Renew the certificate on the server, or wait for it to become valid. Check your machine's clock if the cert should be valid right now.",
          };
      }
      // Exhaustiveness — TS catches new codes added without copy.
      return {
        tone: "error",
        title: "TLS handshake failed.",
        description: result.message,
      };
    case "http_failed":
      return {
        tone: "error",
        title: `Server responded ${result.status} ${result.statusText}.`,
        description:
          result.bodyText.length > 0
            ? `Body: ${truncate(result.bodyText, 200)}`
            : "Check that the URL points to a Silverhand backend and that /api/server/info is reachable.",
      };
    case "network_failed":
      return {
        tone: "error",
        title: "Could not reach that URL.",
        description: result.message,
      };
    case "invalid_response":
      return {
        tone: "error",
        title: "That URL responded, but it does not look like a Silverhand backend.",
        description: result.message,
      };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
