import type { ClientPlatform } from "@silverhand/client";
import type { NativeBridge } from "./bridge";

export function createIOSFiles(bridge: NativeBridge): ClientPlatform["files"] {
  return {
    sharePngExport: async ({ pngBytes }) => {
      try {
        let binary = "";
        for (let start = 0; start < pngBytes.length; start += 8192) {
          binary += String.fromCharCode(...pngBytes.subarray(start, start + 8192));
        }
        const { completed } = await bridge.sharePng({ base64: btoa(binary) });
        return completed ? { ok: true } : { ok: false, canceled: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Unable to share image",
        };
      }
    },
    openExternal: (url) => bridge.openExternal({ url }),
    openAttachmentExternal: async () => ({
      ok: false,
      reason: "Attachments are not available in this iOS preview",
    }),
    saveAttachment: async () => ({
      ok: false,
      reason: "Attachments are not available in this iOS preview",
    }),
    savePngExport: async () => ({
      ok: false,
      error: "Image export is not available in this iOS preview",
    }),
    copyPngExport: async () => ({
      ok: false,
      error: "Image clipboard is not available in this iOS preview",
    }),
  };
}
