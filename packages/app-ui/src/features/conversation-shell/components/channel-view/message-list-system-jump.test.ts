// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMessageSeq } from "@silverhand/shared";
import type { CachedMessage } from "@/features/channels/pending-message";

// Real React effects + groupMessages + SystemActivityCluster/SystemMessage.
// Only scroller scheduling and geometry are controlled: not a layout test.
const h = vi.hoisted(() => ({
  mount: true,
  duplicate: false,
  visible: true,
  scrollError: null as Error | null,
  props: null as any,
  scrollToKey: vi.fn(() => true),
  scrollToBottom: vi.fn(),
  renderContext: { liveChannels: [], archivedChannels: [] },
  authorAvatars: {},
  actionSurface: { rowActionProps: () => ({}) },
}));
vi.mock("@/navigation/layout", () => ({ useCompactLayout: () => true }));
vi.mock("@/navigation/view-memory", () => ({ useViewMemory: () => null }));
vi.mock("@/features/messages/hooks/use-message-render-context", () => ({
  useMessageRenderContext: () => h.renderContext,
}));
vi.mock("@/features/messages/hooks/author-avatar-hooks", () => ({
  useAuthorAvatarObjectUrls: () => h.authorAvatars,
}));
vi.mock("@/features/messages/hooks/use-message-action-surface", () => ({
  useMessageActionSurface: () => h.actionSurface,
}));
vi.mock("@/features/messages/components/message-action-chrome", () => ({
  MessageActionChrome: () => null,
}));
vi.mock("@/features/messages/components/native-composer-room", () => ({
  NativeComposerRoom: () => null,
}));
vi.mock("@/features/messages/components/channel-message-item", () => ({
  ChannelMessageItem: ({ message, jumpFlash }: any) =>
    React.createElement("div", {
      id: `msg-${message.id}`,
      className: jumpFlash ? "msg-jump-flash" : "",
    }),
}));
vi.mock("./message-scroller", async () => {
  const R = await import("react");
  return {
    MessageScroller: (props: any) => {
      h.props = props;
      R.useImperativeHandle(props.controlRef, () => ({
        scrollToKey: h.scrollToKey,
        scrollToBottom: h.scrollToBottom,
      }));
      return R.createElement(
        "div",
        {},
        h.mount
          ? props.items.flatMap((item: any, index: number) =>
              Array.from({ length: h.duplicate ? 2 : 1 }, (_, copy) =>
                R.createElement("div", { key: `${index}:${copy}` }, props.renderItem(item)),
              ),
            )
          : null,
      );
    },
  };
});
import { MessageList } from "./message-list";

const event = (id: string, seq = 1): CachedMessage => ({
  id,
  conversation_id: "c",
  seq: decodeMessageSeq(seq),
  created_at: seq,
  from_kind: "system",
  from_agent_id: null,
  from_user_id: null,
  author: null,
  content: `event ${id}`,
  metadata: { subtype: "task_create" },
  attachments: null,
  thread_root_id: null,
  linked_task: null,
  reactions: null,
});
let root: Root,
  container: HTMLDivElement,
  callbacks: Map<number, FrameRequestCallback>,
  nextFrame: number;
let scroll: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>;
const defaults = {
  channelId: "c",
  workspaceId: "w",
  isLoading: false,
  hasMoreBefore: false,
  isFetchingEarlier: false,
  onLoadEarlier: () => {},
  agentAvatarUrls: new Map(),
  canReact: false,
  exportHeader: null,
  jumpToMessageId: "e",
  jumpAttemptId: 1,
};
async function render(messages: CachedMessage[], props = {}) {
  await act(async () =>
    root.render(React.createElement(MessageList, { ...defaults, messages, ...props })),
  );
}
async function frames(count = 1) {
  for (let i = 0; i < count; i++) {
    const pending = [...callbacks.values()];
    callbacks.clear();
    await act(async () => {
      pending.forEach((fn) => fn(i * 16));
    });
  }
}
const row = (id: string) =>
  container.querySelector<HTMLElement>(`[data-system-message-id="${id}"]`);
