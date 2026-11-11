// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NotificationDiagnosticsCapability, NotificationSystemSnapshot } from "@silverhand/client";
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
});
it("renders exactly four read-only rows and no test host for normal Android", async () => {
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
