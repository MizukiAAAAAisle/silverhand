import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDrawnIcon } from "./icon";

const Clipped = createDrawnIcon("clipped", ({ id }) =>
  createElement(
    Fragment,
    null,
    createElement("clipPath", { id: `${id}cut` }, createElement("rect", { width: 12, height: 24 })),
    createElement("circle", { cx: 12, cy: 12, r: 9, clipPath: `url(#${id}cut)` }),
  ),
);

describe("createDrawnIcon", () => {
  it("gives every rendered instance its own clip id", () => {
    const markup = renderToStaticMarkup(
      createElement(Fragment, null, createElement(Clipped), createElement(Clipped)),
    );
    const ids = [...markup.matchAll(/<clipPath id="([^"]+)"/g)].map((match) => match[1]);
    const refs = [...markup.matchAll(/clip-path="url\(#([^)]+)\)"/g)].map((match) => match[1]);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(refs).toEqual(ids);
  });
});
