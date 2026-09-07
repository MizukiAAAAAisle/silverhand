import type {
  DesktopProfileSaveWithTestResult,
  DesktopSaveServerUrlResult,
} from '../../../preload/api';
import type { DesktopServerMode } from './connection-readiness';
import { saveServerConnectionProfileWithSettingsRetry } from './save-server-url-retry';

export type ServerUrlSaveCommand =
  | { source: 'profile'; serverUrl: string }
  | { source: 'daemon_reload'; serverUrl: string };

export type ServerUrlSaveResult =
  | { source: 'profile'; result: DesktopProfileSaveWithTestResult }
  | { source: 'daemon_reload'; result: DesktopSaveServerUrlResult };

/** The two IPC calls a save may make, injected so tests can count them. */
export interface ServerUrlSaveApi {
  saveServerConnectionProfile: (input: {
    serverUrl: string;
  }) => Promise<DesktopProfileSaveWithTestResult>;
  saveServerUrl: (input: {
    serverUrl: string;
  }) => Promise<DesktopSaveServerUrlResult>;
}

export function planServerUrlSave(input: {
  mode: DesktopServerMode | null;
  serverUrl: string;
}): ServerUrlSaveCommand | null {
  if (input.mode === null) return null;
  return input.mode === 'remote'
    ? { source: 'profile', serverUrl: input.serverUrl }
    : { source: 'daemon_reload', serverUrl: input.serverUrl };
}

export async function runServerUrlSave(
  command: ServerUrlSaveCommand,
  api: ServerUrlSaveApi,
): Promise<ServerUrlSaveResult> {
  if (command.source === 'profile') {
    return {
      source: 'profile',
      // Settings-side saves retry the transient network/TLS probe
      // failures only (see `save-server-url-retry.ts`).
      result: await saveServerConnectionProfileWithSettingsRetry({
        serverUrl: command.serverUrl,
        save: api.saveServerConnectionProfile,
      }),
    };
  }
  return {
    source: 'daemon_reload',
    result: await api.saveServerUrl({ serverUrl: command.serverUrl }),
  };
}
