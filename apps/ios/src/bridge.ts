import type { ServerInfo } from '@silverhand/shared';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  BackendProxyRequest,
  BackendProxyResponse,
  ClientAuthResult,
  NativeNavigationState,
  NativeNavigationIntent,
} from '@silverhand/client';

export interface NativeSocketEvent {
  id: string;
  type: 'open' | 'message' | 'close' | 'error';
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
  navigationSync(state: NativeNavigationState): Promise<{ bottomInset: number }>;
  navigationCapture(input: { session: string; key: string }): Promise<void>;
  navigationFinish(input: { session: string; request: string; accepted: boolean }): Promise<void>;
  navigationReset(input: { session: string }): Promise<void>;
  addListener(
    event: 'navigation',
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
  authenticate(input: { action: 'login' | 'signup'; body: string }): Promise<ClientAuthResult>;
  logout(): Promise<void>;
  request(input: BackendProxyRequest): Promise<BackendProxyResponse & { bodyBase64?: string }>;
  openSocket(input: { id: string; url: string }): Promise<void>;
  sendSocket(input: { id: string; data: string }): Promise<void>;
  closeSocket(input: { id: string }): Promise<void>;
  sharePng(input: { base64: string }): Promise<{ completed: boolean }>;
  openExternal(input: { url: string }): Promise<void>;
  addListener(
    event: 'socket',
    handler: (event: NativeSocketEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: 'sessionInvalidated', handler: () => void): Promise<PluginListenerHandle>;
  addListener(
    event: 'keyboardChanged',
    handler: (state: { docked: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: 'foreground', handler: () => void): Promise<PluginListenerHandle>;
}
export const nativeBridge = registerPlugin<NativeBridge>('SilverhandClient');
