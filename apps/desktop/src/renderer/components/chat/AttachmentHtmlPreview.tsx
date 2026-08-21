import { useMemo } from 'react';
import { htmlPreviewSrcDoc } from '@/lib/html-preview-csp';

/**
 * Renders a `.html` attachment inside an isolated, opaque-origin iframe
 * (#task:2122; shiki + Cindy's B boundary, 2026-08-21). The security rationale
 * and the accepted residual live in `lib/html-preview-csp.ts` — this component
 * is only the carrier: it wires the author document into a `sandbox` iframe with
 * the injected CSP and the minimum capabilities the boundary permits.
 *
 * `sandbox="allow-scripts"` and NOTHING ELSE — deliberately no
 * `allow-same-origin` (that alone would defeat the isolation, handing the frame
 * the host's real origin), and no `allow-forms` / `allow-popups` /
 * `allow-top-navigation` / `allow-downloads` / `allow-modals`. Author scripts
 * run (agent mockups routinely need a CDN chart/UI lib), but on an opaque origin
 * with no host DOM / storage / cookie access and no way to escape the frame.
 *
 * `referrerPolicy="no-referrer"` so a subresource GET the author's script fires
 * (the accepted residual) doesn't even leak the app URL as a Referer.
 */
export function AttachmentHtmlPreview({
  html,
  title,
}: {
  html: string;
  /** Accessible name for the frame — the attachment filename. */
  title: string;
}): JSX.Element {
  const srcDoc = useMemo(() => htmlPreviewSrcDoc(html), [html]);
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}
