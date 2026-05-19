import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  auth_token: string;
}

export interface ActiveConversationInfo {
  workspaceId: string | null;
  conversationId: string | null;
}

const api = {
  getBackendInfo: (): Promise<BackendInfo | null> => ipcRenderer.invoke('backend:info'),
  pickDirectory: (options?: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickDirectory', options),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  /** Save attachment bytes to a per-app temp dir and hand the file off
   *  to the OS default handler (e.g. open `.html` in the user's
   *  browser). The renderer is responsible for fetching the bytes via
   *  the authenticated backend route — main never sees the auth token
   *  or user principal here. See `attachment:openExternal` in main. */
  openAttachmentExternal: (input: {
    filename: string;
    bytes: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('attachment:openExternal', input),
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', path),
  setWindowAlwaysOnTop: (pinned: boolean): Promise<void> =>
    ipcRenderer.invoke('window:setAlwaysOnTop', pinned),
  setActiveConversation: (active: ActiveConversationInfo): Promise<void> =>
    ipcRenderer.invoke('active-conversation:set', active),
  onActiveConversation: (handler: (active: ActiveConversationInfo) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, active: ActiveConversationInfo) => {
      handler(active);
    };
    ipcRenderer.on('active-conversation:update', listener);
    return () => ipcRenderer.off('active-conversation:update', listener);
  },
  /** Subscribe to shutdown progress steps emitted by the main process
   *  just before and during graceful shutdown. Drives the in-app overlay
   *  so the user sees what's happening instead of a frozen window. */
  onShutdownProgress: (handler: (step: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, step: string) => handler(step);
    ipcRenderer.on('shutdown:progress', listener);
    return () => ipcRenderer.off('shutdown:progress', listener);
  },
  /** Fired by the App menu's "Settings…" item (Cmd+,) so the renderer
   *  can navigate to the Settings page. The main process also focuses
   *  the window before emitting, so the handler only needs to navigate. */
  onNavigateSettings: (handler: () => void): (() => void) => {
    const listener = (_event: IpcRendererEvent) => handler();
    ipcRenderer.on('navigate:settings', listener);
    return () => ipcRenderer.off('navigate:settings', listener);
  },
  showSystemNotification: (opts: { title: string; body: string }): Promise<void> =>
    ipcRenderer.invoke('notification:show', opts),
  setBadgeCount: (count: number): Promise<void> =>
    ipcRenderer.invoke('badge:setCount', count),
};

contextBridge.exposeInMainWorld('agentHub', api);
