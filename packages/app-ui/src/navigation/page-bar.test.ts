import { describe, expect, it, vi } from "vitest";
import type { PageBarCapability, PageBarState } from "@silverhand/client";
import { FALLBACK_ORDER, PageBarHub, type PageBarDeclaration } from "./page-bar";
import { t } from "@/lib/i18n";

vi.mock("@/platform", () => ({ getPlatform: () => ({}) }));

const declaration = (title: string): PageBarDeclaration => ({
  title,
  titleAction: null,
  actions: [],
  tabs: null,
  addTabs: null,
});

function setup() {
  const sent: (PageBarState | null)[] = [];
  const progress: (number | null)[] = [];
  let releaseSync = () => {};
  const bar: PageBarCapability = {
    sync: vi.fn(async (state: PageBarState | null) => {
      sent.push(state);
      await new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
    }),
    backProgress: vi.fn(async (value: number | null) => {
      progress.push(value);
    }),
    subscribe: vi.fn(async () => () => {}),
  };
  const hub = new PageBarHub(bar, () => {});
  return { hub, sent, progress, release: () => releaseSync() };
}

describe("PageBarHub", () => {
  it("sends one state for a page handing the bar to the next within a commit", () => {
    const { hub, sent } = setup();
    const first = hub.order();
    hub.claim(first, { bar: declaration("A"), handlers: () => ({}) });
    hub.flush();

    const second = hub.order();
    hub.claim(first, null);
    hub.claim(second, { bar: declaration("B"), handlers: () => ({}) });
    hub.flush();

    expect(sent.map((state) => state?.title ?? null)).toEqual(["A", "B"]);
  });

  it("draws the bar again after it was cleared outside a flush", () => {
    const { hub, sent } = setup();
    hub.claim(hub.order(), { bar: declaration("Chats"), handlers: () => ({}) });
    hub.flush();
    hub.clear();
    hub.flush();
    expect(sent.map((state) => state?.title ?? null)).toEqual(["Chats", null, "Chats"]);
  });

  it("shows the fallback only while no page claims the bar", () => {
    const { hub, sent } = setup();
    hub.claim(FALLBACK_ORDER, { bar: declaration("Members"), handlers: () => ({}) });
    hub.flush();
    const page = hub.order();
    hub.claim(page, { bar: declaration("Agent"), handlers: () => ({}) });
    hub.flush();
    hub.claim(page, null);
    hub.flush();

    expect(sent.map((state) => state?.title ?? null)).toEqual(["Members", "Agent", "Members"]);
  });

  it("removes the bar for a page that claims none", () => {
    const { hub, sent } = setup();
    hub.claim(FALLBACK_ORDER, { bar: declaration("Chats"), handlers: () => ({}) });
    hub.flush();
    hub.claim(hub.order(), { bar: null, handlers: () => ({}) });
    hub.flush();

    expect(sent.map((state) => state?.title ?? null)).toEqual(["Chats", null]);
  });

  it("adds Back from navigation and resends when it changes", () => {
    const { hub, sent } = setup();
    hub.claim(hub.order(), { bar: declaration("A"), handlers: () => ({}) });
    hub.flush();
    hub.navigate({ canBack: true, page: "a", back: () => {} });
    hub.flush();
    hub.flush();

    expect(sent.map((state) => state?.back ?? null)).toEqual([null, t("common.back")]);
  });

  it("shows a large title only at a Tab root", () => {
    const { hub, sent } = setup();
    hub.claim(hub.order(), {
      bar: { ...declaration("Search"), largeTitle: true },
      handlers: () => ({}),
    });
    hub.flush();
    hub.navigate({ canBack: true, page: "search", back: () => {} });
    hub.flush();

    expect(sent.map((state) => state?.largeTitle ?? null)).toEqual([true, null]);
  });

  it("routes events to the standing claim and Back to navigation", () => {
    const { hub } = setup();
    const under = vi.fn();
    const top = vi.fn();
    const back = vi.fn();
    hub.navigate({ canBack: true, page: "b", back });
    hub.claim(hub.order(), { bar: declaration("A"), handlers: () => ({ action: under }) });
    hub.claim(hub.order(), { bar: declaration("B"), handlers: () => ({ action: top }) });

    hub.dispatch({ kind: "action", id: "find" });
    hub.dispatch({ kind: "back" });

    expect(top).toHaveBeenCalledWith({ kind: "action", id: "find" });
    expect(under).not.toHaveBeenCalled();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("ends a committed swipe after the next page's bar is sent", async () => {
    const { hub, progress, release } = setup();
    hub.navigate({ canBack: true, page: "thread", back: () => {} });
    hub.claim(hub.order(), { bar: declaration("Thread"), handlers: () => ({}) });
    hub.flush();
    release();
    hub.swipeProgress(0.6);
    hub.swipeEnd("thread");
    hub.flush();
    await Promise.resolve();
    expect(progress).toEqual([0.6]);

    hub.navigate({ canBack: false, page: "channel", back: () => {} });
    hub.claim(hub.order(), { bar: declaration("Channel"), handlers: () => ({}) });
    hub.flush();
    await Promise.resolve();
    expect(progress).toEqual([0.6]);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progress).toEqual([0.6, null]);
  });

  it("ends a cancelled swipe at once", () => {
    const { hub, progress } = setup();
    hub.swipeProgress(0.3);
    hub.swipeEnd(null);

    expect(progress).toEqual([0.3, null]);
  });
});
