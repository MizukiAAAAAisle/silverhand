import type { ClientPlatform } from "@silverhand/client";
import type { NativeBridge } from "./bridge";
import { rasterizeMarkup } from "./glyph";

/** The wide layout's titlebar, drawn as the system navigation bar. */
export function createIOSTitlebar(bridge: NativeBridge): NonNullable<ClientPlatform["titlebar"]> {
  let version = 0;

  return {
    sync: async (state) => {
      const current = ++version;
      const native = state && {
        ...state,
        actions: await Promise.all(
          state.actions.map(async (item) => ({ ...item, icon: await rasterizeMarkup(item.icon) })),
        ),
      };
      // A later state may have been sent while glyphs rendered.
      if (current === version) {
        await bridge.titlebar({ state: native });
      }
    },
    endSearch: (input) => bridge.titlebarEndSearch(input),
    subscribe: async (handler) => {
      const listener = await bridge.addListener("titlebar", handler);
      return () => {
        void listener.remove();
      };
    },
  };
}
