import { describe, expect, it } from "vitest";
import { resolveChannelOpen } from "./channel-open";
import type { MessageUnreadPointerDto } from "@silverhand/shared";
import { decodeMessageSeq } from "@silverhand/shared";
import type { ChannelLayout } from "@/router";

function pointer(
  overrides: Partial<Omit<MessageUnreadPointerDto, "seq">> & { seq?: number } = {},
): MessageUnreadPointerDto {
  const { seq, ...rest } = overrides;
  return {
    conversation_id: "c-a",
    message_id: "m-1",
    seq: decodeMessageSeq(seq ?? 100),
    thread_root_id: "root-1",
    ...rest,
  };
}

describe("resolveChannelOpen — unread-target > layout-memory > main stream", () => {
  const layout: ChannelLayout = { kind: "threads-list" };

  it("surfaces the unread thread when the pointer targets a thread and no watermark", () => {
    expect(resolveChannelOpen(pointer(), null, layout)).toEqual({
      kind: "unread-thread",
      threadRootId: "root-1",
      messageId: "m-1",
    });
  });

  it("surfaces the unread thread when the pointer seq is newer than the watermark", () => {
    expect(resolveChannelOpen(pointer({ seq: 101 }), decodeMessageSeq(100), layout)).toEqual({
      kind: "unread-thread",
      threadRootId: "root-1",
      messageId: "m-1",
    });
  });

  it("falls back to layout memory when the pointer seq is at the watermark (just-closed batch)", () => {
    expect(resolveChannelOpen(pointer({ seq: 100 }), decodeMessageSeq(100), layout)).toEqual({
      kind: "layout",
      layout,
    });
  });

  it("falls back to layout memory when the pointer seq is below the watermark", () => {
    expect(resolveChannelOpen(pointer({ seq: 50 }), decodeMessageSeq(100), layout)).toEqual({
      kind: "layout",
      layout,
    });
  });

  it("falls back to layout memory for a main-line unread (no thread_root_id)", () => {
    expect(resolveChannelOpen(pointer({ thread_root_id: null }), null, layout)).toEqual({
      kind: "layout",
      layout,
    });
  });

  it("falls back to layout memory when there is no unread pointer", () => {
    expect(resolveChannelOpen(undefined, null, layout)).toEqual({
      kind: "layout",
      layout,
    });
  });

  it("passes through a null layout (main stream) when nothing else applies", () => {
    expect(resolveChannelOpen(undefined, null, null)).toEqual({
      kind: "layout",
      layout: null,
    });
  });
});
