import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChannelJoinBar } from "./ChannelJoinBar";

// The composer-slot affordance a non-member sees when browsing a public
// channel. These lock the behavior that matters: the Join action is live while
// idle and inert while a join is in flight (no double-submit). Deliberately NOT
// asserting the label copy, sizes, or spacing — those are visual/copy-review
// concerns, not behavior (ratified test guidelines).

describe("ChannelJoinBar", () => {
  function countButtons(html: string): number {
    return (html.match(/<button\b/g) ?? []).length;
  }

  it("idle: exactly one Join action, enabled", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelJoinBar, { onJoin: () => {}, joining: false }),
    );
    // The bar must carry exactly one real `<button>` action — guards against
    // the component decaying into an inert `<div>` where "no disabled" would
    // pass vacuously.
    expect(countButtons(html)).toBe(1);
    // The `disabled` ATTRIBUTE is absent when idle (Tailwind `disabled:` utility
    // classes always appear in the markup, so match the attribute precisely).
    expect(html).not.toContain('disabled=""');
  });

  it("joining: the single action is disabled (no double-submit)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelJoinBar, { onJoin: () => {}, joining: true }),
    );
    expect(countButtons(html)).toBe(1);
    expect(html).toContain('disabled=""');
  });
});
