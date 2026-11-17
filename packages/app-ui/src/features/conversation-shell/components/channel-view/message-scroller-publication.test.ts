// @vitest-environment happy-dom
// Real scroller publication contract, with scheduling controlled; not browser layout proof.
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { MessageScroller, type MessageScrollerHandle } from "./message-scroller";
it("actual scroller returns false until first-paint rows publish", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let seq = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++seq, fn);
    return seq;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<MessageScrollerHandle>();
  const props = {
    items: Array.from({ length: 60 }, (_, i) => String(i)),
    itemKey: (i: string) => i,
    renderItem: (i: string) => React.createElement("div", {}, i),
    initialAnchor: { kind: "bottom" as const },
    follow: false,
    atBottomThreshold: 32,
    reachEdgeDistance: 32,
    onReachTop: () => {},
    onReachBottom: () => {},
    onAtBottomChange: () => {},
    onTopItemChange: () => {},
    controlRef: ref,
  };
  try {
    await act(async () => root.render(React.createElement(MessageScroller<string>, props)));
    expect(host.querySelector('[data-scroller-key="0"]')).toBeNull();
    expect(ref.current!.scrollToKey("0", "center")).toBe(false);
    await act(async () =>
      root.render(
        React.createElement(MessageScroller<string>, {
          ...props,
          initialAnchor: { kind: "key", key: "0", align: "center" },
        }),
      ),
    );
    expect(ref.current!.scrollToKey("0", "center")).toBe(false);
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((fn) => fn(16));
    });
    expect(host.querySelector('[data-scroller-key="0"]')).not.toBeNull();
    expect(ref.current!.scrollToKey("0", "center")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
