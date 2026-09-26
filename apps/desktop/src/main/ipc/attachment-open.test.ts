import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materializeAndOpenAttachment, type AttachmentOpenIo } from "./attachment-open";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  tmpdir: () => {
    if (!process.env.SILVERHAND_DIR) throw new Error("isolated SILVERHAND_DIR required");
    return process.env.SILVERHAND_DIR;
  },
}));
const parent = process.env.SILVERHAND_DIR;
if (!parent) throw new Error("isolated SILVERHAND_DIR required");
let root: string;
beforeEach(() => {
  mkdirSync(parent, { recursive: true });
  root = mkdtempSync(join(parent, "attachment-open-"));
  vi.stubEnv("SILVERHAND_DIR", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function io(): AttachmentOpenIo {
  return {
    ensureDir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    writeFile: (path, bytes) => writeFileSync(path, bytes, { mode: 0o600 }),
    openPath: async () => "",
  };
}

describe("external-open file boundary", () => {
  it("overwrites one stable path before OS handoff and keeps distinct IDs apart", async () => {
    const effects = io();
    const seen: Array<{ path: string; bytes: number[] }> = [];
    effects.openPath = async (path) => {
      seen.push({ path, bytes: [...readFileSync(path)] });
      return "";
    };
    for (const [id, bytes] of [
      ["ab", [1, 2]],
      ["ab", [3]],
      ["a-b", [4, 5]],
    ] as const) {
      expect(
        await materializeAndOpenAttachment(
          {
            attachmentId: id,
            filename: "mockup.html",
            bytes: Buffer.from(bytes),
          },
          effects,
        ),
      ).toEqual({ ok: true });
    }
    const scratch = join(root, "silverhand-attachments");
    expect(seen).toEqual([
      { path: join(scratch, "ab", "mockup.html"), bytes: [1, 2] },
      { path: join(scratch, "ab", "mockup.html"), bytes: [3] },
      { path: join(scratch, "a-b", "mockup.html"), bytes: [4, 5] },
    ]);
    expect([...readFileSync(join(scratch, "ab", "mockup.html"))]).toEqual([3]);
    expect(readdirSync(join(scratch, "ab"))).toEqual(["mockup.html"]);
  });

  it.each([
    { attachmentId: "a/b", filename: "x.pdf", reason: "invalid_attachment_id" },
    { attachmentId: "a.b", filename: "x.pdf", reason: "invalid_attachment_id" },
    { attachmentId: "../evil", filename: "x.pdf", reason: "invalid_attachment_id" },
    { attachmentId: "", filename: "x.pdf", reason: "invalid_attachment_id" },
    { attachmentId: "valid", filename: "", reason: "invalid_filename" },
    { attachmentId: "valid", filename: "\x01\x02", reason: "invalid_filename" },
    { attachmentId: "valid", filename: "run.command", reason: "unsafe_extension" },
    { attachmentId: "valid", filename: "x.pdf", reason: "empty_payload" },
  ])(
    "denies $reason without any filesystem/OS effect ($attachmentId,$filename)",
    async ({ attachmentId, filename, reason }) => {
      const effects = { ensureDir: vi.fn(), writeFile: vi.fn(), openPath: vi.fn(async () => "") };
      expect(
        await materializeAndOpenAttachment(
          {
            attachmentId,
            filename,
            bytes: reason === "empty_payload" ? Buffer.alloc(0) : Buffer.from([1]),
          },
          effects,
        ),
      ).toEqual({ ok: false, reason });
      expect(effects.ensureDir).not.toHaveBeenCalled();
      expect(effects.writeFile).not.toHaveBeenCalled();
      expect(effects.openPath).not.toHaveBeenCalled();
    },
  );

  it("returns OS refusal only after writing the requested bytes", async () => {
    const effects = io();
    effects.openPath = async (path) => {
      expect([...readFileSync(path)]).toEqual([9]);
      return "LSNoHandler";
    };
    expect(
      await materializeAndOpenAttachment(
        {
          attachmentId: "valid",
          filename: "x.pdf",
          bytes: Buffer.from([9]),
        },
        effects,
      ),
    ).toEqual({ ok: false, reason: "open_failed:LSNoHandler" });
  });
});
