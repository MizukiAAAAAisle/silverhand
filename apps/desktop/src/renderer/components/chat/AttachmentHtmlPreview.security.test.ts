import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttachmentHtmlPreview } from './AttachmentHtmlPreview';
import { HTML_PREVIEW_CSP } from '@/lib/html-preview-csp';

/**
 * Security fence for the HTML preview carrier (Cindy B2, 2026-08-21). "UI is not
 * tested" does NOT extend to the sandbox capability: this is the one attribute
 * whose silent loosening (e.g. adding `allow-same-origin`) would collapse the
 * whole isolation while leaving classifier/CSP-string tests green. So we render
 * the REAL component and assert the sandbox value the browser would receive.
 *
 * SSR markup (not a constant) is the carrier under test — a future edit to the
 * `sandbox=` literal in AttachmentHtmlPreview.tsx must break this, or the fence
 * is worthless.
 */
describe('AttachmentHtmlPreview sandbox fence', () => {
  const markup = renderToStaticMarkup(
    createElement(AttachmentHtmlPreview, { html: '<p>x</p>', title: 'demo.html' }),
  );

  const sandbox = markup.match(/sandbox="([^"]*)"/)?.[1];

  it('grants exactly allow-scripts and nothing else', () => {
    // Strict equality, not a substring — the token set is the isolation boundary.
    expect(sandbox).toBe('allow-scripts');
  });

  it('never grants a token that would defeat the opaque-origin isolation', () => {
    for (const forbidden of [
      'allow-same-origin', // hands the frame the host's real origin — the cardinal one
      'allow-forms',
      'allow-popups',
      'allow-top-navigation',
      'allow-top-navigation-by-user-activation',
      'allow-downloads',
      'allow-modals',
      'allow-pointer-lock',
      'allow-presentation',
    ]) {
      expect(sandbox ?? '').not.toContain(forbidden);
    }
  });

  it('sends no referrer on subresource requests the author scripts may fire', () => {
    expect(markup).toMatch(/referrerpolicy="no-referrer"/i);
  });

  it('loads the author document through the injected CSP, not the host DOM', () => {
    // The frame is fed via srcDoc (isolated document), and the CSP rides inside it.
    expect(markup).toMatch(/srcdoc="/i);
    expect(markup).toContain(HTML_PREVIEW_CSP.replace(/'/g, '&#x27;'));
    // Never innerHTML'd into the host — no un-sandboxed injection path.
    expect(markup).toContain('<iframe');
  });
});
