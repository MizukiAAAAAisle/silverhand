// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThemeId } from "./types";
import type { ThemePersistence, useAppearance } from "./use-appearance";

let store: typeof import("./use-appearance");
let hook: ReturnType<typeof useAppearance>;
let root: Root | undefined;
const key = "silverhand:appearance";
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function mount(persistence?: ThemePersistence) {
  if (persistence) await store.initializeThemePersistence(persistence);
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  function Reader() { hook = store.useAppearance(); return null; }
  await act(async () => root!.render(createElement(Reader)));
}
async function choose(theme: ThemeId) {
  let result!: Promise<void>;
  await act(async () => { result = Promise.resolve(hook.setTheme(theme)); });
  return { result };
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
    clear: () => values.clear(),
  });
  document.documentElement.dataset.theme = "studio-light";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  store = await import("./use-appearance");
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads the native authority while retaining non-theme mirror fields, without a startup save", async () => {
  localStorage.setItem(key, '{"theme":"glass","fontSize":18,"code":{"fontFamily":"Mono"}}');
  const saveTheme = vi.fn();
  await mount({ getTheme: async () => "iris", saveTheme });
  expect(hook.appearance).toEqual({ theme: "iris", fontSize: 18, code: { fontFamily: "Mono" } });
  expect(document.documentElement.dataset.theme).toBe("iris");
  expect(hook.themeStatus).toEqual({ confirmed: true });
  expect(document.documentElement.dataset.themePersistence).toBe("confirmed");
  expect(saveTheme).not.toHaveBeenCalled();
});

it.each([null, "invalid", new Error("read failed")])(
  "mounts an unconfirmed legacy display without writing for native result %s",
  async (value) => {
    localStorage.setItem(key, '{"theme":"forza6","fontSize":17}');
    const saveTheme = vi.fn();
    await mount({ getTheme: async () => { if (value instanceof Error) throw value; return value; }, saveTheme });
    expect(hook.appearance).toEqual({ theme: "poster", fontSize: 17 });
    expect(hook.themeStatus?.confirmed).toBe(false);
    expect(document.documentElement.dataset.themePersistence).toBe("unconfirmed");
    expect(saveTheme).not.toHaveBeenCalled();
  },
);

it("uses the existing default and still mounts if both native read and mirror access fail", async () => {
  const readMirror = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("mirror denied"); });
  await mount({ getTheme: async () => { throw new Error("read denied"); }, saveTheme: vi.fn() });
  expect(hook.appearance).toEqual({ theme: "studio-light" });
  expect(hook.themeStatus?.confirmed).toBe(false);
  expect(readMirror).toHaveBeenCalledWith(key);
});

it("saves the same fallback theme and publishes confirmation only after its ack", async () => {
  localStorage.setItem(key, '{"theme":"warm-script"}');
  const pending = deferred(), saveTheme = vi.fn(() => pending.promise);
  await mount({ getTheme: async () => null, saveTheme });
  const choice = await choose("studio-light");
  expect(saveTheme).toHaveBeenCalledWith("studio-light");
  expect(hook.themeStatus?.confirmed).toBe(false);
  expect(document.documentElement.dataset.themePersistence).toBe("pending");
  await act(async () => { pending.resolve(); await choice.result; });
  expect(hook.themeStatus?.confirmed).toBe(true);
  expect(document.documentElement.dataset.themePersistence).toBe("confirmed");
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ theme: "studio-light" });
});

it("keeps the displayed theme until native confirmation and merges intervening font edits", async () => {
  const pending = deferred();
  await mount({ getTheme: async () => "studio-light", saveTheme: () => pending.promise });
  const choice = await choose("glass");
  await act(async () => hook.setMarkdownFontSize(20));
  expect(hook.appearance.theme).toBe("studio-light");
  expect(document.documentElement.dataset.theme).toBe("studio-light");
  await act(async () => { pending.resolve(); await choice.result; });
  expect(hook.appearance).toEqual({ theme: "glass", fontSize: 20 });
  expect(document.documentElement.dataset.theme).toBe("glass");
});

