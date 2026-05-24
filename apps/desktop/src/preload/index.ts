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
  showSystemNotification: (opts: {
    title: string;
    body: string;
    force?: boolean;
    /** Opaque id echoed back via `onNotificationClicked` so the renderer
     *  can route the click to the right navigation target. Fire-and-
     *  forget if omitted (the notification is just informational). */
    notificationId?: string;
  }): Promise<void> =>
    ipcRenderer.invoke('notification:show', opts),
  /** Subscribe to native-notification click events. Main fires this
   *  when the user clicks an OS-level Silverhand notification, after
   *  focusing the window. The id matches what the renderer originally
   *  passed to `showSystemNotification`. */
  onNotificationClicked: (handler: (notificationId: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, notificationId: string) => {
      handler(notificationId);
    };
    ipcRenderer.on('notification:clicked', listener);
    return () => ipcRenderer.off('notification:clicked', listener);
  },
  setBadgeCount: (count: number): Promise<void> =>
    ipcRenderer.invoke('badge:setCount', count),
  /** Save a PNG snapshot to disk via the native save dialog. The
   *  renderer hands over raw bytes; main owns the dialog + writeFile.
   *  See `export:savePng` in main. */
  savePngExport: (input: {
    pngBytes: Uint8Array;
    suggestedName: string;
  }): Promise<
    | { ok: true; path: string }
    | { ok: false; canceled: true }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('export:savePng', input),
  /** Copy PNG snapshot bytes to the OS clipboard. Main constructs a
   *  NativeImage so Electron handles pasteboard format negotiation —
   *  renderer-side `ClipboardItem` for images is brittle on macOS. */
  copyPngExport: (input: {
    pngBytes: Uint8Array;
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('export:copyPng', input),
};

contextBridge.exposeInMainWorld('agentHub', api);
