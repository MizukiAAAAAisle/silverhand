import type { ClientPlatform } from "@silverhand/client";
import { rasterizeImage, rasterizeMarkup } from "./glyph";
import type { NativeBridge } from "./bridge";

const FACE_PX = 36;

/** Notices over the native bars. */
export function createIOSBanner(bridge: NativeBridge): NonNullable<ClientPlatform["banner"]> {
  return {
    show: async (notice) => {
      const icon = notice.icon
        ? "image" in notice.icon
          ? { image: await rasterizeImage(notice.icon.image, FACE_PX) }
          : { ...notice.icon, glyph: await rasterizeMarkup(notice.icon.glyph) }
        : undefined;
      await bridge.bannerShow({ ...notice, icon });
    },
    subscribe: async (handler) => {
      const listener = await bridge.addListener("banner", handler);
      return () => {
        void listener.remove();
      };
    },
  };
}
