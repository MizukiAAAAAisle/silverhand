/**
 * Which command a Settings address save is allowed to issue.
 *
 * "The server URL" has two genuinely different owners, one per
 * deployment shape:
 *   - **embedded** — the daemon's outbound config (`settings:saveServerUrl`,
 *     which rewrites daemon-config and reloads the local daemon).
 *   - **remote** — the app's persisted server connection profile
 *     (`profile:saveWithTest`, which retargets main's backend handle).
 *
 * They are not interchangeable and neither is a no-op on the other's
 * deployment: firing the embedded command on a remote install rewrites
 * daemon-config and reloads a daemon that is not this app's backend,
 * while the app keeps talking to the old origin. That is a wrong write
 * the user cannot see.
 *
 * `BackendInfo.mode` is the only authority for which owner is live, and
 * `#task:1630` established that "no snapshot yet" is a reachable state —
 * `backend:info` answers `null` until desktop main holds a backend
 * handle, and the renderer paints before that. So `mode` is nullable
 * here, and an unknown mode plans **no command at all**: there is
 * nothing safe to send, and the caller's Save affordance derives its
 * disabled state from that same absence instead of keeping a second copy
 * of the rule (`ConnectionPane`). Defaulting the unknown window to
 * `'embedded'` is what let a remote app's Save reach the daemon reload
 * path (Cindy's `#task:1630` review).
 *
 * Split plan/run so the routing decision is assertable without stubbing
 * Electron IPC, and so "unknown mode issues zero IPC calls" is an
 * executable claim rather than a code-reading exercise
 * (`server-url-save-command.test.ts`).
 */
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
