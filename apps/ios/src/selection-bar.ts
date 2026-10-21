import type { ClientPlatform } from "@silverhand/client";
import type { NativeBridge } from "./bridge";

/** The compact message-selection bar, drawn natively in the composer's place. */
export function createIOSSelectionBar(
  bridge: NativeBridge,
): NonNullable<ClientPlatform["selectionBar"]> {
  return {
    sync: (state) => bridge.selectionBarSync({ state }),
    remove: (key) => bridge.selectionBarRemove({ key }),
    subscribe: async (handler) => {
      const listener = await bridge.addListener("selectionBar", handler);
      return () => {
        void listener.remove();
      };
    },
  };
}
