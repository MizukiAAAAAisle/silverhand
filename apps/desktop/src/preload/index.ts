import { contextBridge, ipcRenderer } from 'electron';

export interface BackendInfo {
  url: string;
  mode: 'embedded' | 'remote';
  auth_token: string;
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
};

contextBridge.exposeInMainWorld('agentHub', api);
