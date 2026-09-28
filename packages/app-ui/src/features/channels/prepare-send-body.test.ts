import { describe, expect, it, vi } from "vitest";
import type { AttachmentDto } from "@silverhand/shared";
import { MAX_MESSAGE_CONTENT_BYTES } from "@silverhand/shared";
import { prepareSendMessageBody } from "./hooks";

function fakeAttachment(size: number): AttachmentDto {
  return {
    id: "att-conv",
    channel_id: "ch-1",
    source_conversation_id: "ch-1",
    filename: "message-body-x.txt",
    size,
    content_type: "text/plain",
    storage: "local",
    created_by_kind: "user",
    created_by_id: "u-1",
    created_at: 0,
  } as AttachmentDto;
}

describe("prepareSendMessageBody — authoritative oversized conversion", () => {
  it("converts an over-cap final draft into a text attachment + pointer body", async () => {
    const content = "a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1);
    const uploadText = vi.fn(async () => fakeAttachment(content.length));
    const body = await prepareSendMessageBody({
      channelId: "ch-1",
      input: { content },
      uploadText,
    });
    expect(uploadText).toHaveBeenCalledWith("ch-1", content);
    expect(body.attachment_ids).toEqual(["att-conv"]);
    expect(body.content).toContain("message-body-x.txt");
    expect(body.content.length).toBeLessThan(200);
  });

  it("appends the converted attachment after existing composer attachments", async () => {
    const content = "a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1);
    const uploadText = vi.fn(async () => fakeAttachment(content.length));
    const body = await prepareSendMessageBody({
      channelId: "ch-1",
      input: {
        content,
        attachments: [{ ...fakeAttachment(10), id: "att-file", label: "File #1" }],
      },
      uploadText,
    });
    expect(body.attachment_ids).toEqual([{ id: "att-file", label: "File #1" }, "att-conv"]);
  });

  it("sends exactly-at-cap content as-is, without conversion", async () => {
    const content = "a".repeat(MAX_MESSAGE_CONTENT_BYTES);
    const uploadText = vi.fn(async () => fakeAttachment(0));
    const body = await prepareSendMessageBody({
      channelId: "ch-1",
      input: { content },
      uploadText,
    });
    expect(uploadText).not.toHaveBeenCalled();
    expect(body.content).toBe(content);
    expect(body.attachment_ids).toBeUndefined();
  });

  it("measures the cap in UTF-8 bytes: 30k CJK chars converts", async () => {
    const content = "汉".repeat(30_000); // 90KB UTF-8, 30k UTF-16 units
    const uploadText = vi.fn(async () => fakeAttachment(90_000));
    const body = await prepareSendMessageBody({
      channelId: "ch-1",
      input: { content },
      uploadText,
    });
    expect(uploadText).toHaveBeenCalledOnce();
    expect(body.attachment_ids).toEqual(["att-conv"]);
  });

  it("carries reply_to_message_id for thread sends", async () => {
    const body = await prepareSendMessageBody({
      channelId: "ch-1",
      input: { content: "hi" },
      threadRootId: "m-root",
    });
    expect(body).toEqual({ content: "hi", reply_to_message_id: "m-root" });
  });
});

describe("prepareSendMessageBody — attachment capacity fail-fast", () => {
  it("fails BEFORE uploading when the composer is already at the attachment cap", async () => {
    const content = "a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1);
    const uploadText = vi.fn(async () => fakeAttachment(1));
    const attachments = Array.from({ length: 20 }, (_, i) => ({
      ...fakeAttachment(10),
      id: `att-${i}`,
    }));
    await expect(
      prepareSendMessageBody({
        channelId: "ch-1",
        input: { content, attachments },
        uploadText,
      }),
    ).rejects.toThrow("Remove one attachment");
    // No orphan: the uploader must never have been called.
    expect(uploadText).not.toHaveBeenCalled();
  });

  it("still converts with 19 attachments (one slot reserved for the auto body)", async () => {
    const content = "a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1);
    const uploadText = vi.fn(async () => fakeAttachment(content.length));
    const attachments = Array.from({ length: 19 }, (_, i) => ({
      ...fakeAttachment(10),
      id: `att-${i}`,
    }));
    const body = await prepareSendMessageBody({
      channelId: "ch-1",
      input: { content, attachments },
      uploadText,
    });
    expect(uploadText).toHaveBeenCalledOnce();
    expect(body.attachment_ids).toHaveLength(20);
  });
});
