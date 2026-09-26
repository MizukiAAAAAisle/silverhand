import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { handleAttachmentSave } from "../attachment-save";

const parent = process.env.SILVERHAND_DIR;
if (!parent) throw new Error("isolated SILVERHAND_DIR required");
let root: string;
beforeEach(async () => {
  await fs.mkdir(parent, { recursive: true });
  root = await fs.mkdtemp(join(parent, "attachment-save-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("attachment save IPC trust boundary", () => {
  it.each([
    ["Report Q3.PDF", "Report Q3.PDF"],
    ["日志-2026.log", "日志-2026.log"],
    ["foo/bar.txt", "foo_bar.txt"],
    ["a\\b\\c.zip", "a_b_c.zip"],
    ["a\x00b\x1fc.txt", "abc.txt"],
    ["x".repeat(400) + ".log", "x".repeat(255)],
  ])("offers a bare safe filename for %s, not a path from renderer", async (filename, expected) => {
    const showSaveDialog = vi.fn(async () => ({ canceled: true }));
    const writeFile = vi.fn(async () => {});
    expect(
      await handleAttachmentSave(
        { filename, bytes: Buffer.from([1]) },
        { showSaveDialog, writeFile },
      ),
    ).toEqual({ ok: false, canceled: true });
    expect(showSaveDialog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ defaultPath: expected }),
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each([
    { filename: undefined, bytes: new Uint8Array([1]), reason: "invalid_filename" },
    { filename: "x.txt", bytes: "not bytes", reason: "invalid_payload" },
    { filename: "x.txt", bytes: new Uint8Array(), reason: "empty_payload" },
    { filename: "   ", bytes: new Uint8Array([1]), reason: "invalid_filename" },
    { filename: "\x00\x01", bytes: new Uint8Array([1]), reason: "invalid_filename" },
  ])("rejects $reason before selection/write", async ({ filename, bytes, reason }) => {
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: "/should-not-write" }));
    const writeFile = vi.fn(async () => {});
    expect(await handleAttachmentSave({ filename, bytes }, { showSaveDialog, writeFile })).toEqual({
      ok: false,
      reason,
    });
    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each([{ canceled: true, filePath: "/must-not-write" }, { canceled: false }])(
    "does not write cancelled/missing selection %j",
    async (selection) => {
      const writeFile = vi.fn(async () => {});
      expect(
        await handleAttachmentSave(
          { filename: "suggested.txt", bytes: Buffer.from([1]) },
          { showSaveDialog: async () => selection, writeFile },
        ),
      ).toEqual({ ok: false, canceled: true });
      expect(writeFile).not.toHaveBeenCalled();
    },
  );

  it.each([Buffer.from([1, 2, 3]), new Uint8Array([4, 5, 6])])(
    "writes bytes to the selected destination, never the renderer suggestion",
    async (bytes) => {
      const chosen = join(root, "renamed.pdf");
      const suggested = join(root, "suggested.pdf");
      const result = await handleAttachmentSave(
        { filename: suggested, bytes },
        {
          showSaveDialog: async () => ({ canceled: false, filePath: chosen }),
          writeFile: fs.writeFile,
        },
      );
      expect(result).toEqual({ ok: true, path: chosen });
      expect([...(await fs.readFile(chosen))]).toEqual([...bytes]);
      expect(await fs.readdir(root)).toEqual(["renamed.pdf"]);
    },
  );

  it("reports a real destination write failure", async () => {
    const result = await handleAttachmentSave(
      { filename: join(root, "suggested.pdf"), bytes: Buffer.from([1]) },
      {
        showSaveDialog: async () => ({ canceled: false, filePath: root }),
        writeFile: fs.writeFile,
      },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^write_failed:.*EISDIR/s),
    });
    expect(await fs.readdir(root)).toEqual([]);
  });
});
