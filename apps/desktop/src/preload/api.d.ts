export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  auth_token: string;
}

declare global {
  interface Window {
    agentHub: {
      getBackendInfo(): Promise<BackendInfo | null>;
      pickDirectory(options?: { defaultPath?: string }): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      showItemInFolder(path: string): Promise<void>;
      setWindowAlwaysOnTop(pinned: boolean): Promise<void>;
    };
  }
}

export {};
