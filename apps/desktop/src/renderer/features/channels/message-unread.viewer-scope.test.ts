import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  decodeTransportEpoch,
  decodeTransportSeq,
  decodeMessageSeq,
  type ServerFrame,
  type ConversationStreamUnreadDto,
} from "@silverhand/shared";
import { api } from "@/lib/api";
import { conversationUnreadKey, useConversationUnread } from "./message-unread";
import { channelThreadsKey, channelThreadsUnreadKey } from "./use-channel-threads";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// #task:1773 — freshness seam for the header dot + the `followed ∩ unread`
// Threads dataset. Both read the SAME viewer-scoped signal: the header dot
// boolean rides `useConversationUnread`'s DTO, and the filtered list is a
// SEPARATE HTTP read over the same server predicate. They are two independent
// reads that converge from one invalidation source — never derived from each
// other. So `useConversationUnread` must, on a viewer-scope reconcile or a
// matching `unread_updated`, refetch the filtered sibling ALONGSIDE the unread
// read-model. Two membership-changing events reach only this viewer signal (no
// conversation message frame carries them): a remote observe clearing a followed
// thread's unread, and this viewer follow/unfollowing on another device (backend
// publishes `unread_updated` on a real follow change).
//
// The dual invariant this fence locks:
//   1. a viewer unread signal invalidates the filtered dataset
//      (`channelThreadsUnreadKey`) on BOTH branches (snapshot + unread_updated);
//   2. it NEVER invalidates the exact All key (`channelThreadsKey`) — the All
//      list's membership + order are unread- AND follow-agnostic
//      (`lr.created_at DESC, root.seq DESC`), so a per-viewer unread change must
//      not refetch it (that would defeat the S1 in-place merge). The All list is
//      refreshed only by the message-path ingestor / a follow toggle's own
//      HTTP-success invalidate — never from here.
//
// Desktop test env is `node` (no jsdom/RTL), so — like the sibling viewer-scope
// fences — this asserts the source structure rather than rendering the hook.

describe("useConversationUnread converges the followed∩unread dataset, not the All list", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./message-unread.ts", import.meta.url)),
    "utf8",
  );

  it("gates the signal on the current viewer scope", () => {
    expect(source).toContain("subscribeViewerScope()");
    expect(source).toContain("isCurrentViewerScope(frame.scope)");
  });

  it("invalidates the filtered Unread dataset on BOTH the snapshot and unread_updated branches", () => {
    // The import binding is `channelThreadsUnreadKey` (no arg); the two call
    // sites are `channelThreadsUnreadKey(conversationId)`. Exactly two ⇒ both
    // branches refetch the filtered sibling.
    const calls = source.split("channelThreadsUnreadKey(conversationId)").length - 1;
    expect(calls).toBe(2);
  });

  it("never invalidates the follow-agnostic All threads list from a viewer unread signal", () => {
    // The exact All key must not be touched here — this module doesn't even
    // import it. A viewer unread/follow change is not an All-list membership or
    // order change.
    expect(source).not.toContain("channelThreadsKey(");
  });
});

