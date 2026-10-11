import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { modalScope } from "@/lib/modal-scope";
type Instance = {
  mounted: boolean;
  deps?: readonly unknown[];
  cleanup?: (() => void) | void;
};
const h = vi.hoisted(() => ({ active: true, current: undefined as unknown }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  forwardRef: (render: unknown) => render,
  useContext: () => h.active,
  useCallback: (fn: unknown) => fn,
  useState: () => {
    const instance = h.current as Instance;
    return [instance.mounted, (next: boolean) => (instance.mounted = next)];
  },
  useLayoutEffect: (effect: () => (() => void) | void, deps: readonly unknown[]) => {
    const instance = h.current as Instance;
    if (instance.deps && deps.every((dep, i) => dep === instance.deps![i])) {
      return;
    }
    instance.cleanup?.();
    instance.cleanup = effect();
    instance.deps = deps;
  },
}));
vi.mock("@radix-ui/react-dialog", () => ({ Content: "content", Root: "root" }));
import { Content } from "./modal";

/** Renders one Content instance; `commit` replays a render after ref changes. */
function mount(active = true) {
  const instance: Instance = { mounted: false };
  const render = () => {
    h.current = instance;
    h.active = active;
    return (Content as any)({}, null).ref as (node: object | null) => void;
  };
  const ref = render();
  ref({});
  render();
  return {
    reattach: () => {
      ref(null);
      ref({});
      render();
    },
    unmount: () => {
      ref(null);
      render();
    },
  };
}
it("content ownership survives child unmount and releases on parent unmount", () => {
  const parent = mount();
  const child = mount();
  child.unmount();
  child.unmount();
  expect(modalScope.blocked).toBe(true);
  parent.unmount();
  expect(modalScope.blocked).toBe(false);
});
it("a ref detach and reattach within one commit keeps ownership unpublished", () => {
  const content = mount();
  const version = modalScope.version;
  content.reattach();
  expect(modalScope.blocked).toBe(true);
  expect(modalScope.version).toBe(version);
  content.unmount();
  expect(modalScope.blocked).toBe(false);
});
it("closed force-mounted and nonmodal content does not acquire ownership", () => {
  const content = mount(false);
  expect(modalScope.blocked).toBe(false);
  content.unmount();
});
it("all existing styled dialogs and lightboxes use the shared unstyled boundary", () => {
  for (const file of [
    "components/ui/dialog.tsx",
    "features/messages/components/lightbox.tsx",
    "features/messages/components/mermaid-lightbox.tsx",
    "features/messages/components/image-preview-modal.tsx",
  ]) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    expect(source).not.toContain('from "@radix-ui/react-dialog"');
    expect(source).toMatch(/from "(?:\.\/modal|@\/components\/ui\/modal)"/);
  }
});
