import type { ServerInfo } from '@silverhand/shared';
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  BackendProxyRequest,
  BackendProxyResponse,
  ClientAuthResult,
} from '@silverhand/client';

export interface NativeSocketEvent {
  id: string;
  type: 'open' | 'message' | 'close' | 'error';
  data?: string;
  code?: number;
}
export interface NativeBridge {
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
  openExternal(input: { url: string }): Promise<void>;
  addListener(
    event: 'socket',
    handler: (event: NativeSocketEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(event: 'sessionInvalidated', handler: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'foreground', handler: () => void): Promise<PluginListenerHandle>;
}
export const nativeBridge = registerPlugin<NativeBridge>('SilverhandClient');
