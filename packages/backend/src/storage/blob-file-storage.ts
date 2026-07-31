import { mkdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';

export type StorageKind = 'local' | 's3' | 'oss';

export interface StoredFileRef {
  storage: StorageKind;
  storageKey: string;
}

export interface BlobFilePutInput {
  namespace: string;
  id: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export interface BlobFileServeHeaders {
  filename: string;
  contentType: string;
}

export interface BlobFileStorage {
  readonly kind: StorageKind;
  put(input: BlobFilePutInput): Promise<StoredFileRef>;
  serve(ref: StoredFileRef, headers: BlobFileServeHeaders): Promise<Response>;
  locate(ref: StoredFileRef): Promise<{ localPath: string } | null>;
  delete(ref: StoredFileRef): Promise<void>;
  /**
   * Ensure a STABLE local path (keyed on `stableId`, e.g. the attachment id)
   * resolves to the bytes named by `physicalRef`, and return it. The physical
   * key moves on every content update (pointer-swap writes a fresh blob id), so
   * a raw `locate` path would change each round; this alias keeps the path the
   * embedded CLI handed a viewer fixed across updates. Idempotent and
   * self-healing — safe to call on every locate and eagerly after an update.
   * Returns null when the physical bytes are absent. Backends without a local
   * path (future s3/oss) return null.
   */
  materializeAlias(
    physicalRef: StoredFileRef,
    stableId: string,
  ): Promise<{ localPath: string } | null>;
  /** Best-effort removal of the stable alias for `stableId`. No-op when the
   *  backend has no local alias. Called on attachment delete so the alias does
   *  not dangle; never affects the physical blob's lifecycle. */
  deleteAlias(physicalRef: StoredFileRef, stableId: string): Promise<void>;
}

export class BlobFileStorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BlobFileStorageError';
  }
}

export interface LocalBlobFileStorageOptions {
  /** Root directory for all local blobs, usually `<silverhandDir>/blobs`. */
  rootDir: string;
}

export class LocalBlobFileStorage implements BlobFileStorage {
  readonly kind = 'local' as const;
  readonly rootDir: string;

  constructor(opts: LocalBlobFileStorageOptions) {
    this.rootDir = resolve(opts.rootDir);
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async put(input: BlobFilePutInput): Promise<StoredFileRef> {
    const storageKey = buildStorageKey(input);
    const filePath = this.resolveStorageKey(storageKey);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, input.buffer, { flag: 'wx', mode: 0o600 });
    return { storage: this.kind, storageKey };
  }

