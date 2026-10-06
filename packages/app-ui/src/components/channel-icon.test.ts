import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChannelIcon } from "./channel-icon";

// The channel `#` glyph must be sticker-or-utility BY CONSTRUCTION: the
// `data-channel-icon` theme hook (whose poster sticker chrome inflates the box)
// may ride identity surfaces but never a compact/utility control. #task:1437
// was that hook on a filter trigger (14px → 18px); #task:1438 moves the
// decision into this primitive so a call-site can't re-introduce the drift.

describe("ChannelIcon — sticker vs utility is enforced (#task:1438)", () => {
  it("utility variant renders a plain `#` with NO sticker hook", () => {
    const html = renderToStaticMarkup(React.createElement(ChannelIcon, { variant: "utility" }));
    expect(html).not.toContain("data-channel-icon");
  });

  it("sticker variant carries the canonical `data-channel-icon` hook", () => {
    const html = renderToStaticMarkup(React.createElement(ChannelIcon, { variant: "sticker" }));
    expect(html).toContain("data-channel-icon");
  });

  it("variant is required — omitting it fails loud, never a silent branch", () => {
    // A missing variant must throw, NOT quietly render as utility (which would
    // strip the hook off an identity surface). TS makes this a compile error;
    // this proves the runtime guard for untyped/JS callers.
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderToStaticMarkup(React.createElement(ChannelIcon, {} as any)),
    ).toThrow(/variant/);
  });
});

describe("ChannelIcon — visibility selects the glyph (private = Lock)", () => {
  // The private/public glyph split is a product-semantic axis, orthogonal to
  // the sticker/utility hook: a `private` channel is membership-gated so it
  // wears a Lock; `public` (and every existing omit-visibility call-site) keeps
  // the canonical `#`. This locks the SEMANTIC mapping (which glyph), not any
  // size — sizing stays owned by the density scale above.
  it("private renders a Lock, never the `#` Hash — and stays a channel identity", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelIcon, { variant: "sticker", visibility: "private" }),
    );
    expect(html).toContain("icon-lock");
    expect(html).not.toContain("icon-hash");
    // A private channel is still a channel identity → keeps the sticker hook.
    expect(html).toContain("data-channel-icon");
  });

  it("public renders the canonical `#` Hash, never a Lock", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelIcon, { variant: "sticker", visibility: "public" }),
    );
    expect(html).toContain("icon-hash");
    expect(html).not.toContain("icon-lock");
  });

  it("omitted visibility defaults to the `#` Hash (existing call-sites unchanged)", () => {
    const html = renderToStaticMarkup(React.createElement(ChannelIcon, { variant: "utility" }));
    expect(html).toContain("icon-hash");
    expect(html).not.toContain("icon-lock");
  });
});
