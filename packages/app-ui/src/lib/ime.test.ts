import { expect, it } from "vitest";
import { isImeKey } from "./ime";
it("keeps modern, tracked and legacy candidate commits out of send handlers", () => {
  expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
  expect(isImeKey({ isComposing: false, keyCode: 13 }, true)).toBe(true);
  expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
  expect(isImeKey({ isComposing: false, keyCode: 13 }, false)).toBe(false);
});
