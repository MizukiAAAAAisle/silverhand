import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
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
  // Viewer principal — v1 hardcoded to user:local. When auth is introduced,
  // replace CURRENT_USER_ID/session resolution here; callsites stay unchanged.
  headers.set(
    X_SILVERHAND_PRINCIPAL_HEADER,
    encodeUserPrincipalHeader(CURRENT_USER_ID),
  );
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

/** Multipart upload helper. Bearer auth + viewer header, no Content-Type
 *  override — FormData sets the boundary itself. Falls back to a single
 *  retry with refreshed backend info on the same failure modes as `api()`. */
export async function apiUpload<T = unknown>(
  path: string,
  formData: FormData,
): Promise<T> {
  let info = await getInfo();
  const send = async (i: BackendInfo): Promise<Response> => {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${i.auth_token}`);
    headers.set(
      X_SILVERHAND_PRINCIPAL_HEADER,
      encodeUserPrincipalHeader(CURRENT_USER_ID),
    );
    return fetch(`${i.url}${path}`, { method: 'POST', headers, body: formData });
  };
  let res: Response;
  try {
    res = await send(info);
  } catch (err) {
    info = await getInfo(true);
    res = await send(info).catch(() => {
      throw err;
    });
  }
  if (res.status === 401 || res.status === 403) {
    info = await getInfo(true);
    res = await send(info);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

/** Build an absolute URL to an attachment download. The renderer doesn't
 *  share an origin with the backend, so links must include the host.
 *  Auth still travels via header, so use this for `fetchAttachmentBlob`
 *  rather than dropping into `<img src>` directly (the public attachment
 *  route requires the viewer header, not just a query token). */
export async function attachmentEndpoint(attachmentId: string): Promise<string> {
  const info = await getInfo();
  return `${info.url}/api/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Fetch an attachment as a Blob using the auth headers, then return an
 *  object URL the renderer can drop into `<img src>` or `window.open`.
 *  Caller is responsible for `URL.revokeObjectURL` when the URL is no
 *  longer needed (or accept the leak — Electron tears down on close). */
export async function fetchAttachmentBlob(attachmentId: string): Promise<{
  url: string;
  contentType: string;
  filename: string | null;
}> {
  const info = await getInfo();
  const url = `${info.url}/api/attachments/${encodeURIComponent(attachmentId)}`;
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${info.auth_token}`);
  headers.set(
    X_SILVERHAND_PRINCIPAL_HEADER,
    encodeUserPrincipalHeader(CURRENT_USER_ID),
  );
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const disposition = res.headers.get('content-disposition');
  const filename = disposition ? extractDispositionFilename(disposition) : null;
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), contentType, filename };
}

function extractDispositionFilename(value: string): string | null {
  const match = /filename\*?=(?:UTF-8'')?([^;]+)/i.exec(value);
  if (!match || !match[1]) return null;
  const raw = match[1].trim().replace(/^"|"$/g, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Best-effort orphan delete called from Composer cleanup paths. Returns
 *  true on success, false on any error — callers don't surface failures
 *  because there's no user to notify (the chip / composer is already
 *  gone). 409 (referenced) and 404 (already gone) are also treated as
 *  "stop trying"; the renderer doesn't need to distinguish. */
export async function deleteAttachmentBestEffort(attachmentId: string): Promise<boolean> {
  try {
    await api(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
    return true;
  } catch {
    return false;
  }
}
