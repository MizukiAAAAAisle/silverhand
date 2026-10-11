import type { ServerInfo } from "@silverhand/shared";
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type {
  TitlebarEvent,
  TitlebarState,
  PageBarEvent,
  PageBarState,
  BackendProxyRequest,
  BackendProxyResponse,
  ClientAuthResult,
  NativeNavigationState,
  NativeNavigationIntent,
} from "@silverhand/client";

export interface NativeSocketEvent {
  id: string;
  type: "open" | "message" | "close" | "error";
  data?: string;
  code?: number;
}
export interface NativeBridge {
  navigationBadges(input: {
    session: string;
    chat?: boolean;
    activity?: boolean;
    tasks?: boolean;
  }): Promise<void>;
  navigationSync(state: NativeNavigationState): Promise<{ tabBarHeight: number }>;
  navigationReset(input: { session: string }): Promise<void>;
  navigationAvatar(input: { base64?: string }): Promise<void>;
  /** Groups of page controls the iPhone Duo vertical bar draws. */
  /** The wide layout's native titlebar; a null state removes it. */
  titlebar(input: { state: TitlebarState | null }): Promise<void>;
  titlebarEndSearch(input: { clear: boolean }): Promise<void>;
  /** A compact page's header as the native navigation bar; icons are base64
   * PNG. A null state removes it. */
  pageBar(input: { state: PageBarState | null }): Promise<void>;
  pageBarBackProgress(input: { progress: number | null }): Promise<void>;
  addListener(
    event: "navigation",
    handler: (intent: NativeNavigationIntent) => void,
  ): Promise<PluginListenerHandle>;
  getProfile(): Promise<{ server_url: string; updated_at: number } | { server_url: null }>;
  saveProfile(input: {
    serverUrl: string;
  }): Promise<{ server_url: string; updated_at: number; info: ServerInfo }>;
  clearProfile(): Promise<{ cleared: boolean }>;
  authState(): Promise<{
    serverUrl: string;
    info: BackendProxyResponse;
    me?: BackendProxyResponse;
  }>;
  authenticate(input: { action: "login" | "signup"; body: string }): Promise<ClientAuthResult>;
  logout(): Promise<void>;
  request(input: BackendProxyRequest): Promise<BackendProxyResponse & { bodyBase64?: string }>;
  openSocket(input: { id: string; url: string }): Promise<void>;
  sendSocket(input: { id: string; data: string }): Promise<void>;
  closeSocket(input: { id: string }): Promise<void>;
  saveAttachment(input: { filename: string; base64: string }): Promise<{ completed: boolean }>;
  sharePng(input: { base64: string }): Promise<{ completed: boolean }>;
  openExternal(input: { url: string }): Promise<void>;
  addListener(
    event: "socket",
    handler: (event: NativeSocketEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: "sessionInvalidated", handler: () => void): Promise<PluginListenerHandle>;
  addListener(
    event: "keyboardChanged",
    handler: (state: { docked: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: "foreground", handler: () => void): Promise<PluginListenerHandle>;
  addListener(
    event: "titlebar",
    handler: (event: TitlebarEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "pageBar",
    handler: (event: PageBarEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "fold",
    handler: (
      state: { axis: "vertical" | "horizontal"; start: number; end: number } | { axis?: undefined },
    ) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: "barMetrics",
    handler: (metrics: { bottom: number; tabs: number }) => void,
  ): Promise<PluginListenerHandle>;
}
export const nativeBridge = registerPlugin<NativeBridge>("SilverhandClient");
