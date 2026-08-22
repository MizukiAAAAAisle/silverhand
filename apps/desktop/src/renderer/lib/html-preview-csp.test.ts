import { describe, expect, it } from 'vitest';
import {
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_PINCH_MAX_DELTA,
  HTML_PREVIEW_PINCH_TYPE,
  HTML_PREVIEW_PINCH_VERSION,
  HTML_PREVIEW_TRUSTED_PREFIX,
  htmlPreviewSrcDoc,
  readPinchDelta,
} from './html-preview-csp';

describe('htmlPreviewSrcDoc', () => {
  it('wraps the author document in the fixed trusted prefix', () => {
    const out = htmlPreviewSrcDoc('<p>hi</p>');
    expect(out).toBe(`${HTML_PREVIEW_TRUSTED_PREFIX}<p>hi</p></body></html>`);
    expect(out.startsWith(HTML_PREVIEW_TRUSTED_PREFIX)).toBe(true);
  });

  it('leaves the author bytes verbatim inside the body', () => {
    const author = '<html><head><title>t</title></head><body>x</body></html>';
    const out = htmlPreviewSrcDoc(author);
    // The author document is not rewritten — it is placed after our head as-is;
    // the UA drops its now-in-body html/head/body tags while running its content.
    expect(out).toBe(`${HTML_PREVIEW_TRUSTED_PREFIX}${author}</body></html>`);
  });

  // Cindy B1 (2026-08-21): the prior impl scanned for the first `<head>` with a
  // regex, which is not an HTML parser. These are the three byte shapes that
  // slipped an author-active element in front of the policy. The trusted-prefix
  // construction must place the CSP meta before EVERY author byte regardless.
  it('keeps the policy before author bytes even when a comment fakes a <head>', () => {
    const out = htmlPreviewSrcDoc('<!-- <head> --><script>fetch("https://evil")</script>');
    assertPolicyPrecedesAuthor(out);
  });

  it('keeps the policy before author bytes when a script string contains <head>', () => {
    const out = htmlPreviewSrcDoc('<script>const x = "<head>"; fetch("https://evil")</script>');
    assertPolicyPrecedesAuthor(out);
  });

  it('keeps the policy before a request element that precedes the real <head>', () => {
    const out = htmlPreviewSrcDoc('<script src="https://evil/x.js"></script><head></head>');
    assertPolicyPrecedesAuthor(out);
  });

  it('closes connect/form/base/object and the nested-frame directives', () => {
    // The negative half of the policy — the part that is not a public allowlist.
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'");
    expect(HTML_PREVIEW_CSP).toContain("base-uri 'none'");
    expect(HTML_PREVIEW_CSP).toContain("object-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("frame-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("child-src 'none'");
  });
});

describe('readPinchDelta', () => {
  const ok = (deltaY: number): unknown => ({
    type: HTML_PREVIEW_PINCH_TYPE,
    version: HTML_PREVIEW_PINCH_VERSION,
    deltaY,
  });

  it('reads a well-formed pinch payload', () => {
    expect(readPinchDelta(ok(-40))).toBe(-40);
    expect(readPinchDelta(ok(12.5))).toBe(12.5);
  });

  it('clamps the delta to ±MAX so a flooded value cannot jump scale', () => {
    expect(readPinchDelta(ok(9999))).toBe(HTML_PREVIEW_PINCH_MAX_DELTA);
    expect(readPinchDelta(ok(-9999))).toBe(-HTML_PREVIEW_PINCH_MAX_DELTA);
  });

  it('rejects a wrong or missing type / version', () => {
    expect(readPinchDelta({ ...(ok(5) as object), type: 'other' })).toBeNull();
    expect(readPinchDelta({ ...(ok(5) as object), version: 2 })).toBeNull();
    expect(readPinchDelta({ version: HTML_PREVIEW_PINCH_VERSION, deltaY: 5 })).toBeNull();
  });

  it('rejects a non-finite or non-number delta', () => {
    expect(readPinchDelta(ok(Number.NaN))).toBeNull();
    expect(readPinchDelta(ok(Number.POSITIVE_INFINITY))).toBeNull();
    expect(readPinchDelta({ ...(ok(0) as object), deltaY: '5' })).toBeNull();
  });

  it('rejects non-object payloads', () => {
    expect(readPinchDelta(null)).toBeNull();
    expect(readPinchDelta(undefined)).toBeNull();
    expect(readPinchDelta('silverhand:html-preview:pinch')).toBeNull();
    expect(readPinchDelta(42)).toBeNull();
  });
});

/**
 * The core B1 invariant: the CSP meta is present, and no author-active element
 * (script / img / link / iframe / object / embed / style / a `<head>` that
 * could carry `<base>`) appears before it. The prefix is trusted, so it is
 * excluded from the "author bytes" slice we scan.
 */
function assertPolicyPrecedesAuthor(out: string): void {
  expect(out.startsWith(HTML_PREVIEW_TRUSTED_PREFIX)).toBe(true);
  const authorBytes = out.slice(HTML_PREVIEW_TRUSTED_PREFIX.length);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
  expect(HTML_PREVIEW_TRUSTED_PREFIX).toContain(meta);
  // Nothing that loads a subresource or re-bases the document precedes the meta.
  expect(HTML_PREVIEW_TRUSTED_PREFIX.split(meta)[0]).not.toMatch(
    /<(script|img|link|iframe|object|embed|style|base)\b/i,
  );
  // And the author's own request elements now live strictly after the policy.
  expect(authorBytes).not.toContain(meta);
}
