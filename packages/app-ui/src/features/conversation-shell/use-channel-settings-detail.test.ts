import { describe, expect, it } from "vitest";
import { decodeTransportSeq, decodeTransportEpoch, type ServerFrame } from "@silverhand/shared";
import { refreshesChannelSettings } from "./use-channel-settings-detail";
import { wsConversationSideScope } from "@/hooks/use-conversation-stream";

const event = (scope: string, kind: string): ServerFrame => ({
  type: "event",
  scope,
  kind,
  seq: decodeTransportSeq(1),
  epoch: decodeTransportEpoch("test"),
  payload: {},
});

describe("settings live detail", () => {
  it("refreshes the exact roster and its workspace metadata/permissions", () => {
    for (const frame of [
      event(wsConversationSideScope("a"), "conversation_members_changed"),
      event("workspace:w", "workspace_channels_changed"),
      event("workspace:w", "workspace_members_changed"),
    ]) {
      expect(refreshesChannelSettings(frame, "a", "w")).toBe(true);
    }
  });
  it("does not let another channel or high-frequency runtime events reseed forms", () => {
    for (const frame of [
      event(wsConversationSideScope("b"), "conversation_members_changed"),
      event("workspace:other", "workspace_channels_changed"),
      event(wsConversationSideScope("a"), "agent_status"),
    ]) {
      expect(refreshesChannelSettings(frame, "a", "w")).toBe(false);
    }
  });
});
