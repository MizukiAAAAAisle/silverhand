import { describe, expect, it, vi } from "vitest";
import type { PageBarState } from "@silverhand/client";

vi.mock("./glyph", () => ({
  rasterizeMarkup: vi.fn(async (markup: string) => `png:${/data-id="(\w+)"/.exec(markup)?.[1]}`),
  rasterizeImage: vi.fn(async (url: string) => `picture:${url}`),
}));
import { createIOSPageBar } from "./page-bar";
import type { NativeBridge } from "./bridge";

const state = (title: string): PageBarState => ({
  title,
  titleAction: "Opens settings",
  titleIcon: { glyph: '<svg data-id="hash"></svg>' },
  back: "Back",
  actions: [[{ id: "find", label: "Search", icon: '<svg data-id="find"></svg>' }]],
  tabs: [{ id: "chat", label: "Chat", icon: '<svg data-id="chat"></svg>', closeLabel: null }],
  addTabs: null,
});

describe("iOS page bar", () => {
  it("sends glyphs as PNG, keeps the latest state, and removes the bar", async () => {
    const pageBar = vi.fn(async () => {});
    const bar = createIOSPageBar({ pageBar } as unknown as NativeBridge);

    await Promise.all([bar.sync(state("first")), bar.sync(state("second"))]);
    expect(pageBar).toHaveBeenCalledTimes(1);
    const sent = (pageBar.mock.calls[0] as unknown as [{ state: PageBarState }])[0].state;
    expect(sent.title).toBe("second");
    expect(sent.actions[0]?.[0]?.icon).toBe("png:find");
    expect(sent.tabs?.[0]?.icon).toBe("png:chat");
    expect(sent.titleIcon).toEqual({ glyph: "png:hash" });

    await bar.sync({ ...state("dm"), titleIcon: { image: "blob:face" } });
    expect(
      (pageBar.mock.lastCall as unknown as [{ state: PageBarState }])[0].state.titleIcon,
    ).toEqual({ image: "picture:blob:face" });

    await bar.sync(null);
    expect(pageBar).toHaveBeenLastCalledWith({ state: null });
  });
});
