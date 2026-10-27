// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { ClientPlatform } from "@silverhand/client";
import type { NotificationDto, ServerFrame } from "@silverhand/shared";
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
function mentionRow(overrides: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: "old",
    kind: "mention_self",
    user_id: "u-me",
    agent_id: null,
    workspace_id: "ws-1",
    conversation_id: "channel",
    message_id: "old-message",
    thread_root_id: null,
    source_workspace_id: null,
    source_conversation_id: null,
    source_message_id: null,
    payload: null,
    read_at: 10,
    created_at: 1,
    sender: null,
    ...overrides,
  };
}

const readMention = mentionRow();

// Contract replaced 2026-10-27: upstream 258d8093 only alerts on rows that are
// still unread. The previous "live, already-read mention" strategy belonged to
// the superseded local surface, so a read row must now stay silent.
it.each([
  { focused: true, conversation: "channel" },
  { focused: false, conversation: "channel" },
  { focused: true, conversation: "other" },
  { focused: true, conversation: null },
])(
  "stays silent for an already-read mention (focused=$focused, conversation=$conversation)",
  async ({ focused, conversation }) => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
    const historyCount = toast.getHistory().length;
    let rows = [readMention];
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
      emit(1);
      await settle();
      expect(show).not.toHaveBeenCalled();
      expect(toast.getHistory()).toHaveLength(historyCount);
    } finally {
      await act(async () => root.unmount());
      qc.clear();
      focus.mockRestore();
    }
  },
);

it("notifies once for a genuinely unread mention delivered by the viewer stream", async () => {
  const unread = mentionRow({ id: "new", message_id: "new-message", read_at: null });
  let rows: NotificationDto[] = [];
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
    useNotificationToasts(null);
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
  try {
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(Consumer))),
    );
    await settle();
    expect(show).not.toHaveBeenCalled();
    rows = [unread];
    stream.listener!({
      type: "event",
      scope: "viewer:me",
      epoch: "one",
      seq: 1,
      kind: "notification",
      payload: { kind: "mention_self", conversation_id: "channel", message_id: "new-message" },
    } as ServerFrame);
    await settle();
    expect(show).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ force: true, notificationId: "new" }),
    );
  } finally {
    await act(async () => root.unmount());
    qc.clear();
  }
});
