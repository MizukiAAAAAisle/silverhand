// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientPlatform } from "@silverhand/client";
import type { MessageAlert, NotificationDto, ServerFrame } from "@silverhand/shared";
import { configurePlatform } from "@/platform";
import { useNotificationToasts } from "./notifications";
import {
  createAndroidNotifications,
  type AndroidNotificationBridge,
} from "../../../../../apps/android/src/notifications";
import { createAndroidNotices } from "../../../../../apps/android/src/notices";

const stream = vi.hoisted(() => ({
  receive: undefined as ((frame: ServerFrame) => void) | undefined,
}));
vi.mock("@/lib/ws-client", () => ({
  subscribeViewerScope: () => ({ unsubscribe() {} }),
  isCurrentViewerScope: (scope: string) => scope === "viewer:me",
  onWsFrame: (receive: (frame: ServerFrame) => void) => {
    stream.receive = receive;
    return () => {
      stream.receive = undefined;
    };
  },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const platformFixture = {} as ClientPlatform;
configurePlatform(platformFixture);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function row(overrides: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: "n",
    kind: "mention_self",
    user_id: "me",
    agent_id: null,
    workspace_id: "ws",
    conversation_id: "channel",
    message_id: "message",
    thread_root_id: "thread-root",
    source_workspace_id: null,
    source_conversation_id: null,
    source_message_id: null,
    payload: { trigger_name: "Sender", conversation_title: "Channel", mention_excerpt: "hello" },
    created_at: 1,
    read_at: null,
    sender: null,
    ...overrides,
  };
}
function alert(overrides: Partial<MessageAlert> = {}): MessageAlert {
  return {
    conversation_id: "channel",
    workspace_id: "ws",
    conversation_title: "Channel",
    message_id: "message",
    thread_root_id: "thread-root",
    reason: "mention",
    sender: null,
    excerpt: "hello",
    ...overrides,
  };
}
type Jump = Parameters<typeof useNotificationToasts>[1];
async function harness(
  initial: NotificationDto[] = [],
  firstRows?: Promise<NotificationDto[]>,
  retainedBridge?: AndroidNotificationBridge,
) {
  let rows = initial;
  let first = firstRows;
  let nativeClick!: () => void;
  let pending: Array<{ id: string; token: string }> = [];
  let reference: Promise<unknown> | undefined;
  let delayedClicks: Promise<{ clicks: Array<{ id: string; token: string }> }> | undefined;
  let serial = 0;
  const bridge: AndroidNotificationBridge = retainedBridge ?? {
    notificationSession: vi.fn(async () => ({ session: "session-a" })),
    notificationShow: vi.fn(async () => ({ status: "posted" })),
    notificationDismiss: vi.fn(async () => ({ status: "dismissed" })),
    notificationTakeClicks: vi.fn(async () => {
      const wait = delayedClicks;
      delayedClicks = undefined;
      if (wait) return await wait;
      const clicks = pending;
      pending = [];
      return { clicks };
    }),
    addListener: vi.fn(async (_event, receive) => {
      nativeClick = receive;
      return { remove: vi.fn(async () => {}) };
    }),
  };
  const request = vi.fn(async ({ path }: { path: string }) => {
    let body: unknown;
    if (path.startsWith("/api/notifications?")) {
      const wait = first;
      first = undefined;
      body = { notifications: wait ? await wait : rows };
    } else if (path.endsWith("/ref")) {
      body = reference ? await reference : { ref: { id: "channel", workspace_id: "ws" } };
    } else body = { marked: 1 };
    return { status: 200, bodyText: JSON.stringify(body) };
  });
  const notifications = createAndroidNotifications(bridge);
  const notices = createAndroidNotices();
  Object.assign(platformFixture, {
    client: { backendRequest: request },
    notifications: notifications.capability,
    banner: notices.banner,
    toast: notices.toast,
  });
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const viewing: { conversationId: string | null; threadRootId: string | null } = {
    conversationId: "other",
    threadRootId: null,
  };
  function Consumer({ jump }: { jump?: Jump }) {
    useNotificationToasts(viewing, jump);
    return null;
  }
  async function render(jump?: Jump) {
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: qc }, createElement(Consumer, { jump })),
      );
    });
  }
  async function settle(ms = 20) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
      else await new Promise((done) => setTimeout(done, ms));
    });
  }
  await render();
  await settle();
  return {
    bridge,
    notifications,
    request,
    notices,
    qc,
    focus,
    viewing,
    render,
    settle,
    async click(id: string, token = "click-" + ++serial) {
      await act(async () => {
        pending.push({ id, token });
        nativeClick();
      });
      await settle();
    },
    async publish(next: NotificationDto[]) {
      rows = next;
      await act(async () =>
        qc.setQueryData(["notifications", "list", { unread: true, toasts: true }], {
          notifications: next,
        }),
      );
      await settle();
    },
    async viewer(next: NotificationDto[]) {
      rows = next;
      await act(async () =>
        stream.receive!({
          type: "event",
          scope: "viewer:me",
          epoch: "e",
          seq: ++serial,
          kind: "notification",
          payload: {},
        } as ServerFrame),
      );
      await settle(130);
      await settle();
    },
    async alert(value: MessageAlert, scope = "viewer:me") {
      await act(async () =>
        stream.receive!({
          type: "event",
          scope,
          epoch: "e",
          seq: ++serial,
          kind: "message_alert",
          payload: value,
        } as ServerFrame),
      );
      await settle();
    },
    async readConversation(conversationId: string) {
      await act(async () =>
        stream.receive!({
          type: "event",
          scope: "viewer:me",
          epoch: "e",
          seq: ++serial,
          kind: "unread_updated",
          payload: {
            conversation_id: conversationId,
            workspace_id: "ws",
            conversation_unread_count: 0,
            workspace_unread_count: 0,
            latest_unread: null,
          },
        } as ServerFrame),
      );
      await settle();
    },
    blockClickDelivery(value: Promise<{ clicks: Array<{ id: string; token: string }> }>) {
      delayedClicks = value;
    },
    blockReference(value: Promise<unknown>) {
      reference = value;
    },
    async close() {
      await act(async () => root.unmount());
      notifications.dispose();
      notices.dispose();
      qc.clear();
      host.remove();
    },
  };
}

