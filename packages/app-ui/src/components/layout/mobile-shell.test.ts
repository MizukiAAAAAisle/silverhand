import { expect, it, vi } from "vitest";
import { MobileHeader } from "./mobile-shell";

const h = vi.hoisted(() => ({
  target: null as null | HTMLSpanElement,
  canBack: true,
  back: vi.fn(),
  portal: vi.fn((node: unknown, target: unknown) => ({ node, target })),
}));
vi.mock("react-dom", () => ({ createPortal: h.portal }));
vi.mock("./mobile-header-slot", () => ({
  useMobileHeaderTarget: () => h.target,
  useMobileHeaderActionRef: () => null,
}));
vi.mock("@/platform", () => ({ getPlatform: () => ({}) }));
vi.mock("@/navigation/provider", () => ({
  useNavigationDriver: () => ({ back: h.back, canBack: h.canBack }),
}));
vi.mock("@/router", () => ({ useRouteState: () => ({ section: "activity" }), useNav: vi.fn() }));
vi.mock("@/components/menus/app-context-menu", () => ({
  AppDropdownMenu: () => null,
  AppDropdownMenuItem: () => null,
}));

it("uses the page's header at a root without adding another title bar", () => {
  h.target = {} as HTMLSpanElement;
  h.canBack = false;
  MobileHeader({});
  expect(h.portal).toHaveBeenLastCalledWith(null, h.target);
});

it("keeps guarded back behavior when presenting back inside a page header", () => {
  h.target = {} as HTMLSpanElement;
  h.canBack = true;
  MobileHeader({});
  (h.portal.mock.lastCall![0] as { props: { onClick: () => void } }).props.onClick();
  expect(h.back).toHaveBeenCalledOnce();
});

it("keeps the shell header for pages without their own navigation slot", () => {
  h.target = null;
  const header = MobileHeader({});
  expect(header?.type).toBe("header");
});

it("omits the redundant sidebar heading while retaining page headers", () => {
  h.target = null;
  expect(MobileHeader({ hideFallback: true })).toBeNull();
});
