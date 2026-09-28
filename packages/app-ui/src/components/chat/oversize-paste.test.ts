import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_CONTENT_BYTES } from "@silverhand/shared";
import { MAX_ATTACHMENTS, shouldInterceptOversizedPaste } from "./oversize-paste";

const OVER = "a".repeat(MAX_MESSAGE_CONTENT_BYTES + 1);

describe("shouldInterceptOversizedPaste", () => {
  it("intercepts an over-cap paste when a slot is available", () => {
    expect(shouldInterceptOversizedPaste(OVER, 0)).toBe(true);
    expect(shouldInterceptOversizedPaste(OVER, MAX_ATTACHMENTS - 1)).toBe(true);
  });

  it("does NOT intercept at attachment capacity — text must fall through to the draft, never be swallowed", () => {
    expect(shouldInterceptOversizedPaste(OVER, MAX_ATTACHMENTS)).toBe(false);
  });

  it("leaves normal and exactly-at-cap pastes alone", () => {
    expect(shouldInterceptOversizedPaste("hello", 0)).toBe(false);
    expect(shouldInterceptOversizedPaste("a".repeat(MAX_MESSAGE_CONTENT_BYTES), 0)).toBe(false);
    expect(shouldInterceptOversizedPaste("", 0)).toBe(false);
  });
});
