// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { ClientPlatform } from "@silverhand/client";
import type { ServerFrame } from "@silverhand/shared";
import { toast } from "sonner";
import { configurePlatform } from "@/platform";
import { useNotificationToasts } from "./notifications";
const stream = vi.hoisted(() => ({
  listener: undefined as ((frame: ServerFrame) => void) | undefined,
}));
vi.mock("@/lib/ws-client", () => ({
  subscribeViewerScope: () => ({ unsubscribe() {} }),
  isCurrentViewerScope: (scope: string) => scope === "viewer:me",
  onWsFrame: (listener: (frame: ServerFrame) => void) => {
    stream.listener = listener;
    return () => {
      stream.listener = undefined;
    };
  },
}));
const show = vi.fn(async () => {});
const request = vi.fn<(input: { path: string }) => Promise<{ status: number; bodyText: string }>>();
configurePlatform({
  client: { backendRequest: request },
  notificationSounds: {},
  notifications: {
    showSystemNotification: show,
    onNotificationClicked: () => () => {},
    dismissSystemNotifications: async () => {},
  },
} as unknown as ClientPlatform);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.each([
  { focused: true, conversation: "channel", current: true, toasts: 0 },
  { focused: false, conversation: "channel", current: true, toasts: 0 },
  { focused: true, conversation: "other", current: false, toasts: 1 },
  { focused: true, conversation: null, current: false, toasts: 1 },
])(
  "delivers a live, already-read mention once (focused=$focused, conversation=$conversation)",
  async ({ focused, conversation, current, toasts }) => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
    const historyCount = toast.getHistory().length;
    const historic = {
      id: "old",
      kind: "mention_self",
      conversation_id: "channel",
      message_id: "old-message",
      read_at: 10,
      payload: null,
    };
    let rows = [historic];
    show.mockClear();
    request.mockImplementation(async ({ path }) => ({
      status: 200,
      bodyText: JSON.stringify({
        notifications: path.includes("unread=1") ? rows.filter((n) => n.read_at === null) : rows,
      }),
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    const root = createRoot(host);
    function Consumer() {
      useNotificationToasts(conversation);
      return null;
    }
    const settle = async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 160));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    };
    const emit = (seq: number) =>
      stream.listener!({
        type: "event",
        scope: "viewer:me",
        epoch: "one",
        seq,
        kind: "notification",
        payload: { kind: "mention_self", conversation_id: "channel", message_id: "new-message" },
      } as ServerFrame);
    try {
      await act(async () =>
        root.render(createElement(QueryClientProvider, { client: qc }, createElement(Consumer))),
      );
      await settle();
      expect(show).not.toHaveBeenCalled();
      rows = [...rows, { ...historic, id: "offline", message_id: "offline-message" }];
      stream.listener!({
        type: "snapshot_required",
        scope: "viewer:me",
        epoch: "two",
      } as ServerFrame);
      await settle();
      expect(show).not.toHaveBeenCalled();
      rows = [...rows, { ...historic, id: "new", message_id: "new-message", read_at: 1007 }];
      // A normal cache refresh may see the row before its WS invalidation.
      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["notifications", "list"] });
      });
      await settle();
      expect(show).not.toHaveBeenCalled();
      emit(1);
      await settle();
      expect(show).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          force: true,
          currentConversation: current,
          notificationId: "new",
        }),
      );
      expect(toast.getHistory()).toHaveLength(historyCount + toasts);
      emit(2);
      await settle();
      expect(show).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      qc.clear();
      focus.mockRestore();
    }
  },
);
