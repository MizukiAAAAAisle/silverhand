import type {
  BackendInfo,
  BackendProxyResponse,
  BackendUploadField,
  BackendUploadFile,
} from "../../preload/api";

// for control the request delay in dev mode
// Minimum duration in milliseconds; set to 0 to disable.
const delay = 0;

let cachedInfo: BackendInfo | null = null;

/**
 * Structured HTTP / network error thrown by `api()` / `apiUpload()`
 * so callers can branch on `kind` + `status` without parsing the
 * Error message.
 *
 * `kind` discriminates two failure shapes:
 *   - `'http'`: the request reached the backend and got a real
 *     non-2xx response. `status` ∈ [400, 599] (or other valid HTTP
 *     codes). Use `err.status` to branch on 401/403/404.
 *   - `'backend_unreachable'` (D4.a Commit 5d-fixup, Cindy P1-2):
 *     the request never reached the backend (network failure, DNS
 *     fail, TLS fail, server down). Marshalled by the main-process
 *     proxy as `status: 0` with a typed body
 *     `{ error: 'backend_unreachable', message }`. Renderer should
 *     show a "can't reach <server>" gate, not a generic "something
 *     went wrong" — the network DID fail, but the SOFTWARE is fine
 *     and a retry/profile-clear can recover.
 */
export class ApiError extends Error {
  readonly kind: "http" | "backend_unreachable";
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  constructor(
    status: number,
    statusText: string,
    body: string,
    kind: "http" | "backend_unreachable" = "http",
  ) {
    super(`${status} ${statusText}: ${body}`);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/**
 * Encode one untrusted value as exactly ONE path segment, or `null` if it
 * cannot be one.
 *
 * Every id the renderer interpolates into a request path can arrive from a URL
 * the user pasted (`?task=<id>`), so `/api/tasks/${id}` is a path-traversal
 * site: main resolves it with `new URL(path, backendUrl)` (`main/index.ts`),
 * which applies WHATWG normalization — `..` climbs a segment, `.` collapses,
 * `/` and `?` open a new segment or a query. `encodeURIComponent` alone is NOT
 * enough: it leaves `.` and `..` untouched, and WHATWG also reads their
 * percent-encoded spellings (`%2e%2e`) as dot segments.
 *
 * The gate is deliberately a shape check, not a format check: replicating the
 * backend's id grammar (`randomBytes(12).toString('base64url')`) here would
 * create a second authority for what an id is, which then drifts. What matters
 * is only that the value stays inside one segment (Cindy / Alice review).
 *
 * Sufficiency: `encodeURIComponent` escapes `%` itself, so its output holds only
 * unreserved characters and escapes we wrote — a pasted `%2E%2E` comes back as
 * `%252E%252E`, which is inert. The only outputs a URL parser can still read as
 * a dot segment are therefore the literals `.` and `..`, plus the empty string,
 * which would drop the segment entirely.
 */
export function toPathSegment(raw: string): string | null {
  const encoded = encodeURIComponent(raw);
  if (encoded === "" || encoded === "." || encoded === "..") return null;
  return encoded;
}

async function getInfo(forceRefresh = false): Promise<BackendInfo> {
  if (cachedInfo && !forceRefresh) return cachedInfo;
  const info = await window.silverhand.getBackendInfo();
  if (!info) throw new Error("backend not ready");
  cachedInfo = info;
  return info;
}

function bodyTextFromInit(init: RequestInit): string | undefined {
  if (init.body === undefined || init.body === null) return undefined;
  if (typeof init.body === "string") return init.body;
  if (init.body instanceof URLSearchParams) return init.body.toString();
  throw new Error("api() only supports string or URLSearchParams request bodies");
}

function headersFromInit(init: RequestInit): Record<string, string> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set(
      "Content-Type",
      init.body instanceof URLSearchParams
        ? "application/x-www-form-urlencoded;charset=UTF-8"
        : "application/json",
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
  throw new DOMException("The operation was aborted.", "AbortError");
}

function textResponseBody(res: BackendProxyResponse): string {
  return res.bodyText ?? "";
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

  if (res.status === 0) {
    throw new ApiError(
      0,
      res.statusText || "Network Error",
      textResponseBody(res),
      "backend_unreachable",
    );
  }
  throw new ApiError(res.status, res.statusText, textResponseBody(res));
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  throwIfAborted(init.signal);
  const startedAt = performance.now();
  const request = window.silverhand.backendRequest({
    path,
    method: init.method,
    headers: headersFromInit(init),
    bodyText: bodyTextFromInit(init),
  });
  const res = await request.finally(async () => {
    const remaining = import.meta.env.DEV ? delay - (performance.now() - startedAt) : 0;
    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
    throwIfAborted(init.signal);
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
export async function apiUpload<T = unknown>(path: string, formData: FormData): Promise<T> {
  const fields: BackendUploadField[] = [];
  const files: BackendUploadFile[] = [];
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string") {
      fields.push({ name, value });
      continue;
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    files.push({
      fieldName: name,
      filename: value instanceof File ? value.name : "blob",
      contentType: value.type || "application/octet-stream",
      bytes,
    });
  }
  const res = await window.silverhand.backendUpload({ path, fields, files });
  assertOk(res);
  return JSON.parse(textResponseBody(res)) as T;
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
  const res = await window.silverhand.backendRequest({
    path,
    responseType: "arrayBuffer",
  });
  assertOk(res);
  const contentType = headerValue(res.headers, "content-type") ?? "application/octet-stream";
  const disposition = headerValue(res.headers, "content-disposition");
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

/** Fetch an arbitrary backend path as raw bytes — no `URL.createObjectURL`
 *  in the chain. For "open-with-OS" / "save-as" flows the renderer only
 *  needs the bytes to ship over IPC; going through the blob-URL API leaks a
 *  reference every call (attachments cap at 10MB, so repeated opens would
 *  accumulate). Use `fetchBackendBlob` only when you need a URL for
 *  `<img src>` / `<video src>` (image cache path).
 *
 *  Generic over the path so bytes faces other than the membership-scoped
 *  `GET /api/attachments/:id` (e.g. the owner-audit
 *  `agentChatAttachment` route) reuse the identical fetch + defensive copy. */
export async function fetchBackendBytes(path: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
  filename: string | null;
}> {
  const res = await window.silverhand.backendRequest({
    path,
    responseType: "arrayBuffer",
  });
  assertOk(res);
  const contentType = headerValue(res.headers, "content-type") ?? "application/octet-stream";
  const disposition = headerValue(res.headers, "content-disposition");
  const filename = disposition ? extractDispositionFilename(disposition) : null;
  const source = res.bodyBytes ?? new Uint8Array();
  // Copy defensively — `bodyBytes` may reuse an underlying buffer
  // shared with the IPC transport; downstream `Uint8Array` consumers
  // (IPC handoff, file write) expect an owned buffer.
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return { bytes, contentType, filename };
}

export async function fetchAttachmentBytes(attachmentId: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
  filename: string | null;
}> {
  return fetchBackendBytes(`/api/attachments/${encodeURIComponent(attachmentId)}`);
}

function extractDispositionFilename(value: string): string | null {
  const match = /filename\*?=(?:UTF-8'')?([^;]+)/i.exec(value);
  if (!match || !match[1]) return null;
  const raw = match[1].trim().replace(/^"|"$/g, "");
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
    await api(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}
