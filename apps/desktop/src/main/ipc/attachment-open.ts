import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeOpenExtension } from "@silverhand/shared";

export type AttachmentOpenResult = { ok: true } | { ok: false; reason: string };

// Attachment ids are `randomBytes(12).toString('base64url')` (backend
// `attachment-repo.ts`), whose alphabet is exactly this set. The id maps 1:1
// onto a scratch subdirectory, so it must match in full — stripping stray
// characters would fold distinct ids (`a/b` and `ab`) onto one path and let a
// later open overwrite an unrelated attachment.
const ATTACHMENT_ID = /^[A-Za-z0-9_-]+$/;

interface ScratchTarget {
  dir: string;
  fullPath: string;
}

/**
 * Compute the single stable scratch path an attachment materializes to for
 * open-with-OS, and fail closed on anything that isn't safe to write or open.
 * Pure (no fs / no Buffer) so the path + gating contract is unit-testable.
 *
 * The path is keyed on the attachment id, and the attachment's filename is
 * immutable across in-place content revisions, so the same attachment always
 * resolves to the same file — reopening reuses it and an update overwrites it
 * rather than accumulating random temp files.
 *
 * Gates, in order: the id must match the backend id alphabet in full (see
 * `ATTACHMENT_ID`); the filename must be non-empty after stripping path
 * separators and control chars; the resulting extension must be one Launch
 * Services can open safely (`isSafeOpenExtension` — a `.command` / `.pkg`
 * would run, not view).
 */
function resolveAttachmentScratchTarget(
  attachmentId: unknown,
  filename: unknown,
): { ok: true; target: ScratchTarget } | { ok: false; reason: string } {
  if (typeof attachmentId !== "string" || !ATTACHMENT_ID.test(attachmentId)) {
    return { ok: false, reason: "invalid_attachment_id" };
  }
  if (typeof filename !== "string" || filename.length === 0) {
    return { ok: false, reason: "invalid_filename" };
  }
  const safeName = filename
    .replace(/[\\/]/g, "_")
    .replace(/[\x00-\x1f]+/g, "")
    .trim()
    .slice(0, 255);
  if (!safeName) return { ok: false, reason: "invalid_filename" };
  if (!isSafeOpenExtension(safeName)) {
    return { ok: false, reason: "unsafe_extension" };
  }
  const dir = join(tmpdir(), "silverhand-attachments", attachmentId);
  return { ok: true, target: { dir, fullPath: join(dir, safeName) } };
}

export interface AttachmentOpenIo {
  /** `mkdir -p` the scratch dir. */
  ensureDir: (dir: string) => void;
  /** Overwrite the scratch file with the latest bytes. */
  writeFile: (path: string, bytes: Buffer) => void;
  /** Hand the file to the OS default handler; returns a non-empty string on failure. */
  openPath: (path: string) => Promise<string>;
}

/**
 * Materialize `bytes` to the attachment's stable scratch path (overwriting any
 * prior content) and hand it to the OS. All fs / shell effects are injected so
 * the "same id reuses one path and overwrites; invalid id never touches disk"
 * contract is testable without a real filesystem.
 */
export async function materializeAndOpenAttachment(
  input: { attachmentId: unknown; filename: unknown; bytes: Buffer },
  io: AttachmentOpenIo,
): Promise<AttachmentOpenResult> {
  if (input.bytes.length === 0) return { ok: false, reason: "empty_payload" };
  const resolved = resolveAttachmentScratchTarget(input.attachmentId, input.filename);
  if (!resolved.ok) return resolved;
  const { dir, fullPath } = resolved.target;
  try {
    io.ensureDir(dir);
  } catch (err) {
    return { ok: false, reason: `mkdir_failed:${errMessage(err)}` };
  }
  try {
    io.writeFile(fullPath, input.bytes);
  } catch (err) {
    return { ok: false, reason: `write_failed:${errMessage(err)}` };
  }
  const openErr = await io.openPath(fullPath);
  if (openErr) return { ok: false, reason: `open_failed:${openErr}` };
  return { ok: true };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
