import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AVATAR_PX, AVATAR_PX_DEFAULT } from "./avatar-scale";
import { AgentAvatar } from "./agent-avatar";
import { UserAvatar } from "./user-avatar";

// Locks the identity-avatar square scale (#task:1440) as CONTRACT, not pixels:
// (1) the default tier is `md` (the historical default must never drift to a
// different tier), (2) both avatar components consume the same scale so an
// agent/human peer pair in one row renders at identical size, (3) a caller's
// tier reaches the rendered box. Expectations are derived from the scale
// constants — the literal px values are visual, verified by dogfood. The
// no-hand-written-literal source fence lives in avatar-scale-fence.test.ts.

describe("AVATAR_PX scale (#task:1440)", () => {
  it("defaults to the `md` tier — never drift the historical default", () => {
    expect(AVATAR_PX_DEFAULT).toBe(AVATAR_PX.md);
  });
});

describe("AgentAvatar / UserAvatar consume the scale (#task:1440)", () => {
  it("both default to the same tier box when size is omitted", () => {
    const agent = renderToStaticMarkup(React.createElement(AgentAvatar, { runtime: "claude" }));
    const human = renderToStaticMarkup(React.createElement(UserAvatar, {}));
    expect(agent).toContain(`width:${AVATAR_PX_DEFAULT}px`);
    expect(agent).toContain(`height:${AVATAR_PX_DEFAULT}px`);
    expect(human).toContain(`width:${AVATAR_PX_DEFAULT}px`);
    expect(human).toContain(`height:${AVATAR_PX_DEFAULT}px`);
  });

  it("a caller tier reaches both peer branches identically", () => {
    const agent = renderToStaticMarkup(
      React.createElement(AgentAvatar, { runtime: "claude", size: AVATAR_PX.sm }),
    );
    const human = renderToStaticMarkup(React.createElement(UserAvatar, { size: AVATAR_PX.sm }));
    // Same token → same pixels for the agent/human peer branches of a row.
    expect(agent).toContain(`width:${AVATAR_PX.sm}px`);
    expect(human).toContain(`width:${AVATAR_PX.sm}px`);
  });
});