  async serve(ref: StoredFileRef, headers: BlobFileServeHeaders): Promise<Response> {
    this.assertRefKind(ref);
    const filePath = this.resolveStorageKey(ref.storageKey);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new BlobFileStorageError(
        'not_file',
        `storage key does not point to a file: ${ref.storageKey}`,
      );
    }
    // v1 attachment uploads are capped at 10MB, so a full read keeps this
    // adapter simple. Switch to a stream if that cap grows.
    const body = await readFile(filePath);
    return new Response(body, {
      headers: {
        'Content-Type': normalizeContentType(headers.contentType),
        'Content-Length': String(fileStat.size),
        'Content-Disposition': contentDisposition(headers.filename),
        // Attachment bytes are mutable in place (creator update repoints the
        // row to a fresh blob), so the old `immutable, 1yr` was a lie once an
        // id could change content. The renderer fetches blobs through
        // renderer→IPC→main (`backendFetch`), where the HTTP cache/validators
        // never engage on the normal path — so ETag/304 would be dead weight.
        // `no-store` keeps every fetch authoritative; freshness/cache-busting
        // is the renderer's generation map keyed on `content_revision` + the
        // `attachment_changed` event, not an HTTP validator.
        'Cache-Control': 'private, no-store',
      },
    });
  }

  async locate(ref: StoredFileRef): Promise<{ localPath: string } | null> {
    this.assertRefKind(ref);
    const filePath = this.resolveStorageKey(ref.storageKey);
    try {
      const fileStat = await stat(filePath);
      return fileStat.isFile() ? { localPath: filePath } : null;
    } catch (err) {
      if (isNodeErrno(err, 'ENOENT')) return null;
      throw err;
    }
  }

  async delete(ref: StoredFileRef): Promise<void> {
    this.assertRefKind(ref);
    await rm(this.resolveStorageKey(ref.storageKey), { force: true });
  }

  async materializeAlias(
    physicalRef: StoredFileRef,
    stableId: string,
  ): Promise<{ localPath: string } | null> {
    this.assertRefKind(physicalRef);
    const physicalPath = this.resolveStorageKey(physicalRef.storageKey);
    try {
      const s = await stat(physicalPath);
      if (!s.isFile()) return null;
    } catch (err) {
      if (isNodeErrno(err, 'ENOENT')) return null;
      throw err;
    }

    const aliasKey = this.aliasKeyFor(physicalRef.storageKey, stableId);
    const aliasPath = this.resolveStorageKey(aliasKey);
    // Relative target: the alias lives in the physical blob's directory and
    // points at its basename, so relocating the blob root never breaks it.
    const target = basename(physicalPath);

    // Fast path: alias is already a symlink to the current physical basename.
    try {
      if ((await readlink(aliasPath)) === target) return { localPath: aliasPath };
    } catch (err) {
      // ENOENT: no alias yet. EINVAL: exists but is not a symlink (shouldn't
      // happen — the alias id-space never overlaps a physical key). Either way,
      // fall through and (re)create it atomically below.
      if (!isNodeErrno(err, 'ENOENT') && !isNodeErrno(err, 'EINVAL')) throw err;
    }

    // Atomic (re)link: create the new symlink under a unique temp name in the
    // same dir, then rename it over the alias. A reader opening the alias always
    // resolves to either the old or the new physical blob, never a missing path.
    await mkdir(dirname(aliasPath), { recursive: true });
    const tempPath = `${aliasPath}.${globalThis.crypto.randomUUID()}.tmp`;
    await rm(tempPath, { force: true });
    await symlink(target, tempPath);
    await rename(tempPath, aliasPath);
    return { localPath: aliasPath };
  }

  async deleteAlias(physicalRef: StoredFileRef, stableId: string): Promise<void> {
    this.assertRefKind(physicalRef);
    const aliasKey = this.aliasKeyFor(physicalRef.storageKey, stableId);
    await rm(this.resolveStorageKey(aliasKey), { force: true });
  }

  /** The alias shares the physical blob's directory + extension but swaps in the
   *  STABLE id as the basename, so the alias path is invariant across updates
   *  (`content_type`/`filename` are locked on update, so the ext never drifts). */
  private aliasKeyFor(physicalStorageKey: string, stableId: string): string {
    const dir = dirname(physicalStorageKey);
    const ext = extname(physicalStorageKey);
    const id = sanitizeRequiredSegment(stableId, 'alias id');
    return dir === '.' ? `${id}${ext}` : `${dir}/${id}${ext}`;
  }

  private assertRefKind(ref: StoredFileRef): void {
    if (ref.storage !== this.kind) {
      throw new BlobFileStorageError(
        'storage_kind_mismatch',
        `cannot use ${ref.storage} ref with ${this.kind} storage`,
      );
    }
  }

  private resolveStorageKey(storageKey: string): string {
    const segments = storageKey.split('/');
    if (segments.length === 0 || segments.some(s => !isSafeSegment(s))) {
      throw new BlobFileStorageError(
        'invalid_storage_key',
        `invalid storage key: ${storageKey}`,
      );
    }

    const filePath = resolve(this.rootDir, ...segments);
    if (!isPathInside(this.rootDir, filePath)) {
      throw new BlobFileStorageError(
        'invalid_storage_key',
        `storage key escapes blob root: ${storageKey}`,
      );
    }
    return filePath;
  }
}

export function createLocalBlobFileStorage(opts: {
  /** Resolved blob root (from the app-data path authority). */
  rootDir: string;
}): LocalBlobFileStorage {
  return new LocalBlobFileStorage({ rootDir: opts.rootDir });
}

function buildStorageKey(input: BlobFilePutInput): string {
  const namespace = normalizeNamespace(input.namespace);
  const id = sanitizeRequiredSegment(input.id, 'id');
  const ext = extensionFromFilename(input.filename)
    || extensionForContentType(input.contentType)
    || '.bin';
  return `${namespace}/${id}${ext}`;
}

function normalizeNamespace(namespace: string): string {
  const parts = namespace
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => sanitizeRequiredSegment(part, 'namespace'));
  if (parts.length === 0) return 'files';
  return parts.join('/');
}

function sanitizeRequiredSegment(value: string, label: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!isSafeSegment(sanitized)) {
    throw new BlobFileStorageError(
      'invalid_segment',
      `invalid ${label} segment: ${value}`,
    );
  }
  return sanitized;
}

function isSafeSegment(segment: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(segment)
    && segment !== '.'
    && segment !== '..';
}

function extensionFromFilename(filename: string): string | null {
  const ext = extname(basename(filename.trim())).toLowerCase();
  if (!/^\.[a-z0-9][a-z0-9.+-]{0,15}$/.test(ext)) return null;
  return ext;
}

function extensionForContentType(contentType: string): string | null {
  const normalized = normalizeContentType(contentType);
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
    'text/csv': '.csv',
    'application/zip': '.zip',
    'application/x-tar': '.tar',
    'application/gzip': '.gz',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
  };
  return map[normalized] ?? null;
}

function normalizeContentType(contentType: string): string {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase();
  return normalized && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

function contentDisposition(filename: string): string {
  const utf8Name = basename(filename.trim() || 'download.bin')
    .replace(/[\r\n"]/g, '_')
    || 'download.bin';
  const asciiFallback = utf8Name.replace(/[^\x20-\x7E]+/g, '_');
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function isNodeErrno(err: unknown, code: string): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: unknown }).code === code;
}
