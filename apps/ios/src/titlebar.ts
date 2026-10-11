import type { ClientPlatform } from "@silverhand/client";
import type { NativeBridge } from "./bridge";

/** The wide layout's titlebar, drawn as the system navigation bar. */
export function createIOSTitlebar(bridge: NativeBridge): NonNullable<ClientPlatform["titlebar"]> {
  return {
    sync: (state) => bridge.titlebar({ state }),
    endSearch: (input) => bridge.titlebarEndSearch(input),
    subscribe: async (handler) => {
      const listener = await bridge.addListener("titlebar", handler);
      return () => {
        void listener.remove();
      };
    },
  };
}
