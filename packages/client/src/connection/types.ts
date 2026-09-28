import type { ServerInfo, TlsErrorCode, ServerConnectionProfileView } from "@silverhand/shared";
import type { LocalHostProfileApplyOutcome } from "../platform/local-host.js";

export interface ConnectionInfo {
  url: string;
  mode: "embedded" | "remote";
}

export type ProbeServerInfoResult =
  | {
      ok: true;
      kind: "system_ca_verified" | "loopback_ok" | "insecure_dev_remote";
      info: ServerInfo;

      originUrl: string;
    }
  | {
      ok: false;
      kind: "classify_rejected";

      reason:
        | "malformed_url"
        | "unsupported_scheme"
        | "non_origin_url"
        | "insecure_remote_http_disallowed"
        | "obfuscated_loopback_disallowed";
      message: string;
    }
  | { ok: false; kind: "tls_failed"; code: TlsErrorCode; message: string }
  | {
      ok: false;
      kind: "http_failed";
      status: number;
      statusText: string;
      bodyText: string;
    }
  | { ok: false; kind: "network_failed"; message: string }
  | { ok: false; kind: "invalid_response"; message: string };

export type ProfileSaveWithTestResult =
  | {
      ok: true;
      test: ProbeServerInfoResult & { ok: true };
      profile: ServerConnectionProfileView;

      phase2?: LocalHostProfileApplyOutcome;
    }
  | {
      ok: false;
      phase: "test";
      test: ProbeServerInfoResult & { ok: false };
    }
  | {
      ok: false;
      phase: "commit_guard";
      reason: "remote_backend_not_yet_supported";
      message: string;
      test: ProbeServerInfoResult & { ok: true };
    }
  | {
      ok: false;
      phase: "write";
      reason: "write_failed";
      detail?: string;
    };

export type ClearProfileResult =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: "unlink_failed"; detail: string };

export interface ConnectionPolicy {
  allow_insecure_remote: boolean;
}
