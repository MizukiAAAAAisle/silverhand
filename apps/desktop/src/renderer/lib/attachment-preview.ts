/**
 * Which attachments open in an in-app previewer TAB (#task:2122) rather than
 * the OS open-with handler, WHERE the caller wires a tab controller: today the
 * two text formats an agent produces and a reader wants to read INLINE —
 * Markdown and HTML. This classifier only names the eligible kinds; whether the
 * previewer is actually the destination is the consumer's call. The member main
 * pane's message card routes here; the Attachments panel and thread pane still
 * OS-open these types, so this is not an app-wide single destination.
 *
 * PURE classifier. The kind decides the previewer BODY: `markdown` renders
 * through the shared `Markdown` component; `html` renders inside a sandboxed,
 * opaque-origin `<iframe>` (see `AttachmentHtmlPreview` — shiki + Cindy's B
 * boundary, 2026-08-21). Anything else returns `null` and keeps its existing
 * open-with-OS / download affordances untouched.
 *
 * Classification prefers the stored `content_type`, but falls back to the
 * FILENAME suffix when the stored type is generic — old attachment rows persist
 * `application/octet-stream` even for `.md` / `.html` (shared `mime.ts`), so a
 * content-type-only check would miss every legacy file (Cindy's mapping).
 */

import { isGenericMimeHint, mimeFromFilename } from '@silverhand/shared';

export type AttachmentPreviewKind = 'markdown' | 'html';

/**
 * The previewer kind for an attachment, or `null` when it has no in-app
 * previewer. Never throws — an empty or malformed content type degrades to the
 * filename suffix, and an unknown suffix degrades to `null`.
 */
export function attachmentPreviewKind(
  contentType: string,
  filename: string,
): AttachmentPreviewKind | null {
  const mime = effectiveMime(contentType, filename);
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/html') return 'html';
  return null;
}

/**
 * The MIME to classify on: the stored `content_type` (media type only, any
 * `; charset=…` parameter dropped), or — when that is generic/absent — the type
 * implied by the filename suffix. A NON-generic stored type wins even when the
 * suffix disagrees: a file explicitly served as `text/plain` must not be
 * sandbox-rendered as HTML just because it is named `.html`.
 */
function effectiveMime(contentType: string, filename: string): string | null {
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!isGenericMimeHint(base)) return base;
  return mimeFromFilename(filename);
}
