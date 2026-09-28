import { describe, expect, it } from "vitest";
import { clearAgentSessionPath } from "./runtime-control";

describe("clearAgentSessionPath", () => {
  it("addresses AgentSlot by agent even when a presentation conversation is open", () => {
    expect(
      clearAgentSessionPath({
        agentId: "agent-1",
        sessionScope: "agent",
        conversationId: "focus-only",
      }),
    ).toBe("/api/agents/agent-1/clear-session");
  });

  it("keeps ConversationSlot identity conversation-scoped and fails without it", () => {
    expect(
      clearAgentSessionPath({
        agentId: "agent-1",
        sessionScope: "conversation",
        conversationId: "conversation-1",
      }),
    ).toBe("/api/channels/conversation-1/agents/agent-1/clear-session");
    expect(() =>
      clearAgentSessionPath({
        agentId: "agent-1",
        sessionScope: "conversation",
        conversationId: null,
      }),
    ).toThrow("no channel selected");
  });
});
