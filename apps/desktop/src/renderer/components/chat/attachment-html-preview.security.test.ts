import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentHtmlPreview } from "./attachment-html-preview";
import { HTML_PREVIEW_CSP } from "@/features/attachments/html-preview-csp";

/**
 * Security fence for the real HTML preview carrier. SSR markup is tested rather
 * than a copied constant so any capability change on the iframe is observable.
 */
describe("AttachmentHtmlPreview sandbox fence", () => {
  const markup = renderToStaticMarkup(
    createElement(AttachmentHtmlPreview, { html: "<p>x</p>", title: "demo.html" }),
  );

  const sandbox = markup.match(/sandbox="([^"]*)"/)?.[1];

  it("grants exactly allow-scripts and nothing else", () => {
    // Strict equality, not a substring — the token set is the isolation boundary.
    expect(sandbox).toBe("allow-scripts");
  });

  it("never grants a token that would defeat the opaque-origin isolation", () => {
    for (const forbidden of [
      "allow-same-origin", // hands the frame the host's real origin — the cardinal one
      "allow-forms",
      "allow-popups",
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-downloads",
      "allow-modals",
      "allow-pointer-lock",
      "allow-presentation",
    ]) {
      expect(sandbox ?? "").not.toContain(forbidden);
    }
  });

  it("sends no referrer on subresource requests the author scripts may fire", () => {
    expect(markup).toMatch(/referrerpolicy="no-referrer"/i);
  });

  it("loads the author document through the injected CSP, not the host DOM", () => {
    // The frame is fed via srcDoc (isolated document), and the CSP rides inside it.
    expect(markup).toMatch(/srcdoc="/i);
    expect(markup).toContain(HTML_PREVIEW_CSP.replace(/'/g, "&#x27;"));
    // Never innerHTML'd into the host — no un-sandboxed injection path.
    expect(markup).toContain("<iframe");
  });

  it("zooms by enlarging the isolated viewport and scaling the carrier", () => {
    const zoomed = renderToStaticMarkup(
      createElement(AttachmentHtmlPreview, {
        html: '<main style="width:1600px">x</main>',
        title: "large.html",
        zoom: 0.5,
      }),
    );

    expect(zoomed).toContain("width:200%");
    expect(zoomed).toContain("height:200%");
    expect(zoomed).toContain("transform:scale(0.5)");
    expect(zoomed).toContain("transform-origin:top left");
    expect(zoomed).toContain('sandbox="allow-scripts"');
  });
});
