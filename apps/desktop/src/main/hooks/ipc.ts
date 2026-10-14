import { BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron';
import type { EventHooksCapability } from '@silverhand/client';
import type { GuardedIpcRegistrar } from '../ipc/guarded-ipc.js';
import type { DesktopHookSettings } from './settings.js';
import type { HookService } from './service.js';

export function registerHookIpc(
  ipc: GuardedIpcRegistrar,
  settings: DesktopHookSettings,
  service: HookService,
  session: () => { identity: string; scope: string; current: () => boolean } | null,
) {
  ipc.handle('sound:choose', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: 'Choose notification sound',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
    };
    const result = await (win
      ? dialog.showOpenDialog(win, options)
      : dialog.showOpenDialog(options));
    return result.canceled || !result.filePaths[0]
      ? null
      : settings.importSound(result.filePaths[0]);
  });
  ipc.handle(
    'sound:preview',
    async (_, sound: import('@silverhand/client').NotificationSoundFile | null) => {
      if (sound === null) {
        shell.beep();
        return null;
      }
      return settings.readSound(sound);
    },
  );
  ipc.handle('hooks:load', async () => {
    const snapshot = await settings.loadHooks();
    service.updateRules(snapshot.entries.flatMap(({ rule }) => (rule ? [rule] : [])));
    return snapshot;
  });
  ipc.handle(
    'hooks:toggle',
    async (_, input: Parameters<EventHooksCapability['setHookEnabled']>[0]) => {
      const snapshot = await settings.setHookEnabled(input);
      service.updateRules(snapshot.entries.flatMap(({ rule }) => (rule ? [rule] : [])));
      return snapshot;
    },
  );
  ipc.handle('hooks:preferences:load', () => settings.loadPreferences());
  ipc.handle(
    'hooks:preferences:save',
    (_, input: Parameters<EventHooksCapability['savePreferences']>[0]) =>
      settings.savePreferences(input),
  );
  ipc.handle('hooks:open', async (_, kind: 'hooks' | 'preferences') => {
    if (kind !== 'hooks' && kind !== 'preferences') throw new Error('Unknown configuration');
    const path = await settings.prepareConfig(kind);
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipc.handle('hooks:source:open', async (_, source: string) => {
    const error = await shell.openPath(await settings.prepareHookSource(source));
    if (error) throw new Error(error);
  });
  ipc.handle('hooks:directory:open', async () => {
    const error = await shell.openPath(await settings.prepareHookDirectory());
    if (error) throw new Error(error);
  });
  ipc.handle('hooks:begin', () => {
    const state = session();
    return state ? service.beginFeed(state.identity, state.scope, state.current) : null;
  });
  ipc.handle('hooks:end', (_, lease: string) => service.endFeed(lease));
  ipc.handle('hooks:deliver', (_, input: Parameters<EventHooksCapability['deliver']>[0]) =>
    service.deliver(input.lease, input.frames),
  );
  ipc.handle('hooks:runs', () => service.runs());
  ipc.handle('hooks:cancel', (_, id: string) => service.cancel(id));
}
