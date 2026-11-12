// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NotificationDiagnosticsCapability, NotificationHookSnapshot, NotificationSystemSnapshot } from "@silverhand/client";
const h = vi.hoisted(() => ({ platform: {} as Record<string, unknown> }));
vi.mock("@/platform", () => ({ getPlatform: () => h.platform }));
vi.mock("@/features/legal/legal-links", () => ({
  PRIVACY_POLICY_URL: "https://example.invalid/privacy", SUPPORT_URL: "https://example.invalid/support",
  ExternalLink: ({ href, children }: { href: string; children: ReactNode }) => createElement("a", { href }, children),
}));
import { AboutPane } from "./about-pane";

let root: Root;
let host: HTMLDivElement;
function capability(): NotificationDiagnosticsCapability {
  const local = { session: "present" as const, lastSend: { status: "posted" as const, at: 1000 } };
  return {
    readSystem: vi.fn(async () => ({ runtimePermission: "granted" as const, appEnabled: true, channel: "present" as const, channelBlocked: false })),
    getLocalSnapshot: () => local,
    subscribeLocal: vi.fn(() => vi.fn()),
  };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  h.platform = { getAppVersion: async () => "0.4" };
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it("keeps existing About content and adds no diagnostic section or empty slot when the capability is absent", async () => {
  await act(async () => root.render(createElement(AboutPane)));
  expect(host.textContent).toContain("0.4");
  expect(host.querySelectorAll("a")).toHaveLength(2);
  expect(host.querySelector("[data-notification-diagnostics]")).toBeNull();
  expect(host.querySelector("[data-notification-test-slot]")).toBeNull();
  expect(host.querySelector("[data-notification-hook-row]")).toBeNull();
});
it("keeps four read-only rows when hook observation is not supplied", async () => {
  const cap = capability(); h.platform.notificationDiagnostics = cap;
  await act(async () => root.render(createElement(AboutPane)));
  expect(host.querySelectorAll("[data-notification-diagnostics] dt")).toHaveLength(4);
  expect(host.textContent).toContain("Granted"); expect(host.textContent).toContain("posted (system call returned)");
  expect(host.querySelector("[data-notification-test-slot]")).toBeNull();
  expect(cap.readSystem).toHaveBeenCalledOnce();
});
it("mounts the optional control only when supplied and releases its DOM/subscription on unmount", async () => {
  const cap = capability(); const dispose = vi.fn();
  cap.mountTestControl = vi.fn((slot) => {
    const button = document.createElement("button"); button.textContent = "fixture control"; slot.append(button);
    return () => { button.remove(); dispose(); };
  });
  h.platform.notificationDiagnostics = cap;
  await act(async () => root.render(createElement(AboutPane)));
  expect(cap.mountTestControl).toHaveBeenCalledOnce(); expect(host.querySelectorAll("button")).toHaveLength(1);
  await act(async () => root.render(createElement("div")));
  expect(dispose).toHaveBeenCalledOnce(); expect(host.querySelector("[data-notification-test-slot]")).toBeNull();
});
it("bounds a system query to five seconds, ignores its late result and reads again only on visibility return", async () => {
  vi.useFakeTimers(); const cap = capability(); let finish!: (value: NotificationSystemSnapshot) => void;
  const pending = new Promise<NotificationSystemSnapshot>((resolve) => { finish = resolve; });
  vi.mocked(cap.readSystem).mockReturnValueOnce(pending);
  h.platform.notificationDiagnostics = cap;
  await act(async () => root.render(createElement(AboutPane)));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(host.textContent).toContain("Unknown");
  await act(async () => { finish({ runtimePermission: "granted", appEnabled: true, channel: "present", channelBlocked: false }); });
  expect(host.querySelector("dl")?.textContent).not.toContain("Granted");
  vi.mocked(cap.readSystem).mockResolvedValueOnce({ runtimePermission: "not-granted", appEnabled: false, channel: "absent", channelBlocked: null });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(host.textContent).toContain("Not granted"); expect(cap.readSystem).toHaveBeenCalledTimes(2);
  await act(async () => root.render(createElement("div")));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(cap.readSystem).toHaveBeenCalledTimes(2);
});

it("does not query while hidden or unmounted and refreshes a visible view on the native foreground signal", async () => {
  const cap = capability(); h.platform.notificationDiagnostics = cap;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => root.render(createElement(AboutPane)));
  await act(async () => window.dispatchEvent(new Event("silverhand:notification-diagnostics-foreground")));
  expect(cap.readSystem).not.toHaveBeenCalled();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => window.dispatchEvent(new Event("silverhand:notification-diagnostics-foreground")));
  expect(cap.readSystem).toHaveBeenCalledOnce();
  await act(async () => root.render(createElement("div")));
  window.dispatchEvent(new Event("silverhand:notification-diagnostics-foreground"));
  expect(cap.readSystem).toHaveBeenCalledOnce();
});

