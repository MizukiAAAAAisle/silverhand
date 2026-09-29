import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { modalScope } from "@/lib/modal-scope";
const h = vi.hoisted(() => ({ active: true }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  forwardRef: (render: unknown) => render,
  useContext: () => h.active,
  useRef: () => ({ current: undefined }),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("@radix-ui/react-dialog", () => ({ Content: "content", Root: "root" }));
import { Content } from "./modal";

function mount(active = true) {
  h.active = active;
  const element = (Content as any)({}, null);
  const ref = element.ref;
  ref({});
  return () => ref(null);
}
it("content ownership survives child unmount and releases on parent unmount", () => {
  const parent = mount();
  const child = mount();
  child();
  child();
  expect(modalScope.blocked).toBe(true);
  parent();
  expect(modalScope.blocked).toBe(false);
});
it("closed force-mounted and nonmodal content does not acquire ownership", () => {
  const unmount = mount(false);
  expect(modalScope.blocked).toBe(false);
  unmount();
});
it("all existing styled dialogs and lightboxes use the shared unstyled boundary", () => {
  for (const file of [
    "ui/dialog.tsx",
    "chat/lightbox.tsx",
    "chat/mermaid-lightbox.tsx",
    "chat/image-preview-modal.tsx",
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    expect(source).not.toContain('from "@radix-ui/react-dialog"');
    expect(source).toMatch(/from "(?:\.\/modal|@\/components\/ui\/modal)"/);
  }
});