it("keeps an early click until its list row arrives and permits a later independent same-ID click", async () => {
  const list = deferred<NotificationDto[]>();
  const h = await harness([], list.promise);
  const jump = vi.fn();
  try {
    await h.render(jump);
    await h.click("n");
    expect(jump).not.toHaveBeenCalled();
    await act(async () => list.resolve([row()]));
    await h.settle();
    expect(jump).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws",
      channelId: "channel",
      threadRootId: "thread-root",
      messageId: "message",
    });
    await h.click("n");
    expect(jump).toHaveBeenCalledTimes(2); // New native token means a new user operation.
  } finally {
    await h.close();
  }
});

it("waits for navigation and permits banner then system notification as independent same-ID clicks", async () => {
  const h = await harness([row()]);
  const jump = vi.fn();
  try {
    await h.click("n");
    expect(jump).not.toHaveBeenCalled();
    await h.render(jump);
    await h.settle();
    expect(jump).toHaveBeenCalledOnce();
    await h.alert(alert({ message_id: "banner-message" }));
    const banner = document.querySelector<HTMLButtonElement>(
      ".android-notice-banner .android-notice-content",
    )!;
    await act(async () => banner.click());
    await h.settle();
    expect(jump).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: "banner-message" }));
    await h.click("alert:banner-message");
    expect(jump).toHaveBeenCalledTimes(3);
    expect(jump).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: "banner-message" }));
  } finally {
    await h.close();
  }
});

it("deduplicates repeated delivery while target resolution is pending, using the current handler", async () => {
  const h = await harness([row({ thread_root_id: null })]);
  const ref = deferred<unknown>();
  const oldJump = vi.fn();
  const newJump = vi.fn();
  h.blockReference(ref.promise);
  try {
    await h.render(oldJump);
    await h.click("n");
    await h.click("n");
    expect(h.request.mock.calls.filter(([v]) => v.path.endsWith("/ref"))).toHaveLength(1);
    await h.render(newJump);
    await act(async () => ref.resolve({ ref: { id: "channel", workspace_id: "ws" } }));
    await h.settle();
    expect(oldJump).not.toHaveBeenCalled();
    expect(newJump).toHaveBeenCalledOnce();
  } finally {
    await h.close();
  }
});

