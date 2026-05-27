import type {
  AuthLoginInput,
  AuthSignupInput,
  HostDto,
  UserDto,
} from '@silverhand/shared';

export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  local_host_id: string | null;
  local_host_status: 'unclaimed' | 'claimed' | 'revoked' | 'error';
  /**
   * D3.a Commit 4 — diagnostic timestamp of the daemon outbound WS
   * attachment for `local_host_id`, as reported by the backend's
   * `HostWsServerController.getAttachment`. `null` when no
   * attachment is live (pre-attach, post-revoke, daemon down).
   *
   * Renderer may surface this as "connected since" UI. It MUST NOT
   * be used to derive a new status word — the user-facing status
   * enum stays the 4-value `local_host_status` and nothing else.
   */
  local_host_ws_attached_at: number | null;
}

export interface ActiveConversationInfo {
  workspaceId: string | null;
  conversationId: string | null;
}

export type DesktopAuthState =
  | { status: 'authenticated'; signup_enabled: boolean; user: UserDto }
  | { status: 'unauthenticated'; signup_enabled: boolean };

export type DesktopAuthResult =
  | { ok: true; user: UserDto }
  | { ok: false; status: number; statusText: string; bodyText: string };

export interface BackendProxyRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  responseType?: 'text' | 'arrayBuffer';
}

export interface BackendProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBytes?: Uint8Array;
}

export interface BackendUploadField {
  name: string;
  value: string;
}

export interface BackendUploadFile {
  fieldName: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface BackendUploadRequest {
  path: string;
  fields: BackendUploadField[];
  files: BackendUploadFile[];
}

/** Stage B.4 — see `apps/desktop/src/preload/index.ts` for the
 *  invariants. Token bytes never appear in this shape. */
export type DesktopHostMutationResult =
  | {
      ok: true;
      host: HostDto;
      local_host_id: BackendInfo['local_host_id'];
      local_host_status: BackendInfo['local_host_status'];
      local_host_ws_attached_at: BackendInfo['local_host_ws_attached_at'];
    }
  | {
      ok: false;
      code:
        | 'unauthorized'
        | 'not_current_host'
        | 'host_not_found'
        | 'host_revoked'
        | 'kind_not_supported'
        | 'invalid_response'
        | 'network_error';
      message?: string;
    };

declare global {
  interface Window {
    agentHub: {
      getBackendInfo(): Promise<BackendInfo | null>;
      getAuthState(): Promise<DesktopAuthState>;
      signup(input: AuthSignupInput): Promise<DesktopAuthResult>;
      login(input: AuthLoginInput): Promise<DesktopAuthResult>;
      logout(): Promise<{ ok: true }>;
      backendRequest(input: BackendProxyRequest): Promise<BackendProxyResponse>;
      backendUpload(input: BackendUploadRequest): Promise<BackendProxyResponse>;
      rotateHostToken(input: { hostId: string }): Promise<DesktopHostMutationResult>;
      revokeHost(input: { hostId: string }): Promise<DesktopHostMutationResult>;
      pickDirectory(options?: { defaultPath?: string }): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      openAttachmentExternal(input: {
        filename: string;
        bytes: Uint8Array;
      }): Promise<{ ok: true } | { ok: false; reason: string }>;
      showItemInFolder(path: string): Promise<void>;
      setWindowAlwaysOnTop(pinned: boolean): Promise<void>;
      setActiveConversation(active: ActiveConversationInfo): Promise<void>;
      onActiveConversation(handler: (active: ActiveConversationInfo) => void): () => void;
      showSystemNotification(opts: {
        title: string;
        body: string;
        force?: boolean;
        notificationId?: string;
      }): Promise<void>;
      onNotificationClicked(handler: (notificationId: string) => void): () => void;
      setBadgeCount(count: number): Promise<void>;
      onShutdownProgress(handler: (step: string) => void): () => void;
      onNavigateSettings(handler: () => void): () => void;
      savePngExport(input: {
        pngBytes: Uint8Array;
        suggestedName: string;
      }): Promise<
        | { ok: true; path: string }
        | { ok: false; canceled: true }
        | { ok: false; error: string }
      >;
      copyPngExport(input: {
        pngBytes: Uint8Array;
      }): Promise<{ ok: true } | { ok: false; error: string }>;
    };
  }
}

export {};
