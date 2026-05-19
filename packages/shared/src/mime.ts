/**
 * Attachment MIME contract — single source of truth shared by the CLI,
 * the backend attachment service, and the desktop renderer.
 *
 * Why this lives in shared:
 *   - The backend is the canonical authority for the MIME ultimately
 *     written into the DB; it must run a deterministic recognition
 *     pipeline (see `detectContentType` in
 *     `packages/backend/src/services/attachment-service.ts`).
 *   - The CLI and renderer use these helpers as **hints / display**
 *     only — they never short-circuit the backend's decision.
 *
 * Recognition order on the backend (do not change without updating
 * `docs/cli-system.md` "Attachment MIME contract"):
 *   1. Caller-supplied MIME, only if it's not a generic hint
 *      (`application/octet-stream`, empty, or syntactically invalid).
 *      Real values like `text/html` or `image/png` are honoured.
 *   2. Magic-byte sniff for binaries with stable signatures (PNG, JPEG,
 *      GIF, WebP, PDF, ZIP). Magic always beats suffix — a `.txt`
 *      file with PNG header still resolves as `image/png`.
 *   3. Suffix lookup against `EXT_TO_MIME` for text-like types that
 *      don't have stable magic (`.html/.htm/.svg/.json/.md/.txt/.csv`).
 *   4. Fallback to `application/octet-stream`.
 *
 * Treating `application/octet-stream` as "no useful hint" matters
 * because every common upload pipeline (HTML form, multipart parser,
 * Node `Blob` with no `type`, browsers without a registered handler)
 * defaults to it. If we trusted that as authoritative, agent-uploaded
 * `.html` would silently become an unrenderable binary blob — exactly
 * the bug `#task:388` exists to fix.
 */

/** Generic / "no useful hint" MIME values that must NOT short-circuit
 *  the recognition pipeline. */
const GENERIC_MIME_HINTS = new Set<string>([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);

/** Returns true when `mime` carries no usable type information and the
 *  recognition pipeline should fall through to magic + suffix. */
export function isGenericMimeHint(mime: string | null | undefined): boolean {
  if (mime == null) return true;
  const norm = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (GENERIC_MIME_HINTS.has(norm)) return true;
  // Anything that doesn't look like `type/subtype` is also useless.
  return !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(norm);
}

/** Suffix → MIME map for text-like types without stable magic bytes.
 *
 *  Keys are lowercase extensions (no leading dot). Add entries
 *  conservatively: only include types where the suffix→MIME mapping
 *  is unambiguous and the renderer / OS handles them sensibly. */
export const EXT_TO_MIME: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  json: 'application/json',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  // Binaries with magic bytes are listed too so a corrupted/short file
  // can still resolve via suffix when sniff fails. Magic still wins
  // when both produce a result.
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

/** Lowercase the trailing extension (without the dot). Returns `null`
 *  for filenames with no extension or a leading-dot dotfile. */
export function extOfFilename(filename: string): string | null {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0 || idx === filename.length - 1) return null;
  return filename.slice(idx + 1).toLowerCase();
}

/** Look up a MIME from the shared suffix table. Returns `null` when the
 *  filename has no extension or the extension isn't in the whitelist. */
export function mimeFromFilename(filename: string): string | null {
  const ext = extOfFilename(filename);
  if (!ext) return null;
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * Extensions safe to hand off to the OS default handler via
 * `shell.openPath` (or equivalent). The desktop main process uses this
 * as the **primary security gate** when the renderer asks to open an
 * attachment externally — see `attachment:openExternal` in
 * `apps/desktop/src/main/index.ts`.
 *
 * Why allowlist by extension rather than by MIME:
 *   - macOS Launch Services dispatches on the **on-disk extension**
 *     (Terminal opens `.command`, Installer opens `.pkg`, etc.). MIME
 *     hints don't enter the OS decision once we've written the file.
 *   - Old attachment rows that pre-date the MIME contract carry
 *     `application/octet-stream` even for `.html`. Trusting only the
 *     MIME would break legitimate "click an old report" UX.
 *
 * Membership rules (be conservative — every entry is a potential
 * attack surface):
 *   - Viewer formats whose default handler does NOT execute arbitrary
 *     code: html/htm (browser, sandboxed), pdf (Preview / browser),
 *     txt/log/md/markdown (text editor or browser), json/csv (text
 *     editor or browser), png/jpg/jpeg/gif/webp (image viewer).
 *   - **Excluded on purpose** even though they're "documents":
 *       - `.svg` — browsers execute SVG `<script>` when the file is
 *         loaded directly (not as `<img>`).
 *       - `.command` / `.sh` / `.app` / `.pkg` / `.dmg` / `.scpt` /
 *         `.exe` / `.bat` / `.ps1` / `.jar` — Launch Services would
 *         hand these to a shell / installer / OS executor.
 *       - `.docx` / `.xlsx` / `.pptx` / `.ppam` etc. — Office formats
 *         can carry macros; let the user save and open manually.
 *
 * If you add an extension here, justify it in the same comment style.
 */
const SAFE_OPEN_EXTS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    'html', 'htm',
    'pdf',
    'txt', 'log',
    'md', 'markdown',
    'json', 'csv',
    'png', 'jpg', 'jpeg', 'gif', 'webp',
  ]),
);

/** True when the filename's extension is on the safe-open allowlist —
 *  i.e. its OS default handler is a viewer / sandboxed app, never a
 *  shell, installer, or runtime. Returns false for filenames with no
 *  extension (the OS would fall back to a generic handler — not safe
 *  to assume). */
export function isSafeOpenExtension(filename: string): boolean {
  const ext = extOfFilename(filename);
  return ext != null && SAFE_OPEN_EXTS.has(ext);
}