it("cannot navigate an old owner after unmount/account replacement during async resolution", async () => {
  const h = await harness([row({ thread_root_id: null })]);
  const ref = deferred<unknown>();
  const jump = vi.fn();
  h.blockReference(ref.promise);
  await h.render(jump);
  await h.click("n");
  await h.close();
  await act(async () => ref.resolve({ ref: { id: "channel", workspace_id: "ws" } }));
  await h.settle();
  expect(jump).not.toHaveBeenCalled();
});

it("expires unmatched clicks and terminates a row with no meaningful destination", async () => {
  vi.useFakeTimers();
  const h = await harness();
  const jump = vi.fn();
  try {
    await h.render(jump);
    await h.click("missing");
    await h.settle(10_001);
    await h.publish([row({ id: "missing" }), row({ id: "invalid", message_id: null })]);
    expect(jump).not.toHaveBeenCalled();
    await h.click("invalid");
    await h.settle(10_001);
    expect(jump).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it("delivers all three kinds through the real shared hook, preserves banner/toast and exact read-id clearing", async () => {
  const h = await harness();
  const failed = row({
    id: "failed",
    kind: "agent_start_failed",
    message_id: null,
    thread_root_id: null,
    agent_id: "agent",
    payload: { agent_name: "Agent", error: "runtime unavailable" },
  });
  try {
    await h.viewer([
      row({ id: "self" }),
      row({ id: "external", kind: "mention_external" }),
      failed,
    ]);
    expect(h.bridge.notificationShow).toHaveBeenCalledTimes(2); // Rows still feed Activity; self mentions alert only via message_alert.
    await h.alert(alert());
    expect(h.bridge.notificationShow).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(h.bridge.notificationShow).mock.calls.map(([v]) => v);
    expect(calls[0]).toEqual(expect.objectContaining({ notificationId: "external" }));
    expect(calls[0]?.force).not.toBe(true); // Upstream omits force for non-urgent rows.
    expect(calls[1]).not.toHaveProperty("notificationId");
    expect(calls[2]).toEqual(
      expect.objectContaining({ notificationId: "alert:message", force: true }),
    );
    expect(document.querySelector<HTMLElement>(".android-notice-banner")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>(".android-notice-toast")!.hidden).toBe(false);
    await h.viewer([
      row({ id: "self" }),
      row({ id: "external", kind: "mention_external" }),
      { ...failed, created_at: 2 },
    ]);
    expect(h.bridge.notificationShow).toHaveBeenCalledTimes(4);
    await act(async () =>
      stream.receive!({
        type: "event",
        scope: "viewer:me",
        kind: "unread_updated",
        payload: { dismissed_notification_ids: ["alert:message", 7, "external"] },
      } as unknown as ServerFrame),
    );
    await h.settle();
    expect(h.bridge.notificationDismiss).toHaveBeenCalledWith({
      session: "session-a",
      ids: ["alert:message", "external"],
    });
  } finally {
    await h.close();
  }
});

it("surfaces an unread start failure on first load without replaying the initial mentions", async () => {
  const h = await harness([
    row(),
    row({
      id: "error",
      kind: "agent_start_failed",
      message_id: null,
      payload: { agent_name: "Agent" },
    }),
  ]);
  try {
    expect(h.bridge.notificationShow).toHaveBeenCalledOnce();
    expect(vi.mocked(h.bridge.notificationShow).mock.calls[0]![0]).not.toHaveProperty(
      "notificationId",
    );
  } finally {
    await h.close();
  }
});

it("keeps focused matching conversations silent without turning that rule into a scroll-visibility test", async () => {
  const h = await harness();
  try {
    h.focus.mockReturnValue(true);
    h.viewing.conversationId = "channel";
    h.viewing.threadRootId = "thread-root";
    await h.viewer([row()]);
    await h.alert(alert());
    expect(h.bridge.notificationShow).not.toHaveBeenCalled();
    expect(document.querySelector(".android-notice-banner:not([hidden])")).toBeNull();
  } finally {
    await h.close();
  }
});

it.each(["success", "failure"] as const)(
  "does not let expired resolver %s consume or clear a newer same-ID click",
  async (outcome) => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await harness([row({ thread_root_id: null })]);
    const reference = deferred<unknown>();
    // Resolve the query dependency directly here: normal HTTP/query failures are
    // intentionally converted to a fallback target by the unchanged resolver.
    // A malformed cached ref exercises its unexpected-error cleanup separately.
    vi.spyOn(h.qc, "fetchQuery").mockImplementationOnce(() => reference.promise as never);
    const jump = vi.fn();
    try {
      await h.render(jump);
      await h.click("n");
      await h.settle(10_001);
      await h.render(undefined);
      // A business notification keeps its source coordinates. The later click is
      // a new delivery of that same ID, not a fabricated replacement message row.
      await h.click("n");
      await act(async () =>
        reference.resolve({
          ref: outcome === "failure" ? null : { id: "old-channel", workspace_id: "ws" },
        }),
      );
      await h.settle();
      if (outcome === "failure")
        expect(error).toHaveBeenCalledWith(
          "Unable to resolve notification click",
          expect.any(Error),
        );
      else expect(error).not.toHaveBeenCalled();
      await h.render(jump);
      await h.settle();
      expect(jump).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ channelId: "channel", messageId: "message" }),
      );
    } finally {
      await h.close();
    }
  },
);

