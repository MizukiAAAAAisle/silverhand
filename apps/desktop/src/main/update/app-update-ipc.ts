import type { AppUpdateState } from '@silverhand/client';
import type { GuardedIpcRegistrar } from '../ipc/guarded-ipc.js';
import type { AppUpdateController } from './app-update-controller.js';

export const APP_UPDATE_STATE_CHANNEL = 'appUpdate:state';
export const APP_UPDATE_SHOW_DIALOG_CHANNEL = 'appUpdate:showDialog';

/** A null controller answers every request as "no update channel". */
export function registerAppUpdateIpcHandlers(
  ipc: GuardedIpcRegistrar,
  controller: () => AppUpdateController | null,
): void {
  ipc.handle('appUpdate:getState', (): AppUpdateState | null => controller()?.getState() ?? null);
  ipc.handle('appUpdate:check', () => controller()?.check());
  ipc.handle('appUpdate:download', () => controller()?.download());
  ipc.handle('appUpdate:install', (_event, mode: unknown) => {
    if (mode !== 'now' && mode !== 'on-quit') throw new Error('invalid install mode');
    return controller()?.install(mode);
  });
}
