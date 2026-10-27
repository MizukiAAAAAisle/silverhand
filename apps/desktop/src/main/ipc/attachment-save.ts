/**
 * Trust-boundary core of the `attachment:save` IPC. Extracted from the
 * ipcMain handler so the input validation, filename sanitization,
 * cancel branch, and write-failure branch are testable without
 * standing up an Electron process.
 *
 * The IPC handler injects the real `dialog.showSaveDialog` + `fs.writeFile`;
 * tests inject in-memory doubles.
 */

import { nativeCopy } from "../shell/native-copy.js";

export type AttachmentSaveResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; reason: string };

export interface SaveDialogOptions {
  title: string;
  defaultPath: string;
}

export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface AttachmentSaveDeps {
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResult>;
  writeFile: (path: string, data: Buffer) => Promise<void>;
}

export async function handleAttachmentSave(
  input: { filename?: unknown; bytes?: unknown },
  deps: AttachmentSaveDeps,
): Promise<AttachmentSaveResult> {
  const filenameRaw = input?.filename;
  if (typeof filenameRaw !== "string" || filenameRaw.length === 0) {
    return { ok: false, reason: "invalid_filename" };
  }
  const bytesRaw = input?.bytes;
  if (!(bytesRaw instanceof Uint8Array) && !Buffer.isBuffer(bytesRaw)) {
    return { ok: false, reason: "invalid_payload" };
  }
  const buffer = Buffer.isBuffer(bytesRaw) ? bytesRaw : Buffer.from(bytesRaw);
  if (buffer.length === 0) {
    return { ok: false, reason: "empty_payload" };
  }
  const safeName = sanitizeAttachmentFilename(filenameRaw);
  if (!safeName) return { ok: false, reason: "invalid_filename" };
  const result = await deps.showSaveDialog({
    title: nativeCopy().saveAttachment,
    defaultPath: safeName,
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  try {
    await deps.writeFile(result.filePath, buffer);
    return { ok: true, path: result.filePath };
  } catch (err) {
    return {
      ok: false,
      reason: `write_failed:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Strip path separators and control chars, cap length. The user's
 *  final destination path is decided by the save dialog; this is only
 *  the pre-filled default. */
function sanitizeAttachmentFilename(raw: string): string {
  return raw
    .replace(/[\\/]/g, "_")
    .replace(/[\x00-\x1f]+/g, "")
    .trim()
    .slice(0, 255);
}
