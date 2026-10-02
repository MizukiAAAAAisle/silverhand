import { beforeEach, describe, expect, it, vi } from "vitest";

// A parent-render probe: effects intentionally do NOT run before child props
// are inspected. Prepend bookkeeping in a layout effect would fail this test.
// Actual Virtuoso measurement/scrolling is verified separately in WebKit.
const h = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, retry: false, compact: true }));
vi.mock("react", async (load) => {
  const react = await load<typeof import("react")>();
  const useState = (initial: unknown) => {
    const slot = h.cursor++;
    if (!(slot in h.slots)) h.slots[slot] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[slot],
      (action: unknown) => {
        const next = typeof action === "function" ? action(h.slots[slot]) : action;
        if (!Object.is(next, h.slots[slot])) {
          h.slots[slot] = next;
          h.retry = true;
        }
      },
    ];
  };
  const useMemo = (fn: () => unknown, deps: unknown[]) => {
    const slot = h.cursor++;
    const previous = h.slots[slot] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      h.slots[slot] = { deps, value: fn() };
    }
    return (h.slots[slot] as { value: unknown }).value;
  };
  return {
    ...react,
    useState,
    useReducer: (reducer: (s: unknown, e: unknown) => unknown, initial: unknown) => {
      const [state, set] = useState(initial);
      return [state, (event: unknown) => (set as Function)((s: unknown) => reducer(s, event))];
    },
    useRef: (initial: unknown) => useState(() => ({ current: initial }))[0],
    useMemo,
    useCallback: (fn: unknown, deps: unknown[]) => useMemo(() => fn, deps),
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
});
vi.mock("@/navigation/layout", () => ({ useCompactLayout: () => h.compact }));
vi.mock("@/navigation/view-memory", () => ({ useViewMemory: () => null }));
vi.mock("@/features/messages/hooks/use-message-render-context", () => ({
  useMessageRenderContext: () => ({ liveChannels: [], archivedChannels: [] }),
}));
vi.mock("@/features/messages/hooks/author-avatar-hooks", () => ({
  useAuthorAvatarObjectUrls: () => ({}),
}));
vi.mock("@/features/messages/hooks/use-message-action-surface", () => ({
  useMessageActionSurface: () => ({}),
}));
vi.mock("@/features/messages/components/message-action-chrome", () => ({
  MessageActionChrome: () => null,
}));
vi.mock("@/features/messages/components/channel-message-item", () => ({
  ChannelMessageItem: () => null,
}));
vi.mock("@/features/messages/components/system-message", () => ({ SystemMessage: () => null }));
vi.mock("@/features/messages/components/system-activity-cluster", () => ({
  SystemActivityCluster: () => null,
}));
vi.mock("@/features/conversation-shell/components/conversation-view-skeleton", () => ({
  MessageRowsSkeleton: () => null,
}));
vi.mock("react-virtuoso", () => ({ Virtuoso: () => null }));
import { Virtuoso } from "react-virtuoso";
import { MessageList } from "./message-list";
import type { CachedMessage } from "@/features/channels/pending-message";
import { decodeMessageSeq } from "@silverhand/shared";

const rows = (start: number, count: number): CachedMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${start + i}`,
    from_kind: "user",
    author: null,
    created_at: start + i,
    seq: decodeMessageSeq(start + i),
    conversation_id: "a",
    from_agent_id: null,
    from_user_id: "u",
    content: "message",
    metadata: null,
    attachments: null,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
  }));
const base = {
  channelId: "a",
  workspaceId: null,
  isLoading: false,
  hasMoreBefore: true,
  isFetchingEarlier: false,
  onLoadEarlier: vi.fn(),
  agentAvatarUrls: new Map(),
  jumpToMessageId: null,
  canReact: false,
};
function find(node: any): any {
  if (!node || typeof node !== "object") return;
  if (node.type === Virtuoso) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child);
    if (found) return found;
  }
}
function render(messages: CachedMessage[], overrides = {}) {
  let node;
  let attempts = 0;
  do {
    if (++attempts > 10) throw new Error("render loop");
    h.cursor = 0;
    h.retry = false;
    node = MessageList({ ...base, messages, ...overrides });
  } while (h.retry);
  return find(node);
}
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  h.retry = false;
  h.compact = true;
});
describe("message window publication", () => {
  it("measures compact rows without an extra frame while retaining desktop scheduling", () => {
    const messages = rows(100, 60);
    expect(render(messages).props.skipAnimationFrameInResizeObserver).toBe(true);
    h.compact = false;
    expect(render(messages).props.skipAnimationFrameInResizeObserver).toBe(false);
  });
  it("publishes prepended data and shifted index together, without remounting", () => {
    const before = render(rows(100, 60));
    const next = render(rows(70, 90));
    expect(next.props.data[0].message.id).toBe("m70");
    expect(next.props.firstItemIndex).toBe(before.props.firstItemIndex - 30);
    expect(next.key).toBe(before.key);
    expect(render(rows(70, 90)).props.firstItemIndex).toBe(next.props.firstItemIndex);
  });
  it("preserves absolute row indexes on head trim but remounts disjoint windows", () => {
    const before = render(rows(100, 60));
    const trim = render(rows(110, 50));
    expect(trim.props.firstItemIndex).toBe(before.props.firstItemIndex + 10);
    expect(trim.key).toBe(before.key);
    const replaced = render(rows(300, 60));
    expect(replaced.props.firstItemIndex).toBe(1_000_000);
    expect(replaced.key).not.toBe(trim.key);
  });
  it("does not inherit another conversation's prepend offset", () => {
    render(rows(100, 60));
    render(rows(70, 90));
    const next = render(rows(200, 30), { channelId: "b" });
    expect(next.props.firstItemIndex).toBe(1_000_000);
    expect(next.key).toBe("b:0:0");
  });
  it("does not remount when older system events merge into the first activity cluster", () => {
    const event = (id: number): CachedMessage => ({
      ...rows(id, 1)[0]!,
      from_kind: "system",
      metadata: { subtype: "task_edit" },
    });
    const messages = [event(100), ...rows(105, 30)];
    const before = render(messages);
    const after = render([event(99), ...messages]);
    expect(after.key).toBe(before.key);
    expect(after.props.firstItemIndex).toBe(before.props.firstItemIndex);
    expect(after.props.data[0].messages).toHaveLength(2);
  });
  it("keeps header/footer component identities stable while loading", () => {
    const messages = rows(100, 60);
    const before = render(messages);
    const loading = render(messages, { isFetchingEarlier: true });
    expect(loading.props.components).toBe(before.props.components);
    expect(loading.props.components.Header({ context: {} })).toBeNull();
    expect(loading.key).toBe(before.key);
  });
  it("prefetches near the head, but not when hidden, jumping, exhausted or fetching", () => {
    const onLoadEarlier = vi.fn();
    const messages = rows(100, 60);
    const normal = render(messages, { onLoadEarlier });
    normal.props.onScroll({ currentTarget: { scrollTop: 1000 } });
    expect(onLoadEarlier).not.toHaveBeenCalled();
    normal.props.onScroll({ currentTarget: { scrollTop: 300 } });
    expect(onLoadEarlier).toHaveBeenCalledOnce();
    onLoadEarlier.mockClear();
    for (const blocked of [
      { surfaceActive: false },
      { jumpToMessageId: "m120" },
      { hasMoreBefore: false },
      { isFetchingEarlier: true },
    ]) {
      const node = render(messages, { onLoadEarlier, ...blocked });
      node.props.onScroll({ currentTarget: { scrollTop: 0 } });
      node.props.startReached();
    }
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });
});
