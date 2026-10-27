import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  options: [] as unknown[],
  focused: false,
  otherWindowFocused: false,
  beep: vi.fn(),
  shown: vi.fn(),
  closed: vi.fn(),
  send: vi.fn(),
  events: {} as Record<string, () => void>,
}));
vi.mock("electron", () => ({
  app: { focus: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: () => (boundary.focused || boundary.otherWindowFocused ? {} : null),
    fromWebContents: () => (boundary.focused ? { isFocused: () => true } : null),
    getAllWindows: () => [],
  },
  dialog: {},
  shell: { beep: boundary.beep },
  Notification: class {
    constructor(options: unknown) {
      boundary.options.push(options);
    }
    on(name: string, fn: () => void) {
      boundary.events[name] = fn;
    }
    show() {
      boundary.shown();
    }
    close() {
      boundary.closed();
    }
  },
}));
import { registerSurfaceIpcHandlers } from "../ipc/surface-ipc";
import type { GuardedIpcRegistrar } from "../ipc/guarded-ipc";
beforeEach(() => {
  boundary.options = [];
  boundary.focused = false;
  boundary.otherWindowFocused = false;
  boundary.events = {};
  vi.clearAllMocks();
});
it("uses the independent default sound preference without changing click or dismissal", () => {
  const handlers = new Map<string, Function>();
  let sound = true;
  registerSurfaceIpcHandlers(
    {
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
      on: () => {},
    } satisfies GuardedIpcRegistrar,
    () => sound,
  );
  const event = { sender: { isDestroyed: () => false, send: boundary.send } };
  const notify = () =>
    handlers.get("notification:show")!(event, {
      title: "Mention",
      body: "Hello",
      notificationId: "n1",
    });
  notify();
  expect(boundary.options[0]).toMatchObject({ silent: false });
  sound = false;
  notify();
  expect(boundary.options[1]).toMatchObject({ silent: true });
  boundary.events.click!();
  expect(boundary.send).toHaveBeenCalledWith("notification:clicked", "n1");
  handlers.get("notification:dismiss")!(event, ["n1"]);
  expect(boundary.closed).toHaveBeenCalledOnce();
  expect(boundary.shown).toHaveBeenCalledTimes(2);
});

it("replaces the system sound with custom audio without changing notification delivery", () => {
  const handlers = new Map<string, Function>();
  let enabled = true;
  registerSurfaceIpcHandlers(
    {
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
      on: () => {},
    },
    () => enabled,
    () => "data:audio/ogg;base64,AAAA",
  );
  const event = { sender: { isDestroyed: () => false, send: boundary.send } };
  const notify = () =>
    handlers.get("notification:show")!(event, { title: "Mention", body: "Hello" });
  expect(notify()).toBe("data:audio/ogg;base64,AAAA");
  expect(boundary.options[0]).toMatchObject({ silent: true });
  enabled = false;
  expect(notify()).toBeUndefined();
  expect(boundary.shown).toHaveBeenCalledTimes(2);
});

// Contract replaced 2026-10-27: upstream 258d8093 has no
// `currentConversation` sound-only branch, so a forced mention always raises a
// banner. The notification sounds capability itself stays: enabling it, the
// custom sound and the returned audio path are asserted below.
it("raises the banner for a forced mention while the window is focused", () => {
  const handlers = new Map<string, Function>();
  let enabled = true;
  registerSurfaceIpcHandlers(
    {
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
      on: () => {},
    },
    () => enabled,
  );
  boundary.focused = true;
  const event = { sender: { isDestroyed: () => false, send: boundary.send } };
  const input = { title: "Mention", force: true, notificationId: "n1" };
  handlers.get("notification:show")!(event, input);
  expect(boundary.shown).toHaveBeenCalledOnce();
  enabled = false;
  handlers.get("notification:show")!(event, input);
  // Sound off only silences the alert; the banner still appears.
  expect(boundary.shown).toHaveBeenCalledTimes(2);
});

it.each([
  { focused: true, otherWindowFocused: false },
  { focused: false, otherWindowFocused: false },
  { focused: false, otherWindowFocused: true },
])(
  "delivers custom audio once with a single banner (focused=$focused, otherWindowFocused=$otherWindowFocused)",
  ({ focused, otherWindowFocused }) => {
    const handlers = new Map<string, Function>();
    let enabled = true;
    registerSurfaceIpcHandlers(
      {
        handle: (channel, fn) => {
          handlers.set(channel, fn);
        },
        on: () => {},
      },
      () => enabled,
      () => "data:audio/ogg;base64,AAAA",
    );
    boundary.focused = focused;
    boundary.otherWindowFocused = otherWindowFocused;
    const event = { sender: { isDestroyed: () => false, send: boundary.send } };
    const input = { title: "Mention", force: true };
    expect(handlers.get("notification:show")!(event, input)).toBe("data:audio/ogg;base64,AAAA");
    expect(boundary.shown).toHaveBeenCalledTimes(1);
    expect(boundary.options[0]).toMatchObject({ silent: true });
    enabled = false;
    expect(handlers.get("notification:show")!(event, input)).toBeUndefined();
    expect(boundary.shown).toHaveBeenCalledTimes(2);
  },
);
