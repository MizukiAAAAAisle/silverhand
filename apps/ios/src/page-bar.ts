import type { ClientPlatform, PageBarItem, PageBarState } from "@silverhand/client";
import { rasterizeImage, rasterizeMarkup } from "./glyph";
import type { NativeBridge } from "./bridge";

const pngs = new Map<string, Promise<string>>();

function png(source: string, picture = false): Promise<string> {
  const key = (picture ? "image:" : "glyph:") + source;
  let cached = pngs.get(key);
  if (!cached) {
    cached = picture ? rasterizeImage(source) : rasterizeMarkup(source);
    pngs.set(key, cached);
  }
  return cached;
}

async function titleIcon(
  icon: PageBarState["titleIcon"],
): Promise<{ glyph: string } | { image: string } | undefined> {
  if (!icon) {
    return undefined;
  }
  return "glyph" in icon
    ? { glyph: await png(icon.glyph) }
    : { image: await png(icon.image, true) };
}

async function withPng<T extends PageBarItem>(item: T): Promise<T> {
  return { ...item, icon: await png(item.icon) };
}

/** The compact page header, drawn as the system navigation bar. */
export function createIOSPageBar(bridge: NativeBridge): NonNullable<ClientPlatform["pageBar"]> {
  let version = 0;

  return {
    sync: async (state) => {
      const current = ++version;
      let native: PageBarState | null = null;
      if (state) {
        native = {
          ...state,
          titleIcon: await titleIcon(state.titleIcon),
          overflow: state.overflow && {
            ...state.overflow,
            icon: await png(state.overflow.icon),
          },
          actions: await Promise.all(state.actions.map((group) => Promise.all(group.map(withPng)))),
          tabs: state.tabs ? await Promise.all(state.tabs.map(withPng)) : null,
          addTabs: state.addTabs && {
            ...state.addTabs,
            items: await Promise.all(state.addTabs.items.map(withPng)),
          },
        };
      }
      // A later state may have been sent while glyphs rendered.
      if (current === version) {
        await bridge.pageBar({ state: native });
      }
    },
    backProgress: (progress) => bridge.pageBarBackProgress({ progress }),
    subscribe: async (handler) => {
      const listener = await bridge.addListener("pageBar", handler);
      return () => {
        void listener.remove();
      };
    },
  };
}