const state = () => container.querySelector<HTMLElement>("[data-message-list]")!.dataset;
beforeEach(() => {
  vi.useFakeTimers();
  h.mount = true;
  h.visible = true;
  h.duplicate = false;
  h.scrollError = null;
  h.scrollToKey.mockReset().mockReturnValue(true);
  h.scrollToBottom.mockClear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  callbacks = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    callbacks.set(++nextFrame, fn);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("innerWidth", 400);
  vi.stubGlobal("innerHeight", 500);
  scroll = vi.fn(() => {
    if (h.scrollError) throw h.scrollError;
  });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scroll);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const target = this.hasAttribute("data-system-message-id");
      const top = target ? (h.visible ? 100 : 700) : 0;
      return {
        left: 0,
        right: 400,
        top,
        bottom: top + (target ? 30 : 500),
        width: 400,
        height: target ? 30 : 500,
        x: 0,
        y: top,
        toJSON() {},
      };
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("system event jump lifecycle with controlled MessageScroller/geometry", () => {
  it("resolves a non-first cluster member and flashes only that real event", async () => {
    const done = vi.fn();
    await render([event("a"), event("e", 2), event("b", 3)], { onJumped: done });
    expect(h.props.items[0].kind).toBe("cluster");
    expect(h.props.initialAnchor).toEqual({
      kind: "key",
      key: h.props.itemKey(h.props.items[0]),
      align: "center",
    });
    await frames();
    expect(state().systemJumpState).toBe("located");
    expect(row("e")!.dataset.messageConversationId).toBe("c");
    expect(row("e")!.classList.contains("msg-jump-flash")).toBe(true);
    expect(row("a")!.classList.contains("msg-jump-flash")).toBe(false);
    expect(row("b")!.classList.contains("msg-jump-flash")).toBe(false);
    expect(done).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(3000));
    expect(done).toHaveBeenCalledOnce();
  });
  it("waits for the member to mount instead of accepting the cluster index", async () => {
    h.mount = false;
    const messages = [event("e")];
    const done = vi.fn();
    await render(messages, { onJumped: done });
    await frames(4);
    expect(state().systemJumpState).toBe("locating");
    expect(done).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
    h.mount = true;
    await render(messages, { onJumped: done });
    await frames();
    expect(state().systemJumpState).toBe("located");
  });
  it("does not treat successful scrolling as visible and retains the finite failure", async () => {
    h.visible = false;
    const done = vi.fn();
    await render([event("e")], { onJumped: done });
    await frames(60);
    expect(scroll).toHaveBeenCalledOnce();
    expect(state().systemJumpState).toBe("failed");
    expect(state().systemJumpError).toMatch(/did not become visible/);
    expect(row("e")!.classList.contains("msg-jump-flash")).toBe(false);
    expect(done).toHaveBeenCalledOnce();
  });
  it("retains the frame budget across prepend/regroup while not mounted", async () => {
    h.mount = false;
    const done = vi.fn();
    await render([event("e", 2)], { onJumped: done });
    await frames(30);
    await render([event("a"), event("e", 2)], { onJumped: done });
    await frames(30);
    expect(state().systemJumpState).toBe("failed");
    expect(done).toHaveBeenCalledOnce();
  });
  it("does not locate a missing ID, a duplicate ID, or a foreign conversation", async () => {
    const done = vi.fn();
    await render([event("other")], { onJumped: done });
    expect(done).toHaveBeenCalledOnce();
    h.duplicate = true;
    await render([event("e")], { onJumped: done, jumpAttemptId: 2 });
    await frames();
    expect(state().systemJumpError).toMatch(/Ambiguous/);
    expect(container.querySelectorAll(".msg-jump-flash")).toHaveLength(0);
    h.duplicate = false;
    await render([{ ...event("e"), conversation_id: "foreign" }], {
      onJumped: done,
      jumpAttemptId: 3,
    });
    await frames(60);
    expect(state().systemJumpState).toBe("failed");
    expect(scroll).not.toHaveBeenCalled();
  });
  it("preserves empty-cache waiting and releases a final nonempty-window miss after prime", async () => {
    const done = vi.fn();
    await render([], { onJumped: done, jumpPrimePending: true });
    expect(done).not.toHaveBeenCalled();
    await render([], { onJumped: done, jumpPrimePending: false });
    expect(done).not.toHaveBeenCalled();
    await render([event("other")], { onJumped: done, jumpPrimePending: false });
    expect(done).toHaveBeenCalledOnce();
    expect(container.querySelector(".msg-jump-flash")).toBeNull();
  });
  it("invalidates an old mount callback on same-ID new attempt and cancels the old flash timer", async () => {
    const messages = [event("e")],
      done = vi.fn();
    await render(messages, { onJumped: done });
    const oldFrame = [...callbacks.values()][0]!;
    await render(messages, { onJumped: done, jumpAttemptId: 2 });
    await act(async () => oldFrame(1));
    expect(scroll).not.toHaveBeenCalled();
    await frames();
    await act(async () => vi.advanceTimersByTime(2000));
    await render(messages, { onJumped: done, jumpAttemptId: 3 });
    await frames();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(done).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(2000));
    expect(done).toHaveBeenCalledOnce();
  });
  it("invalidates callbacks after target/channel change or cancellation", async () => {
    const messages = [event("e"), event("b", 2)],
      done = vi.fn();
    await render(messages, { onJumped: done });
    const stale = [...callbacks.values()][0]!;
    await render(messages, { onJumped: done, jumpToMessageId: "b", jumpAttemptId: 2 });
    await act(async () => stale(1));
    await frames();
    expect(row("b")!.classList.contains("msg-jump-flash")).toBe(true);
    expect(row("e")!.classList.contains("msg-jump-flash")).toBe(false);
    await render(messages, { onJumped: done, jumpToMessageId: null });
    await act(async () => vi.advanceTimersByTime(3000));
    expect(done).not.toHaveBeenCalled();
    await render(messages, { onJumped: done, channelId: "other", jumpAttemptId: 4 });
    await frames(60);
    expect(state().systemJumpState).toBe("failed");
  });
  it("keeps the scroll first error when control release also fails", async () => {
    h.scrollError = new Error("scroll-first");
    await render([event("e")], {
      onJumped: () => {
        throw new Error("release-second");
      },
    });
    await frames();
    expect(state().systemJumpState).toBe("failed");
    expect(state().systemJumpError).toBe("Error: scroll-first");
    expect(state().systemJumpSecondary).toContain("release-second");
    expect(container.querySelector(".msg-jump-flash")).toBeNull();
  });
  it("retains cleanup failure and does not retry the same attempt after rerender", async () => {
    h.mount = false;
    const messages = [event("e")],
      done = vi.fn();
    await render(messages, { onJumped: done });
    const stale = [...callbacks.values()][0]!;
    vi.stubGlobal("cancelAnimationFrame", () => {
      stale(1);
      throw new Error("cleanup-first");
    });
    await render([...messages], { onJumped: done });
    expect(state().systemJumpState).toBe("failed");
    expect(state().systemJumpError).toBe("Error: cleanup-first");
    h.mount = true;
    await render([...messages], { onJumped: done });
    await frames(2);
    expect(scroll).not.toHaveBeenCalled();
    expect(container.querySelector(".msg-jump-flash")).toBeNull();
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    await render(messages, { onJumped: done, jumpAttemptId: 2 });
    await frames();
    await act(async () => stale(2));
    expect(state().systemJumpState).toBe("located");
    expect(row("e")!.classList.contains("msg-jump-flash")).toBe(true);
    expect(done).not.toHaveBeenCalled();
  });
  it.each(["cluster", "standalone"] as const)(
    "updates %s flash on surface-only changes with stable hook dependencies",
    async (kind) => {
      const e = (id: string, seq: number) =>
        kind === "cluster" ? event(id, seq) : { ...event(id, seq), metadata: null };
      const messages = [e("a", 1), e("e", 2), e("b", 3)],
        done = vi.fn();
      // Same array, props, callbacks and hoisted hook results throughout the surface toggle.
      const hooks = [
        h.renderContext,
        h.authorAvatars,
        h.actionSurface,
        h.actionSurface.rowActionProps,
      ];
      await render(messages, { onJumped: done });
      await frames();
      expect(h.props.items[0].kind).toBe(kind === "cluster" ? "cluster" : "message");
      expect(row("e")!.classList.contains("msg-jump-flash")).toBe(true);
      await render(messages, { onJumped: done, surfaceActive: false });
      expect([
        h.renderContext,
        h.authorAvatars,
        h.actionSurface,
        h.actionSurface.rowActionProps,
      ]).toEqual(hooks);
      expect(container.querySelectorAll(".msg-jump-flash")).toHaveLength(0);
      await act(async () => vi.advanceTimersByTime(3000));
      expect(done).not.toHaveBeenCalled();
      await render(messages, { onJumped: done, surfaceActive: true });
      const oldFrame = [...callbacks.values()][0]!;
      await frames();
      expect(row("e")!.classList.contains("msg-jump-flash")).toBe(true);
      expect(row("a")!.classList.contains("msg-jump-flash")).toBe(false);
      expect(row("b")!.classList.contains("msg-jump-flash")).toBe(false);
      await render(messages, { onJumped: done, jumpToMessageId: null });
      await render(messages, { onJumped: done, jumpToMessageId: "b", jumpAttemptId: 2 });
      await act(async () => oldFrame(9));
      await frames();
      expect(state().systemJumpOwner).toBe(JSON.stringify(["c", "b", 2]));
      expect(row("b")!.classList.contains("msg-jump-flash")).toBe(true);
      expect(row("e")!.classList.contains("msg-jump-flash")).toBe(false);
      await act(async () => vi.advanceTimersByTime(2999));
      expect(done).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1));
      expect(done).toHaveBeenCalledOnce();
    },
  );
  it("scrolls the same ordinary row again for a new attempt without remounting the scroller", async () => {
    const messages = [{ ...event("e"), from_kind: "user" as const, metadata: null }];
    const done = vi.fn();
    await render(messages, { onJumped: done });
    expect(h.scrollToKey).toHaveBeenCalledExactlyOnceWith("e", "center");
    await render(messages, { onJumped: done, jumpAttemptId: 2 });
    expect(h.scrollToKey).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(3000));
    expect(done).toHaveBeenCalledOnce();
  });
  it("keeps day separators in the rendered scroller rows and hides an unknown leading day", async () => {
    const one = new Date(2026, 10, 15, 12).getTime();
    const two = new Date(2026, 10, 16, 12).getTime();
    const messages = [one, one + 1000, two].map((created_at, i) => ({
      ...event(String(i), i + 1),
      from_kind: "user" as const,
      metadata: null,
      created_at,
    }));
    await render(messages, { jumpToMessageId: null });
    expect(container.querySelectorAll("[data-day-separator]")).toHaveLength(2);
    await render(messages, { jumpToMessageId: null, hasMoreBefore: true });
    expect(container.querySelectorAll("[data-day-separator]")).toHaveLength(1);
  });
  it("waits for a published ordinary row before flashing or completing", async () => {
    const messages = [{ ...event("e"), from_kind: "user" as const, metadata: null }],
      done = vi.fn();
    h.scrollToKey.mockReturnValueOnce(false).mockReturnValue(true);
    await render(messages, { onJumped: done });
    expect(container.querySelector(".msg-jump-flash")).toBeNull();
    await act(async () => vi.advanceTimersByTime(3000));
    expect(done).not.toHaveBeenCalled();
    await frames();
    expect(h.scrollToKey).toHaveBeenCalledTimes(2);
    expect(container.querySelector("#msg-e")!.classList.contains("msg-jump-flash")).toBe(true);
    await act(async () => vi.advanceTimersByTime(2999));
    expect(done).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(done).toHaveBeenCalledOnce();
  });
  it("bounds an unpublished ordinary jump and retains its failure until a new attempt", async () => {
    const messages = [{ ...event("e"), from_kind: "user" as const, metadata: null }],
      done = vi.fn();
    h.scrollToKey.mockReturnValue(false);
    await render(messages, { onJumped: done });
    await frames(60);
    expect(state().messageJumpError).toMatch(/not published/);
    expect(container.querySelector(".msg-jump-flash")).toBeNull();
    expect(done).toHaveBeenCalledOnce();
    const tries = h.scrollToKey.mock.calls.length;
    await render([...messages], { onJumped: done });
    await frames();
    expect(h.scrollToKey).toHaveBeenCalledTimes(tries);
    h.scrollToKey.mockReturnValue(true);
    await render(messages, { onJumped: done, jumpAttemptId: 2 });
    expect(container.querySelector(".msg-jump-flash")).not.toBeNull();
  });
  it("invalidates delayed ordinary publication after cancellation, a new attempt or hiding", async () => {
    const messages = [{ ...event("e"), from_kind: "user" as const, metadata: null }],
      done = vi.fn();
    h.scrollToKey.mockReturnValue(false);
    await render(messages, { onJumped: done });
    const old = [...callbacks.values()][0]!;
    await render(messages, { onJumped: done, jumpAttemptId: 2 });
    const tries = h.scrollToKey.mock.calls.length;
    await act(async () => old(1));
    expect(h.scrollToKey).toHaveBeenCalledTimes(tries);
    const hidden = [...callbacks.values()].at(-1)!;
    await render(messages, { onJumped: done, surfaceActive: false });
    await act(async () => hidden(2));
    await render(messages, { onJumped: done, jumpToMessageId: null });
    await frames(60);
    await act(async () => vi.advanceTimersByTime(3000));
    expect(done).not.toHaveBeenCalled();
    expect(container.querySelector(".msg-jump-flash")).toBeNull();
  });
  it("does not complete a pending ordinary scroll after unmount", async () => {
    const messages = [{ ...event("e"), from_kind: "user" as const, metadata: null }],
      done = vi.fn();
    h.scrollToKey.mockReturnValue(false);
    await render(messages, { onJumped: done });
    const stale = [...callbacks.values()][0]!;
    await act(async () => root.unmount());
    root = createRoot(container);
    h.scrollToKey.mockReturnValue(true);
    await act(async () => stale(1));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(done).not.toHaveBeenCalled();
  });
  it("keeps the ordinary message flash path and suppresses hidden-surface completion", async () => {
    const ordinary = { ...event("e"), from_kind: "user" as const, metadata: null },
      done = vi.fn();
    await render([ordinary], { onJumped: done });
    expect(container.querySelector("#msg-e")!.classList.contains("msg-jump-flash")).toBe(true);
    expect(scroll).not.toHaveBeenCalled();
    await render([ordinary], { onJumped: done, surfaceActive: false });
    await act(async () => vi.advanceTimersByTime(3000));
    expect(done).not.toHaveBeenCalled();
  });
});
