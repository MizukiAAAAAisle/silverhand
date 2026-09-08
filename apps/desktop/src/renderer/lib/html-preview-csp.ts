/**
 * The document a `.html` attachment preview loads into its sandboxed iframe.
 *
 * The iframe itself is `sandbox="allow-scripts"` with NO `allow-same-origin`,
 * so the frame runs on an OPAQUE origin: author scripts execute (agent mockups
 * routinely pull public CDN libraries and must run), but they cannot read the
 * host DOM / storage / cookies, and cross-origin responses are unreadable. This
 * module adds the second door: a Content-Security-Policy `<meta>` in a TRUSTED
 * document prefix, so the policy is the first thing the UA parses.
 *
 * WHY A FIXED WRAPPER, NOT AN INJECTION SCAN (Cindy B1): a regex like
 * `/<head>/` is not an HTML parser — `<!-- <head> -->`, a `<head>` string
 * inside a `<script>`, or a `<script src>` placed before the real `<head>`
 * would each let an author-active element load BEFORE the policy, defeating it.
 * So we never scan author bytes. We WRAP them: the author's document is placed,
 * verbatim, inside the `<body>` of a fixed trusted document whose `<head>`
 * carries only our CSP. No author byte can precede the policy, whatever the
 * input. The author's own `<html>`/`<head>`/`<body>`/`<!DOCTYPE>` tags, now in
 * body position, are dropped by the parser as parse-errors while their CONTENT
 * (scripts, styles, markup) is still inserted into the body and runs/renders —
 * so a full-document mockup renders unchanged, just governed by our head's CSP.
 * A second, author-supplied CSP meta cannot loosen ours: the UA enforces the
 * INTERSECTION of all delivered policies, and an author meta lands in body
 * (where meta CSP is ignored) besides.
 *
 * WHAT THE CSP DOES: allows script / style / img / font / media from public
 * `https:` (plus inline + eval, which inline mockups need) and `data:` / `blob:`;
 * and CLOSES `connect-src` (fetch / XHR / WebSocket / EventSource / beacon),
 * `form-action`, `base-uri`, `object-src`, and nested `frame-src` / `child-src`.
 *
 * WHAT IT DOES NOT DO — the accepted residual: a CSP host source like
 * `script-src https:` / `img-src https:` is an ALLOWLIST, not a negative set; it
 * cannot express "any public host EXCEPT backend / loopback / private / link
 * local". So author script/img/style/font can still issue GET requests to those
 * addresses via `<img>` / `<script>` / `<link>`. The opaque origin makes the
 * responses unreadable, but whether such a request carries the TARGET site's
 * ambient cookie is decided by Chromium's SameSite / third-party-cookie policy,
 * not by this sandbox — so a blind-request / CSRF surface toward other origins
 * remains. Silverhand's own API token is not in the frame and its WS cookie is
 * SameSite=Strict, so the "cannot reach Silverhand's own data" boundary holds.
 * This is NOT network isolation (shiki accepted B; Cindy review 2026-08-21).
 *
 * Note: a `<meta>`-delivered CSP cannot express `frame-ancestors` or `sandbox`;
 * those are carried by the iframe attribute, not here. Navigation is bounded by
 * the sandbox NOT granting `allow-top-navigation` / `allow-popups` (top escape
 * and new windows are blocked); the frame may still navigate ITSELF, which is
 * harmless — it stays inside the same opaque sandbox with no host access.
 */

/** The CSP applied to every HTML attachment preview. One policy string so the
 *  directive set is auditable in one place. */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data: blob:",
  "img-src https: data: blob:",
  "font-src https: data: blob:",
  "media-src https: data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
].join("; ");

/**
 * The trackpad-pinch bridge. The preview lives in an opaque-origin
 * iframe, so a `ctrl+wheel` pinch fires INSIDE the frame and never reaches the
 * host — the image Lightbox's host-side wheel listener cannot see it. This tiny
 * TRUSTED script (host-authored, never author bytes; governed by the CSP above)
 * is the only path to a preview-scoped pinch: it forwards the pinch's `deltaY`
 * to the parent and nothing else. It carries NO DOM, size, URL, or author body;
 * the parent applies the zoom (`AttachmentHtmlPreview` validates source/shape,
 * clamps, and coalesces). `preventDefault` fires only for a pinch, so ordinary
 * two-finger scroll still scrolls the author page. It sits in body position
 * after the policy, so the "nothing active precedes the CSP" invariant holds.
 */
export const HTML_PREVIEW_PINCH_TYPE = "silverhand:html-preview:pinch";
export const HTML_PREVIEW_PINCH_VERSION = 1;
/** A single wheel event's `deltaY` is clamped to this before it can move scale,
 *  so a spoofed or flooded value cannot jump the zoom. */
export const HTML_PREVIEW_PINCH_MAX_DELTA = 100;

const HTML_PREVIEW_PINCH_BRIDGE =
  `<script>(function(){` +
  `var T=${JSON.stringify(HTML_PREVIEW_PINCH_TYPE)},V=${HTML_PREVIEW_PINCH_VERSION};` +
  `window.addEventListener('wheel',function(e){` +
  `if(!e.ctrlKey)return;` +
  `e.preventDefault();` +
  `parent.postMessage({type:T,version:V,deltaY:e.deltaY},'*');` +
  `},{capture:true,passive:false});` +
  `})();</script>`;

/** The fixed, author-independent document head — charset first (so UTF-8 is
 *  fixed before the author body parses), then the policy. Nothing here derives
 *  from author bytes, so no input can place an active element before it. The
 *  trusted pinch bridge sits in body position, strictly after the policy. */
export const HTML_PREVIEW_TRUSTED_PREFIX =
  `<!DOCTYPE html><html><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
  `</head><body>${HTML_PREVIEW_PINCH_BRIDGE}`;

const TRUSTED_SUFFIX = `</body></html>`;

/**
 * Read a pinch `deltaY` out of a `postMessage` payload, or `null` if it is not a
 * well-formed pinch message from our bridge. The caller must ALSO check
 * `event.source === iframe.contentWindow` — this validates only the shape:
 * fixed type + version and a finite `deltaY`, clamped to `±MAX_DELTA`. An author
 * script on the opaque origin can forge this shape, but the only effect is a
 * visible, revocable zoom of its own preview.
 */
export function readPinchDelta(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.type !== HTML_PREVIEW_PINCH_TYPE || msg.version !== HTML_PREVIEW_PINCH_VERSION) {
    return null;
  }
  const deltaY = msg.deltaY;
  if (typeof deltaY !== "number" || !Number.isFinite(deltaY)) return null;
  return Math.max(-HTML_PREVIEW_PINCH_MAX_DELTA, Math.min(HTML_PREVIEW_PINCH_MAX_DELTA, deltaY));
}

/**
 * The `srcDoc` for the preview iframe: the author's HTML wrapped VERBATIM inside
 * a fixed trusted document whose head carries the CSP. See the module docblock
 * for why this wrap (not an injection scan) is the only byte-safe construction.
 */
export function htmlPreviewSrcDoc(authorHtml: string): string {
  return `${HTML_PREVIEW_TRUSTED_PREFIX}${authorHtml}${TRUSTED_SUFFIX}`;
}