it("revokes confirmation for an already selected theme while saving and after failure", async () => {
  const pending = deferred();
  await mount({ getTheme: async () => "glass", saveTheme: () => pending.promise });
  expect(document.documentElement.dataset.themePersistence).toBe("confirmed");
  const choice = await choose("glass");
  const failed = choice.result.catch((error: unknown) => error);
  expect(document.documentElement.dataset.theme).toBe("glass");
  expect(document.documentElement.dataset.themePersistence).toBe("pending");
  await act(async () => pending.reject(new Error("not acknowledged")));
  expect(await failed).toEqual(new Error("not acknowledged"));
  expect(document.documentElement.dataset.theme).toBe("glass");
  expect(document.documentElement.dataset.themePersistence).toBe("unconfirmed");
});

it("propagates a failed choice without publication, then executes the queued later choice", async () => {
  const first = deferred(), second = deferred();
  const saveTheme = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await mount({ getTheme: async () => "studio-light", saveTheme });
  const a = await choose("glass");
  const failed = a.result.catch((error: unknown) => error);
  const b = await choose("iris");
  expect(saveTheme).toHaveBeenCalledTimes(1);
  await act(async () => first.reject(new Error("commit false")));
  expect(await failed).toEqual(new Error("commit false"));
  expect(hook.appearance.theme).toBe("studio-light");
  expect(hook.themeStatus?.confirmed).toBe(false);
  expect(document.documentElement.dataset.themePersistence).toBe("pending");
  expect(saveTheme).toHaveBeenNthCalledWith(2, "iris");
  await act(async () => { second.resolve(); await b.result; });
  expect(hook.appearance.theme).toBe("iris");
  expect(hook.themeStatus).toEqual({ confirmed: true });
  expect(document.documentElement.dataset.themePersistence).toBe("confirmed");
});

it("serializes rapid choices so an old completion cannot overwrite the final acknowledged theme", async () => {
  const a = deferred(), b = deferred(), c = deferred();
  const saveTheme = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise);
  await mount({ getTheme: async () => "studio-light", saveTheme });
  const one = await choose("glass"), two = await choose("poster"), three = await choose("slack-dark");
  expect(saveTheme.mock.calls).toEqual([["glass"]]);
  await act(async () => { a.resolve(); await one.result; });
  expect(hook.appearance.theme).toBe("glass");
  expect(document.documentElement.dataset.themePersistence).toBe("pending");
  expect(saveTheme.mock.calls).toEqual([["glass"], ["poster"]]);
  await act(async () => { b.resolve(); await two.result; });
  expect(hook.appearance.theme).toBe("poster");
  expect(document.documentElement.dataset.themePersistence).toBe("pending");
  await act(async () => { c.resolve(); await three.result; });
  expect(hook.appearance.theme).toBe("slack-dark");
  expect(document.documentElement.dataset.themePersistence).toBe("confirmed");
  expect(JSON.parse(localStorage.getItem(key)!).theme).toBe("slack-dark");
});

it("does not turn a failed compatibility mirror into a failed native save", async () => {
  await mount({ getTheme: async () => "studio-light", saveTheme: async () => {} });
  const writeMirror = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await act(async () => { await hook.setTheme("glass"); });
  expect(hook.appearance.theme).toBe("glass");
  expect(hook.themeStatus).toEqual({ confirmed: true });
  expect(writeMirror).toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith("Unable to mirror the confirmed theme", expect.any(Error));
});

it("font edits during degraded startup neither save nor confirm the native theme", async () => {
  const saveTheme = vi.fn();
  await mount({ getTheme: async () => null, saveTheme });
  await act(async () => { hook.setMarkdownFont("prose", "Georgia"); hook.setMarkdownFontSize(18); });
  expect(hook.appearance).toEqual({ theme: "studio-light", fontSize: 18, prose: { fontFamily: "Georgia" } });
  expect(hook.themeStatus?.confirmed).toBe(false);
  expect(saveTheme).not.toHaveBeenCalled();
});

it.each(["glass", "studio-light"] as const)("keeps the unconfigured platform's synchronous %s/localStorage contract", async (theme) => {
  localStorage.setItem(key, JSON.stringify({ theme, fontSize: 16 }));
  await mount();
  expect(hook.themeStatus).toBeUndefined();
  let result: unknown;
  await act(async () => { result = hook.setTheme("iris"); });
  expect(result).toBeUndefined();
  expect(hook.appearance).toEqual({ theme: "iris", fontSize: 16 });
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(hook.appearance);
});
