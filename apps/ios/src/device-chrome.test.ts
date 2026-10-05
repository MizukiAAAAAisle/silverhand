import { beforeEach, expect, it, vi } from "vitest";
import type { NativeBridge } from "./bridge";
import { installDeviceChrome } from "./device-chrome";

type Handler = (state: never) => void;
let handlers: Map<string, Handler>;
let root: { dataset: Record<string, string>; style: Map<string, string> };

beforeEach(async () => {
  handlers = new Map();
  const style = new Map<string, string>();
  root = { dataset: {}, style };
  vi.stubGlobal("document", {
    documentElement: {
      dataset: root.dataset,
      style: {
        setProperty: (key: string, value: string) => style.set(key, value),
        removeProperty: (key: string) => style.delete(key),
      },
    },
  });
  const bridge = {
    addListener: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return Promise.resolve({ remove: vi.fn() });
    },
  } as unknown as NativeBridge;
  await installDeviceChrome(bridge);
});

const emit = (event: string, state: unknown) => handlers.get(event)!(state as never);

it("publishes the fold band and clears it when the device opens", () => {
  emit("fold", { axis: "horizontal", start: 455.5, end: 495.5 });
  expect(root.dataset["fold"]).toBe("horizontal");
  expect(root.style.get("--fold-start")).toBe("455.5px");
  expect(root.style.get("--fold-end")).toBe("495.5px");

  emit("fold", {});
  expect(root.dataset["fold"]).toBeUndefined();
  expect(root.style.has("--fold-start")).toBe(false);
  expect(root.style.has("--fold-end")).toBe(false);
});

it("mirrors the vertical bar edge", () => {
  emit("verticalBar", { edge: "trailing" });
  expect(root.dataset["verticalBar"]).toBe("trailing");

  emit("verticalBar", { edge: "" });
  expect(root.dataset["verticalBar"]).toBeUndefined();
});

it("centres the titlebar row on the window controls below the status bar", () => {
  emit("windowControls", { top: 24, height: 32, statusBar: 24 });
  expect(root.dataset["windowControls"]).toBeUndefined();
  expect(root.style.get("--titlebar-inset-top")).toBe("24px");
  expect(root.style.get("--titlebar-row-height")).toBe("48px");

  emit("windowControls", { top: 24, height: 0, statusBar: 24 });
  expect(root.dataset["windowControls"]).toBe("hidden");
  expect(root.style.has("--titlebar-inset-top")).toBe(false);
});
