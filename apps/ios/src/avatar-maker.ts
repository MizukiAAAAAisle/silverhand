import type { ClientPlatform } from "@silverhand/client";
import type { NativeBridge } from "./bridge";

export function createIOSAvatarMaker(
  bridge: NativeBridge,
): NonNullable<ClientPlatform["avatarMaker"]> {
  return {
    edit: async ({ config }) => {
      const result = await bridge.avatarMakerEdit({ config });

      if (!result.config || !result.base64) {
        return null;
      }

      return {
        config: result.config,
        pngBytes: Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0)),
      };
    },
  };
}