it("keeps the newest snapshot when adjacent foreground and visibility queries settle out of order", async () => {
  const cap = capability(); h.platform.notificationDiagnostics = cap;
  let finish1!: (value: NotificationSystemSnapshot) => void, finish2!: (value: NotificationSystemSnapshot) => void;
  vi.mocked(cap.readSystem).mockReturnValueOnce(new Promise((resolve) => { finish1 = resolve; }))
    .mockReturnValueOnce(new Promise((resolve) => { finish2 = resolve; }))
    .mockResolvedValueOnce({ runtimePermission: "not-granted", appEnabled: false, channel: "absent", channelBlocked: null });
  await act(async () => root.render(createElement(AboutPane)));
  await act(async () => window.dispatchEvent(new Event("silverhand:notification-diagnostics-foreground")));
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => {
    finish2({ runtimePermission: "granted", appEnabled: true, channel: "present", channelBlocked: false });
    finish1({ runtimePermission: "granted", appEnabled: true, channel: "present", channelBlocked: false });
  });
  expect(cap.readSystem).toHaveBeenCalledTimes(3);
  expect(host.querySelector("dl")?.textContent).toContain("Not granted");
  expect(host.querySelector("dl")?.textContent).not.toContain("Granted");
});


it("adds only two passive hook rows, updates from memory and releases its subscription", async () => {
  const cap=capability(); let snapshot: NotificationHookSnapshot={list:null,decision:"not-evaluated"};
  const listeners=new Set<() => void>();
  cap.hook={
    createObserver:vi.fn(() => { throw new Error("view must not create an observer"); }),
    getSnapshot:() => snapshot,
    subscribe:(listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  h.platform.notificationDiagnostics=cap;
  await act(async () => root.render(createElement(AboutPane)));
  expect(host.querySelectorAll("dt")).toHaveLength(6);
  expect(host.querySelectorAll("[data-notification-hook-row]")).toHaveLength(2);
  expect(host.textContent).toContain("No observation recorded");
  await act(async () => {
    snapshot={list:{mentionSelfCount:2,at:1000},decision:"suppressed-conversation"};
    for(const listener of listeners) listener();
  });
  const rows=[...host.querySelectorAll("[data-notification-hook-row]")];
  expect(rows[0]!.textContent).toContain("This list contains 2 @me items (including existing items)");
  expect(rows[1]!.textContent).toContain("Silent (focused conversation condition)");
  expect(rows[1]!.textContent).toContain("latest @me in this list");
  expect(host.querySelector("[data-notification-hook-note]")!.textContent).toContain("Unknown does not mean unfiltered");
  await act(async () => {
    snapshot={list:{mentionSelfCount:0,at:2000},decision:"no-mention"};
    for(const listener of listeners) listener();
  });
  expect(host.textContent).toContain("This list contains 0 @me");
  expect(host.textContent).toContain("Unknown (no @me in this list)");
  expect(cap.hook.createObserver).not.toHaveBeenCalled();
  expect(cap.readSystem).toHaveBeenCalledOnce();
  await act(async () => root.render(createElement("div")));
  expect(listeners.size).toBe(0);
});

it.each([
  ["initial-list","initial list; marked seen"],
  ["already-seen","already processed"],
  ["no-capability","no system notification capability"],
  ["initiated","Not filtered (shared send called)"],
] as const)("labels the selected mention decision %s without treating unknown as unfiltered", async (decision,text) => {
  const cap=capability();const snapshot:NotificationHookSnapshot={list:{mentionSelfCount:1,at:1000},decision};
  cap.hook={createObserver:vi.fn(),getSnapshot:() => snapshot,subscribe:() => () => {}};
  h.platform.notificationDiagnostics=cap;
  await act(async () => root.render(createElement(AboutPane)));
  expect(host.querySelectorAll("[data-notification-hook-row]")[1]!.textContent).toContain(text);
});
