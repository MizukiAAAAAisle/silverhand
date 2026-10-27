// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NavigationContext, type Driver } from "./provider";
import { PageStack } from "./page-stack";
import { Router } from "react-router-dom";
vi.mock("./layout", () => ({ useCompactLayout: () => true }));
vi.mock("./page-bar", () => ({ usePageBarSwipe: () => null }));

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });
async function swipe(end: "touchcancel" | "touchend") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const back = vi.fn(() => true);
  const base: Driver = { session: "test", go() {}, back, selectTab() {}, openSection() {}, tab: "chat", canBack: true,
    page: "a", backPage: null, keptPages: ["a"], registerLeaveGuard: () => () => {} };
  const render = (driver: Driver) => root.render(createElement(NavigationContext.Provider, { value: driver },
    createElement(Router, { location: "/chat", navigator: { createHref: String, go() {}, push() {}, replace() {} } },
      createElement(PageStack, null, createElement("p", null, driver.page)))));
  await act(async () => render(base));
  await act(async () => render({ ...base, page: "b", backPage: "a", keptPages: ["a", "b"] }));
  const frames = container.querySelectorAll('[data-page]');
  Object.defineProperty(frames[1], "offsetWidth", { value: 400 });
  const touch = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: type === "touchstart" || type === "touchmove" ? [{ clientX: x, clientY: 100 }] : [] });
    return event;
  };
  await act(async () => { container.querySelector('[data-page-stack]')!.dispatchEvent(touch("touchstart", 5)); });
  await act(async () => { window.dispatchEvent(touch("touchmove", 300)); });
  await act(async () => { window.dispatchEvent(touch(end, 300)); });
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  return back;
}
it("never commits a cancelled page touch after passing the normal commit threshold", async () => {
  expect(await swipe("touchcancel")).not.toHaveBeenCalled();
});
it("commits a completed page touch once through the same gesture path", async () => {
  expect(await swipe("touchend")).toHaveBeenCalledTimes(1);
});
