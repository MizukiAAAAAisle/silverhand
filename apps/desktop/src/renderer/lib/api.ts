import type {
  BackendInfo,
  BackendProxyResponse,
  BackendUploadField,
  BackendUploadFile,
} from '../../preload/api';

let cachedInfo: BackendInfo | null = null;

/**
 * Structured HTTP error thrown by `api()` / `apiUpload()` so callers
 * can branch on `status` (e.g. 403 vs 404) without parsing the
 * Error message.
 *
 * Pre-PR-2 callers used to read `(err as Error).message` (a string of
 * the form `"403 Forbidden: {body}"`); that still works because the
 * `message` field keeps the same shape. New code should switch to
 * `err instanceof ApiError && err.status === 404` instead.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  constructor(status: number, statusText: string, body: string) {
    super(`${status} ${statusText}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

async function getInfo(forceRefresh = false): Promise<BackendInfo> {
  if (cachedInfo && !forceRefresh) return cachedInfo;
  const info = await window.agentHub.getBackendInfo();
  if (!info) throw new Error('backend not ready');
  cachedInfo = info;
  return info;
}

function bodyTextFromInit(init: RequestInit): string | undefined {
  if (init.body === undefined || init.body === null) return undefined;
  if (typeof init.body === 'string') return init.body;
  if (init.body instanceof URLSearchParams) return init.body.toString();
  throw new Error('api() only supports string or URLSearchParams request bodies');
}

function headersFromInit(init: RequestInit): Record<string, string> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set(
      'Content-Type',
      init.body instanceof URLSearchParams
        ? 'application/x-www-form-urlencoded;charset=UTF-8'
        : 'application/json',
    );
  }
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException('The operation was aborted.', 'AbortError');
}

function textResponseBody(res: BackendProxyResponse): string {
  return res.bodyText ?? '';
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function assertOk(res: BackendProxyResponse): void {
  if (res.status >= 200 && res.status < 300) return;
  throw new ApiError(res.status, res.statusText, textResponseBody(res));
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  throwIfAborted(init.signal);
  const res = await window.agentHub.backendRequest({
    path,
    method: init.method,
    headers: headersFromInit(init),
    bodyText: bodyTextFromInit(init),
  });
  throwIfAborted(init.signal);
  assertOk(res);
  if (res.status === 204) return undefined as T;
  return JSON.parse(textResponseBody(res)) as T;
}

export async function getBackendInfo(): Promise<BackendInfo> {
  return getInfo();
}

/** Multipart upload helper. The renderer serializes FormData over IPC;
 *  main reconstructs it and injects the user session bearer. */
export async function apiUpload<T = unknown>(
  path: string,
  formData: FormData,
): Promise<T> {
  const fields: BackendUploadField[] = [];
  const files: BackendUploadFile[] = [];
  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string') {
      fields.push({ name, value });
      continue;
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    files.push({
      fieldName: name,
      filename: value instanceof File ? value.name : 'blob',
      contentType: value.type || 'application/octet-stream',
      bytes,
    });
  }
  const res = await window.agentHub.backendUpload({ path, fields, files });
  assertOk(res);
  return JSON.parse(textResponseBody(res)) as T;
}

/** Build an absolute URL to an attachment download. The renderer doesn't
 *  share an origin with the backend, so links must include the host.
 *  It is only useful for display/debug; authenticated fetches must go
 *  through `fetchAttachmentBlob()` so main can inject the user session. */
export async function attachmentEndpoint(attachmentId: string): Promise<string> {
  const info = await getInfo();
  return `${info.url}/api/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Fetch an attachment as a Blob through the main-process auth proxy, then return an
 *  object URL the renderer can drop into `<img src>` or `window.open`.
 *  Caller is responsible for `URL.revokeObjectURL` when the URL is no
 *  longer needed (or accept the leak — Electron tears down on close). */
export async function fetchBackendBlob(path: string): Promise<{
  url: string;
  contentType: string;
  filename: string | null;
}> {
  const res = await window.agentHub.backendRequest({
    path,
    responseType: 'arrayBuffer',
  });
  assertOk(res);
  const contentType = headerValue(res.headers, 'content-type') ?? 'application/octet-stream';
  const disposition = headerValue(res.headers, 'content-disposition');
  const filename = disposition ? extractDispositionFilename(disposition) : null;
  const bytes = res.bodyBytes ?? new Uint8Array();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: contentType });
  return { url: URL.createObjectURL(blob), contentType, filename };
}

export async function fetchAttachmentBlob(attachmentId: string): Promise<{
  url: string;
  contentType: string;
  filename: string | null;
}> {
  return fetchBackendBlob(`/api/attachments/${encodeURIComponent(attachmentId)}`);
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
