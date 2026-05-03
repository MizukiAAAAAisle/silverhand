import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  auth_token: string;
}

export interface ActiveSessionInfo {
  channelId: string | null;
  sessionId: string | null;
}

const api = {
  getBackendInfo: (): Promise<BackendInfo | null> => ipcRenderer.invoke('backend:info'),
  pickDirectory: (options?: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickDirectory', options),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', path),
  setWindowAlwaysOnTop: (pinned: boolean): Promise<void> =>
    ipcRenderer.invoke('window:setAlwaysOnTop', pinned),
  setActiveSession: (active: ActiveSessionInfo): Promise<void> =>
    ipcRenderer.invoke('active-session:set', active),
  onActiveSession: (handler: (active: ActiveSessionInfo) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, active: ActiveSessionInfo) => {
      handler(active);
    };
    ipcRenderer.on('active-session:update', listener);
    return () => ipcRenderer.off('active-session:update', listener);
  },
  showSystemNotification: (opts: { title: string; body: string }): Promise<void> =>
    ipcRenderer.invoke('notification:show', opts),
};

contextBridge.exposeInMainWorld('agentHub', api);