it("resolves an early alert click without a list row, then clears that same alert id on read", async () => {
  const h = await harness();
  const jump = vi.fn();
  try {
    await h.click("alert:message");
    await h.alert(alert()); // Native click can precede the JS alert callback/navigation readiness.
    expect(jump).not.toHaveBeenCalled();
    await h.render(jump);
    await h.settle();
    expect(jump).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws",
      channelId: "channel",
      threadRootId: "thread-root",
      messageId: "message",
    });
    expect(h.request.mock.calls.some(([v]) => v.path.endsWith("/ref"))).toBe(false);
    await h.alert(alert({ conversation_id: "other-channel", message_id: "other-message" }));
    await h.readConversation("channel");
    expect(h.bridge.notificationDismiss).toHaveBeenCalledWith({
      session: "session-a",
      ids: ["alert:message"],
    });
    expect(h.bridge.notificationDismiss).not.toHaveBeenCalledWith({
      session: "session-a",
      ids: ["alert:other-message"],
    });
    await h.click("alert:message");
    await h.settle();
    expect(jump).toHaveBeenCalledOnce(); // Read dismissed the alert's click index as well.
  } finally {
    await h.close();
  }
});

it("opens a displayed alert once before its row refresh, and ignores delayed readiness after owner unmount", async () => {
  const list = deferred<NotificationDto[]>();
  const h = await harness([], list.promise);
  const jump = vi.fn();
  let closed = false;
  try {
    await h.alert(alert());
    await h.click("alert:message", "one-physical-click");
    await h.click("alert:message", "one-physical-click"); // Repeated native delivery token, same user operation.
    await h.render(jump);
    await h.settle();
    expect(jump).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channelId: "channel", messageId: "message" }),
    );
    h.viewing.conversationId = "next";
    await h.render(undefined);
    const late = deferred<{ clicks: Array<{ id: string; token: string }> }>();
    h.blockClickDelivery(late.promise);
    await h.click("alert:message", "late-old-owner");
    await h.close();
    closed = true;
    await act(async () => {
      list.resolve([row()]);
      late.resolve({ clicks: [{ id: "alert:message", token: "late-old-owner" }] });
    });
    await h.settle();
    expect(jump).toHaveBeenCalledOnce();
    const replacement = await harness();
    const newJump = vi.fn();
    try {
      await replacement.render(newJump);
      await replacement.settle();
      expect(newJump).not.toHaveBeenCalled();
    } finally {
      await replacement.close();
    }
  } finally {
    if (!closed) await h.close();
  }
});