// Run the hook's production effect and query options with real query observers;
// only the React lifecycle, event source and HTTP boundary are supplied here.
const harness = vi.hoisted(() => ({
  client: null as unknown as QueryClient,
  listeners: new Set<(frame: ServerFrame) => void>(),
  cleanup: [] as (() => void)[],
  releases: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => (() => void) | void) => {
    const cleanup = effect();
    if (cleanup) harness.cleanup.push(cleanup);
  },
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
vi.mock("@/lib/ws-client", async (original) => ({
  ...(await original<typeof import("@/lib/ws-client")>()),
  subscribeViewerScope: () => ({ unsubscribe: harness.releases }),
  isCurrentViewerScope: (scope: string) => scope === "viewer:human",
  onWsFrame: (listener: (frame: ServerFrame) => void) => {
    harness.listeners.add(listener);
    return () => harness.listeners.delete(listener);
  },
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => harness.client,
  useQuery: (options: ConstructorParameters<typeof QueryObserver>[1]) =>
    new QueryObserver(harness.client, options),
}));
const snapshot = (count: number): ConversationStreamUnreadDto => ({
  mainline: { unread_count: 0, first_unread_message_id: null, first_unread_seq: null },
  threads: count
    ? {
        root: {
          unread_count: count,
          first_unread_message_id: "reply",
          first_unread_seq: decodeMessageSeq(7),
        },
      }
    : {},
  followed_thread_unread: false,
});
function emit(conversationId: string, kind = "direct_pairs_changed", scope = "viewer:human"): void {
  const frame: ServerFrame = {
    type: "event",
    kind,
    scope,
    epoch: decodeTransportEpoch("e"),
    seq: decodeTransportSeq(1),
    payload: { conversation_id: conversationId },
  };
  harness.listeners.forEach((listener) => listener(frame));
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
});
afterEach(() => {
  harness.cleanup.splice(0).forEach((cleanup) => cleanup());
  harness.listeners.clear();
  harness.client.clear();
});
function observe(id: string): QueryObserver<ConversationStreamUnreadDto> {
  const observer = useConversationUnread(
    id,
  ) as unknown as QueryObserver<ConversationStreamUnreadDto>;
  harness.cleanup.push(observer.subscribe(() => {}));
  return observer;
}
describe("DM stream unread consumes viewer invalidation through the production hook", () => {
  it("rereads only the matching DM, including repeat events and unsubscribe", async () => {
    let current = snapshot(0);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/api/conversations/dm-a/unread" ? current : snapshot(0),
    );
    const a = observe("dm-a"),
      b = observe("dm-b"),
      channel = observe("channel");
    await Promise.all([a.refetch(), b.refetch(), channel.refetch()]);
    vi.mocked(api).mockClear();
    const childKey = [...conversationUnreadKey("dm-a"), "unrelated"];
    harness.client.setQueryData(childKey, "kept");
    current = snapshot(1);
    emit("dm-a", "direct_pairs_changed", "viewer:other");
    emit("dm-a", "message", "conversation:dm-a");
    expect(api).not.toHaveBeenCalled();
    expect(a.getCurrentResult().data?.threads).toEqual({});
    emit("dm-a");
    await vi.waitFor(() => expect(a.getCurrentResult().data?.threads.root?.unread_count).toBe(1));
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual([
      "/api/conversations/dm-a/unread",
    ]);
    expect(harness.client.getQueryState(childKey)?.isInvalidated).toBe(false);
    expect(b.getCurrentResult().data?.threads).toEqual({});
    expect(channel.getCurrentResult().data?.threads).toEqual({});
    emit("dm-a");
    await vi.waitFor(() => expect(a.getCurrentResult().fetchStatus).toBe("idle"));
    expect(a.getCurrentResult().data).toEqual(snapshot(1));
    harness.cleanup.splice(0).forEach((cleanup) => cleanup());
    vi.mocked(api).mockClear();
    emit("dm-a");
    expect(api).not.toHaveBeenCalled();
    expect(harness.releases).toHaveBeenCalledTimes(3);
  });
  it("retains workspace unread and viewer snapshot convergence without refreshing All threads", async () => {
    let current = snapshot(0);
    vi.mocked(api).mockImplementation(async () => current);
    const observer = observe("channel");
    await observer.refetch();
    harness.client.setQueryData(channelThreadsKey("channel"), []);
    harness.client.setQueryData(channelThreadsUnreadKey("channel"), []);
    current = snapshot(2);
    emit("channel", "unread_updated");
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.threads.root?.unread_count).toBe(2),
    );
    expect(harness.client.getQueryState(channelThreadsUnreadKey("channel"))?.isInvalidated).toBe(
      true,
    );
    expect(harness.client.getQueryState(channelThreadsKey("channel"))?.isInvalidated).toBe(false);
    current = snapshot(0);
    harness.listeners.forEach((listener) =>
      listener({
        type: "snapshot_required",
        scope: "viewer:human",
        reason: "gap_too_large",
        epoch: decodeTransportEpoch("e"),
        currentSeq: decodeTransportSeq(2),
      }),
    );
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.threads).toEqual({}));
    expect(harness.client.getQueryData(conversationUnreadKey("channel"))).toEqual(snapshot(0));
  });
});
