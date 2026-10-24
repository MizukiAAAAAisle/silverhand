import type { ClientPlatform } from "@silverhand/client";
import type { NativeBridge } from "./bridge";
import { rasterizeMarkup } from "./glyph";

/** The system context menu, drawn above the native composer and bars. */
export function createIOSContextMenu(
  bridge: NativeBridge,
): NonNullable<ClientPlatform["contextMenu"]> {
  return {
    show: async (menu) => {
      const sections = await Promise.all(
        menu.sections.map((section) =>
          Promise.all(
            section.map(async (item) => ({ ...item, icon: await rasterizeMarkup(item.icon) })),
          ),
        ),
      );
      const { choice } = await bridge.contextMenuShow({ menu: { ...menu, sections } });
      return choice ?? null;
    },
  };
}
