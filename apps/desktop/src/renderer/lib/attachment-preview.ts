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

import { isGenericMimeHint, mimeFromFilename } from "@silverhand/shared";

export type AttachmentPreviewKind = "markdown" | "html";

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
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/html") return "html";
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
  const base = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!isGenericMimeHint(base)) return base;
  return mimeFromFilename(filename);
}

/**
 * Where a deferred open-attachment request lands once it reaches the primary
 * pane's tab controller (#task:2122). The Attachments panel is a SECONDARY pane;
 * it can't reach the primary `ChannelView`'s tab controller, so it hands the
 * request up to App as a one-shot relay that the primary pane consumes on its
 * next render. That render can happen a beat later — after a route/session
 * switch — so the request carries the conversation it was ISSUED from, and this
 * decides the destination against the conversation actually mounted now:
 *
 *  - `'reject'` — the mounted conversation is no longer the one that issued the
 *    request. Drop it: never route conversation A's attachment into B's tab
 *    controller, and never OS-open A's attachment while B is mounted. The only
 *    correct fallback (OS-open) belongs to a matching-source consumer, so a
 *    mismatch does nothing but clear the relay. (Cindy, 2026-08-21 — the same
 *    deferred-pane + imperative-relay seam that leaked a preview tab across a
 *    channel switch.)
 *  - `'preview'` — same conversation, the tab strip is live, and the kind is
 *    previewable: open the in-app previewer tab.
 *  - `'os-open'` — same conversation but not previewable here (no tab strip, or
 *    an unpreviewable kind): fall back to the OS open-with handler.
 *
 * PURE. `null`/empty ids never match a real conversation id, so a request with
 * no source and a pane with no conversation both resolve to `'reject'`.
 */
export type AttachmentOpenRoute = "preview" | "os-open" | "reject";

export function resolveAttachmentOpenRoute(args: {
  requestConversationId: string;
  currentConversationId: string | null;
  previewKind: AttachmentPreviewKind | null;
  tabStripShown: boolean;
}): AttachmentOpenRoute {
  const { requestConversationId, currentConversationId } = args;
  if (!requestConversationId || requestConversationId !== currentConversationId) {
    return "reject";
  }
  if (args.tabStripShown && args.previewKind !== null) return "preview";
  return "os-open";
}
