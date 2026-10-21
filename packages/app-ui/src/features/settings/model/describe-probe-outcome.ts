import type { ProbeServerInfoResult } from "@silverhand/client";
import { t } from "@/lib/i18n";

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
          title: t("settings.probe.trusted"),
          description: result.info.signup_enabled
            ? t("settings.probe.signupEnabledLong")
            : t("settings.probe.signupDisabledLong"),
        };
      case "loopback_ok":
        // Loopback = embedded backend / local dev. No remote TLS path
        // is involved; the copy reflects that without claiming "TLS
        // verified" (which would be misleading on http loopback).
        return {
          tone: "success",
          title: t("settings.probe.local"),
          description: result.info.signup_enabled
            ? t("settings.probe.signupEnabled")
            : t("settings.probe.signupDisabled"),
        };
      case "insecure_dev_remote":
        // The dev escape hatch: http to a non-loopback host. The
        // warn tone is intentional — the connection is unencrypted
        // and the operator MUST know.
        return {
          tone: "warn",
          title: t("settings.probe.unencrypted"),
          description: t("settings.probe.unencryptedDetail"),
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
            title: t("settings.probe.invalid"),
            description: result.message,
          };
        case "unsupported_scheme":
          return {
            tone: "error",
            title: t("settings.probe.scheme"),
            description: result.message,
          };
        case "non_origin_url":
          return {
            tone: "error",
            title: t("settings.probe.origin"),
            description: t("settings.probe.originDetail"),
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
            title: t("settings.probe.loopback"),
            description: t("settings.probe.loopbackDetail"),
          };
      }
      // Exhaustiveness — TS catches new reasons added without copy.
      return {
        tone: "error",
        title: t("settings.probe.rejected"),
        description: result.message,
      };
    case "tls_failed":
      // Per the d4-design §8.2 runbook the three typed codes get
      // distinct copy pointing operators at the right fix.
      switch (result.code) {
        case "host_tls_chain_invalid":
          return {
            tone: "error",
            title: t("settings.probe.certUntrusted"),
            description: t("settings.probe.certUntrustedDetail"),
          };
        case "host_tls_hostname_mismatch":
          return {
            tone: "error",
            title: t("settings.probe.certHostname"),
            description: t("settings.probe.certHostnameDetail"),
          };
        case "host_tls_expired":
          return {
            tone: "error",
            title: t("settings.probe.certExpired"),
            description: t("settings.probe.certExpiredDetail"),
          };
      }
      // Exhaustiveness — TS catches new codes added without copy.
      return {
        tone: "error",
        title: t("settings.probe.tlsFailed"),
        description: result.message,
      };
    case "http_failed":
      return {
        tone: "error",
        title: t("settings.probe.httpStatus", {
          status: result.status,
          statusText: result.statusText,
        }),
        description:
          result.bodyText.length > 0
            ? t("settings.probe.body", { body: truncate(result.bodyText, 200) })
            : t("settings.probe.checkUrl"),
      };
    case "network_failed":
      return {
        tone: "error",
        title: t("settings.probe.unreachable"),
        description: result.message,
      };
    case "invalid_response":
      return {
        tone: "error",
        title: t("settings.probe.notSilverhand"),
        description: result.message,
      };
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
