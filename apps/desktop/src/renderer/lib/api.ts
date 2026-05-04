import type { BackendInfo } from '../../preload/api';
import { CURRENT_USER_ID } from './current-user';

let cachedInfo: BackendInfo | null = null;

async function getInfo(forceRefresh = false): Promise<BackendInfo> {
  if (cachedInfo && !forceRefresh) return cachedInfo;
  const info = await window.agentHub.getBackendInfo();
  if (!info) throw new Error('backend not ready');
  cachedInfo = info;
  return info;
}

async function fetchWithInfo(
  path: string,
  init: RequestInit,
  info: BackendInfo,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${info.auth_token}`);
  // Viewer identity — v1 hardcoded to 'local'; backend resolves this from
  // the header and passes it to Repo methods. Swap CURRENT_USER_ID when
  // auth is introduced; no other callsite needs to change.
  headers.set('X-Silverhand-User-Id', CURRENT_USER_ID);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${info.url}${path}`, { ...init, headers });
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let info = await getInfo();
  let res: Response;
  try {
    res = await fetchWithInfo(path, init, info);
  } catch (err) {
    // In dev, electron-vite can restart the main process/backend and
    // assign a new localhost port while the renderer keeps its module
    // cache. Refresh backend info once before surfacing a network error.
    info = await getInfo(true);
    res = await fetchWithInfo(path, init, info).catch(() => {
      throw err;
    });
  }
  if (res.status === 401 || res.status === 403) {
    // Same stale-info failure mode, but for auth-token changes rather
    // than port changes.
    info = await getInfo(true);
    res = await fetchWithInfo(path, init, info);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function getBackendInfo(): Promise<BackendInfo> {
  return getInfo();
}