it("rejects another viewer scope and keeps ambient alerts non-urgent without a banner", async () => {
  const h = await harness();
  try {
    await h.alert(alert(), "viewer:other");
    expect(h.bridge.notificationShow).not.toHaveBeenCalled();
    await h.alert(alert({ reason: "ambient" }));
    expect(h.bridge.notificationShow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ notificationId: "alert:message", force: false }),
    );
    expect(document.querySelector(".android-notice-banner:not([hidden])")).toBeNull();
  } finally {
    await h.close();
  }
});

it.each(["mention", "direct"] as const)(
  "alerts a private line %s even when another conversation has focus",
  async (reason) => {
    const h = await harness();
    const jump = vi.fn();
    try {
      h.focus.mockReturnValue(true);
      await h.render(jump);
      await h.alert(
        alert({
          conversation_id: "direct-line",
          conversation_title: null,
          thread_root_id: null,
          reason,
        }),
      );
      expect(h.bridge.notificationShow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          notificationId: "alert:message",
          groupId: "direct-line",
          force: true,
        }),
      );
      const banner = document.querySelector<HTMLButtonElement>(
        ".android-notice-banner .android-notice-content",
      )!;
      await act(async () => banner.click());
      await h.settle();
      expect(jump).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "ws",
        channelId: "direct-line",
        threadRootId: null,
        messageId: "message",
      });
    } finally {
      await h.close();
    }
  },
);

it.each([
  { workspaceId: null, threadRootId: null, channelId: "dm" },
  { workspaceId: "workspace", threadRootId: "thread", channelId: "channel" },
])(
  "restores a retained native ticket into a new JS owner without a row or WS replay ($channelId)",
  async (coords) => {
    // Native process lifetime is separate from both JS owner lifetimes. Java controls
    // exercise the actual Ticket owner; this bridge fixture only models that boundary.
    type Target = NonNullable<
      Parameters<AndroidNotificationBridge["notificationShow"]>[0]["clickTarget"]
    >;
    let receive: () => void = () => {};
    let token = 0;
    const tickets = new Map<string, { id: string; token: string; clickTarget?: Target }>();
    let pending: Array<{ id: string; token: string; clickTarget?: Target }> = [];
    const bridge: AndroidNotificationBridge = {
      notificationSession: vi.fn(async () => ({ session: "same-login" })),
      notificationShow: vi.fn(async (input) => {
        if (input.notificationId)
          tickets.set(input.notificationId, {
            id: input.notificationId,
            token: String(++token),
            clickTarget: input.clickTarget,
          });
        return { status: "posted" };
      }),
      notificationDismiss: vi.fn(async () => ({ status: "dismissed" })),
      notificationTakeClicks: vi.fn(async () => {
        const batch = pending;
        pending = [];
        return { clicks: batch };
      }),
      addListener: vi.fn(async (_event, fn) => {
        receive = fn;
        return {
          remove: async () => {
            if (receive === fn) receive = () => {};
          },
        };
      }),
    };
    const old = await harness([], undefined, bridge);
    const oldJump = vi.fn();
    await old.render(oldJump);
    await old.alert(
      alert({
        conversation_id: coords.channelId,
        workspace_id: coords.workspaceId,
        thread_root_id: coords.threadRootId,
        reason: "direct",
      }),
    );
    const ticket = tickets.get("alert:message")!;
    expect(ticket.clickTarget).toEqual({ ...coords, messageId: "message" });
    await old.close(); // Only JS is rebuilt, not the process notification session/ticket.
    const next = await harness([], undefined, bridge);
    const jump = vi.fn();
    try {
      tickets.delete(ticket.id);
      pending.push(ticket);
      receive();
      await next.settle();
      expect(jump).not.toHaveBeenCalled();
      await next.render(jump);
      await next.settle();
      expect(jump).toHaveBeenCalledExactlyOnceWith({
        ...coords,
        workspaceId: coords.workspaceId ?? undefined,
        messageId: "message",
      });
      pending.push(ticket);
      receive();
      await next.settle();
      expect(jump).toHaveBeenCalledOnce();
      expect(oldJump).not.toHaveBeenCalled();
      expect(next.request.mock.calls.some(([v]) => v.path.endsWith("/ref"))).toBe(false);
    } finally {
      await next.close();
    }
  },
);
