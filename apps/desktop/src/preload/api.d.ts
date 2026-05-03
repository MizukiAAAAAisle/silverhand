export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  auth_token: string;
}

export interface ActiveSessionInfo {
  channelId: string | null;
  sessionId: string | null;
}

declare global {
  interface Window {
    agentHub: {
      getBackendInfo(): Promise<BackendInfo | null>;
      pickDirectory(options?: { defaultPath?: string }): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      showItemInFolder(path: string): Promise<void>;
      setWindowAlwaysOnTop(pinned: boolean): Promise<void>;
      setActiveSession(active: ActiveSessionInfo): Promise<void>;
      onActiveSession(handler: (active: ActiveSessionInfo) => void): () => void;
      showSystemNotification(opts: { title: string; body: string }): Promise<void>;
    };
  }
}

export {};
