import type { HostProxyConfig, HostDto } from "@silverhand/shared";

export type LocalHostWsAttachment =
  | { observable: true; attached_at: number | null }
  | { observable: false };

export interface LocalHostInfo {
  outbound_protocol_compatibility:
    | {
        status: "compatible" | "app_update_required" | "server_update_required";
        app_protocol_version: number;
        server_protocol_version: number;
      }
    | {
        status: "unknown";
        app_protocol_version: number;
        server_protocol_version: null;
      };
  local_host_id: string | null;
  local_host_status: "unclaimed" | "claimed" | "revoked" | "error" | "failed";

  local_host_ws_attachment: LocalHostWsAttachment;

  local_host_server_url: string | null;
}

export type LocalHostProxyConfig = HostProxyConfig;

export type LocalHostProxyConfigResult =
  | { ok: true; config: LocalHostProxyConfig }
  | {
      ok: false;
      code:
        | "not_local_host"
        | "unauthorized"
        | "host_not_found"
        | "host_not_active"
        | "host_revoked"
        | "computer_offline"
        | "daemon_unavailable"
        | "daemon_error"
        | "invalid_input";
      message?: string;
    };

export type LocalHostMutationResult =
  | {
      ok: true;
      host: HostDto;
      local_host_id: LocalHostInfo["local_host_id"];
      local_host_status: LocalHostInfo["local_host_status"];
      local_host_ws_attachment: LocalHostInfo["local_host_ws_attachment"];

      local_host_server_url: LocalHostInfo["local_host_server_url"];
    }
  | {
      ok: false;
      code:
        | "unauthorized"
        | "not_current_host"
        | "host_not_found"
        | "host_revoked"
        | "kind_not_supported"
        | "invalid_response"
        | "network_error";
      message?: string;
    };

export type LocalHostSaveServerUrlResult =
  | { ok: true; kind: "reloaded"; elapsedMs: number; attachedAt: number }
  | { ok: true; kind: "unchanged" }
  | { ok: true; kind: "connectivity_unverified"; elapsedMs: number }
  | { ok: true; kind: "reloaded_remote" }
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
  | { ok: false; kind: "config_write_failed"; message: string }
  | {
      ok: false;
      kind: "reload_rejected";
      reason: "not_attached" | "config_unreadable" | "parse_failed" | "invalid_server_url";
      message: string;
    }
  | { ok: false; kind: "no_attachment_controller"; message: string };

export type LocalHostProfileApplyOutcome =
  | {
      kind: "fully_applied";
      profileVersion: number;
      reloadKind: "reloaded" | "unchanged" | "connectivity_unverified";
      elapsedMs: number;
    }
  | {
      kind: "no_op_no_host_claim";
      profileVersion: number;
    }
  | {
      kind: "partial_apply_pending";
      profileVersion: number;
      reason:
        | "config_write_failed"
        | "reload_rejected"
        | "no_attachment_controller"
        | "host_token_missing";
      reloadRejectionReason:
        | "not_attached"
        | "config_unreadable"
        | "parse_failed"
        | "invalid_server_url"
        | null;
      detail: string;
    };

export type LocalHostPartialApplyState =
  | { kind: "fully_applied" }
  | { kind: "no_profile" }
  | {
      kind: "unusable_profile";

      reason: "parse_failed";
      detail: string;
      lastReadAt: number;
    }
  | {
      kind: "partial_apply_pending";
      profileVersion: number;
      reason:
        | "config_write_failed"
        | "reload_rejected"
        | "no_attachment_controller"
        | "host_token_missing";
      reloadRejectionReason:
        | "not_attached"
        | "config_unreadable"
        | "parse_failed"
        | "invalid_server_url"
        | null;
      detail: string;
      lastAttemptAt: number;
    };

export type LocalHostPartialApplyRetryResult =
  | {
      ok: true;
      outcome: LocalHostProfileApplyOutcome;
      state: LocalHostPartialApplyState;
    }
  | { ok: false; reason: "no_profile" }
  | { ok: false; reason: "profile_unreadable"; detail: string };

export interface LocalHostCapability {
  getSnapshot(): Promise<LocalHostInfo | null>;
  rotateHostToken(input: { hostId: string }): Promise<LocalHostMutationResult>;
  getHostProxyConfig(input: { hostId: string }): Promise<LocalHostProxyConfigResult>;
  saveHostProxyConfig(input: {
    hostId: string;
    config: LocalHostProxyConfig;
  }): Promise<LocalHostProxyConfigResult>;
  saveServerUrl(input: { serverUrl: string }): Promise<LocalHostSaveServerUrlResult>;
  getPartialApplyState(): Promise<LocalHostPartialApplyState>;
  retryPartialApply(): Promise<LocalHostPartialApplyRetryResult>;
  pickDirectory(options?: { defaultPath?: string }): Promise<string | null>;
}
