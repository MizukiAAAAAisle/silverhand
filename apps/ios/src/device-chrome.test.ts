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

it("publishes the bar extents pages clear", () => {
  emit("barMetrics", { bottom: 116, tabs: 48, vertical: false, corner: 55 });
  expect(root.style.get("--native-bar-bottom")).toBe("116px");
  expect(root.style.get("--display-corner-radius")).toBe("55px");
  expect(root.style.get("--native-bar-tabs")).toBe("48px");
  expect(root.dataset["verticalBar"]).toBeUndefined();
});

it("marks bars standing on a side edge, and clears the mark when they leave it", () => {
  emit("barMetrics", { bottom: 0, tabs: 48, vertical: true, corner: 55 });
  expect(root.dataset["verticalBar"]).toBe("");

  emit("barMetrics", { bottom: 116, tabs: 48, vertical: false, corner: 55 });
  expect(root.dataset["verticalBar"]).toBeUndefined();
});
