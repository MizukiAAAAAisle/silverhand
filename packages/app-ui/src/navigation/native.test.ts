import { modalScope } from "@/lib/modal-scope";
import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  native: undefined as any,
}));
vi.mock("react", () => ({
  useEffect: (fn: () => void) => h.effects.push(fn),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("./layout", () => ({ useCompactLayout: () => true }));
vi.mock("@/platform", () => ({ getPlatform: () => ({ navigation: h.native }) }));
import { useNativeNavigation } from "./native";
import { NavigationStore } from "./store";
import { showsTabBar } from "./presentation";
afterEach(() => {
  h.effects = [];
  vi.unstubAllGlobals();
});
function setup() {
  let handler: (intent: any) => void = () => {};
  h.native = {
    capture: vi.fn(async () => {}),
    sync: vi.fn(async () => ({ bottomInset: 80 })),
    reset: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    subscribe: vi.fn(async (fn) => {
      handler = fn;
      return vi.fn();
    }),
  };
  vi.stubGlobal("document", {
    documentElement: { style: { setProperty: vi.fn(), removeProperty: vi.fn() } },
  });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => fn());
  const store = new NavigationStore("/chat");
  let allowed = true;
  const run = useNativeNavigation(store, () => allowed);
  const cleanup = h.effects[0]!()!;
  return {
    store,
    run,
    cleanup,
    deny: () => {
      allowed = false;
    },
    emit: (
      kind: string,
      request: string,
      key = store.getSnapshot().location.key,
      modalVersion = modalScope.version,
    ) => handler({ session: store.session, modalVersion, key, kind, request }),
  };
}
it("hides global navigation in details, retains workspace and filtered task roots", () => {
  expect(showsTabBar("/chat/w/workspace")).toBe(true);
  expect(showsTabBar("/tasks", "?status=open")).toBe(true);
  for (const path of ["/chat/d/c", "/members", "/settings"]) expect(showsTabBar(path)).toBe(false);
  expect(showsTabBar("/tasks", "?task=t")).toBe(false);
});
it("captures before commit and does not commit an obsolete capture after session teardown", async () => {
  const { store, run, cleanup } = setup();
  let release!: () => void;
  h.native.capture.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const commit = vi.fn(() => store.go("/chat/d/private"));
  const pending = run(commit);
  cleanup();
  store.dispose();
  release();
  expect(await pending).toBe(false);
  expect(commit).not.toHaveBeenCalled();
});
it("completes back once and rejects guarded gestures without changing history", async () => {
  const { store, emit, deny, cleanup } = setup();
  store.go("/chat/d/c");
  store.go("/chat/d/c?settings=c");
  emit("back", "one");
  emit("back", "one");
  await vi.waitFor(() =>
    expect(h.native.finish).toHaveBeenCalledWith({
      session: store.session,
      request: "one",
      accepted: true,
    }),
  );
  expect(store.getSnapshot().location.pathname).toBe("/chat/d/c");
  deny();
  emit("back", "two");
  await vi.waitFor(() =>
    expect(h.native.finish).toHaveBeenCalledWith({
      session: store.session,
      request: "two",
      accepted: false,
    }),
  );
  expect(store.getSnapshot().location.pathname).toBe("/chat/d/c");
  cleanup();
});

it("rejects a gesture begun on an entry that has since changed", async () => {
  const { store, emit, cleanup } = setup();
  store.go("/chat/d/c?settings=c");
  const origin = store.getSnapshot().location.key;
  store.go("/chat/d/c?thread=new");
  emit("back", "old-gesture", origin);
  await vi.waitFor(() =>
    expect(h.native.finish).toHaveBeenCalledWith({
      session: store.session,
      request: "old-gesture",
      accepted: false,
    }),
  );
  expect(store.getSnapshot().location.search).toBe("?thread=new");
  cleanup();
});

it("blocks native intents while nested modals remain and releases after final unmount", async () => {
  const { store, emit, cleanup } = setup();
  store.go("/chat/d/c");
  const parent = modalScope.acquire();
  const child = modalScope.acquire();
  child();
  emit("back", "modal");
  await vi.waitFor(() =>
    expect(h.native.finish).toHaveBeenCalledWith({
      session: store.session,
      request: "modal",
      accepted: false,
    }),
  );
  expect(store.getSnapshot().location.pathname).toBe("/chat/d/c");
  expect(h.native.sync.mock.calls.at(-1)[0].blocked).toBe(true);
  parent();
  expect(h.native.sync.mock.calls.at(-1)[0].blocked).toBe(false);
  emit("back", "released");
  await vi.waitFor(() => expect(store.getSnapshot().location.pathname).toBe("/chat"));
  cleanup();
});

it("rejects a pending native intent even if an intervening modal has already closed", async () => {
  const { store, emit, cleanup } = setup();
  store.go("/chat/d/c");
  let release!: () => void;
  h.native.capture.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  emit("back", "pending");
  const close = modalScope.acquire();
  close();
  release();
  await vi.waitFor(() =>
    expect(h.native.finish).toHaveBeenCalledWith({
      session: store.session,
      request: "pending",
      accepted: false,
    }),
  );
  expect(store.getSnapshot().location.pathname).toBe("/chat/d/c");
  cleanup();
});

it("allows a modal's own successful navigation while native navigation is suppressed", async () => {
  const { store, run, cleanup } = setup();
  const close = modalScope.acquire();
  expect(await run(() => store.go("/tasks?task=created"))).toBe(true);
  expect(store.getSnapshot().location.search).toBe("?task=created");
  close();
  cleanup();
});

it("rejects an intent delivered after an intervening modal was opened and closed", async () => {
  const { store, emit, cleanup } = setup();
  store.go("/chat/d/c");
  const version = modalScope.version;
  const close = modalScope.acquire();
  close();
  emit("back", "late-delivery", store.getSnapshot().location.key, version);
  await vi.waitFor(() =>
    expect(h.native.finish).toHaveBeenCalledWith({
      session: store.session,
      request: "late-delivery",
      accepted: false,
    }),
  );
  expect(store.getSnapshot().location.pathname).toBe("/chat/d/c");
  cleanup();
});

it("projects More destinations as selected without changing the source tab history", async () => {
  const { store, cleanup } = setup();
  store.selectTab("tasks");
  for (const path of ["/members", "/computers", "/settings"]) {
    store.go(path);
    expect(h.native.sync.mock.calls.at(-1)[0].tab).toBe("more");
    expect(store.getSnapshot().tab).toBe("tasks");
    store.back();
    expect(store.getSnapshot().location.pathname).toBe("/tasks");
    expect(h.native.sync.mock.calls.at(-1)[0].tab).toBe("tasks");
  }
  cleanup();
});
