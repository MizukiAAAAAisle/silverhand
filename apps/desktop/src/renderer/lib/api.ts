import type { BackendInfo } from '../../preload/api';

let cachedInfo: BackendInfo | null = null;

async function getInfo(): Promise<BackendInfo> {
  if (cachedInfo) return cachedInfo;
  const info = await window.agentHub.getBackendInfo();
  if (!info) throw new Error('backend not ready');
  cachedInfo = info;
  return info;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const info = await getInfo();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${info.auth_token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${info.url}${path}`, { ...init, headers });
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
