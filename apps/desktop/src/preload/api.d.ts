import type { AuthLoginInput, AuthSignupInput, UserDto } from '@silverhand/shared';

export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  /** Legacy event-websocket bearer. HTTP auth is held in main and is
   *  never exposed to the renderer. */
  event_auth_token: string;
  local_host_id: string | null;
  local_host_status: 'unclaimed' | 'claimed' | 'revoked' | 'error';
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
