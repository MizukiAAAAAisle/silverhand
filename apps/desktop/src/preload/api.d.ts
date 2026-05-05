export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  auth_token: string;
}

export interface ActiveConversationInfo {
  workspaceId: string | null;
  conversationId: string | null;
}

declare global {
  interface Window {
    agentHub: {
      getBackendInfo(): Promise<BackendInfo | null>;
      pickDirectory(options?: { defaultPath?: string }): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      showItemInFolder(path: string): Promise<void>;
      setWindowAlwaysOnTop(pinned: boolean): Promise<void>;
      setActiveConversation(active: ActiveConversationInfo): Promise<void>;
      onActiveConversation(handler: (active: ActiveConversationInfo) => void): () => void;
      showSystemNotification(opts: { title: string; body: string }): Promise<void>;
      onShutdownProgress(handler: (step: string) => void): () => void;
    };
  }
}

export {};
