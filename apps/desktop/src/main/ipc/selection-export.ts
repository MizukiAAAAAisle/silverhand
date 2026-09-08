import { BrowserWindow, clipboard, dialog, nativeImage } from "electron";
import type { GuardedIpcRegistrar } from "./guarded-ipc.js";

// ── Selection export pipeline ─────────────────────────────────────────
//
// Renderer hands over PNG bytes (image) or transcript text (markdown);
// main owns the filesystem boundary (showSaveDialog + writeFile) and
// the clipboard write for images. MessageList / SelectionToolbar /
// the preview modal don't import `fs` or `dialog` directly — Cindy's
// IPC boundary review.
//
// Both save handlers return one of three result shapes so the renderer
// can render an appropriate toast:
//   { ok: true, path: '...' } | { ok: false, canceled: true }
//                              | { ok: false, error: string }
// `canceled` is distinguished from `error` because the user dismissing
// the save dialog is not a failure — toasting "save failed" in that
// case would feel wrong.

type ExportSaveResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

type ExportCopyResult = { ok: true } | { ok: false; error: string };

export function registerSelectionExportIpcHandlers(ipc: GuardedIpcRegistrar): void {
  ipc.handle(
    "export:savePng",
    async (
      event,
      input: { pngBytes?: unknown; suggestedName?: unknown },
    ): Promise<ExportSaveResult> => {
      const buf = bytesFromPayload(input?.pngBytes);
      if (!buf || buf.length === 0) {
        return { ok: false, error: "invalid_payload" };
      }
      const safeName = sanitizeExportFilename(input?.suggestedName, ".png");
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showSaveDialog(win!, {
        title: "Save image",
        defaultPath: safeName,
        filters: [{ name: "PNG Image", extensions: ["png"] }],
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(result.filePath, buf);
        return { ok: true, path: result.filePath };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipc.handle(
    "export:copyPng",
    async (_event, input: { pngBytes?: unknown }): Promise<ExportCopyResult> => {
      // Renderer-side `navigator.clipboard.write([new ClipboardItem({...})])`
      // for images is brittle on Electron / macOS — easier and more
      // reliable to construct an NSImage in main and let Electron handle
      // the OS pasteboard format negotiation.
      const buf = bytesFromPayload(input?.pngBytes);
      if (!buf || buf.length === 0) {
        return { ok: false, error: "invalid_payload" };
      }
      try {
        const img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) return { ok: false, error: "decode_failed" };
        clipboard.writeImage(img);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}

function sanitizeExportFilename(input: unknown, ext: string): string {
  // Coerce + strip path separators, control chars, and characters that
  // are unsafe on common file systems. Falls back to `transcript<ext>`
  // when the input is missing or empty after cleaning. Trusting the
  // renderer's suggested filename is fine for label purposes, but we
  // still re-sanitize here because the renderer is the *untrusted*
  // boundary in this pipeline.
  const raw = typeof input === "string" ? input : "";
  const cleaned = raw
    .replace(/[\\/]/g, "_")
    .replace(/[\x00-\x1f]+/g, "")
    .replace(/[:*?"<>|]/g, "")
    .trim()
    .slice(0, 200);
  if (!cleaned) return `transcript${ext}`;
  // Always coerce the extension — guards against the renderer
  // suggesting `foo.md` for a PNG export by mistake.
  return cleaned.toLowerCase().endsWith(ext) ? cleaned : `${cleaned.replace(/\.[^.]+$/, "")}${ext}`;
}

function bytesFromPayload(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}
