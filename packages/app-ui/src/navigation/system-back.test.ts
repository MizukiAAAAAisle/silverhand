// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { bindSystemBack } from "./system-back";
import { modalScope } from "@/lib/modal-scope";

afterEach(() => { document.body.innerHTML = ""; });
function setup(canBack = true) {
  let callback = () => false;
  const remove = vi.fn();
  const back = vi.fn();
  let active = true;
  const dispose = bindSystemBack({ subscribe: (handler) => { callback = handler; return remove; } }, {
    active: () => active, canBack: () => canBack, back,
  });
  return { request: () => callback(), back, dispose, remove, deactivate: () => { active = false; } };
}
it("leaves absent capabilities and root pages to their platform", () => {
  expect(() => bindSystemBack(undefined, { active: () => true, canBack: () => false, back: vi.fn() })()).not.toThrow();
  const s = setup(false);
  expect(s.request()).toBe(false);
  expect(s.back).not.toHaveBeenCalled();
  s.dispose();
});
it("lets the focused top overlay consume Escape without popping navigation", () => {
  const s = setup();
  const field = document.createElement("input"); document.body.append(field); field.focus();
  const escape = (e: Event) => e.preventDefault();
  field.addEventListener("keydown", escape);
  expect(s.request()).toBe(true);
  expect(s.back).not.toHaveBeenCalled();
  field.removeEventListener("keydown", escape);
  const releaseModal = modalScope.acquire();
  expect(s.request()).toBe(true);
  expect(s.back).not.toHaveBeenCalled();
  releaseModal();
  expect(s.request()).toBe(true);
  expect(s.back).toHaveBeenCalledTimes(1);
  s.dispose();
});
it("consumes a guarded route once and ignores callbacks after release or old-session disposal", () => {
  const s = setup();
  expect(s.request()).toBe(true);
  expect(s.back).toHaveBeenCalledTimes(1);
  s.deactivate();
  expect(s.request()).toBe(false);
  s.dispose(); s.dispose();
  expect(s.request()).toBe(false);
  expect(s.back).toHaveBeenCalledTimes(1);
});
