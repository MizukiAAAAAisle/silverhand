import { describe, expect, it } from "vitest";
import type { AgentRunState } from "@silverhand/shared";
import {
  activityLineOf,
  activitySnippetKindLabel,
  selectActiveRunStates,
} from "./composer-activity";

function runState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    runId: `run-${overrides.agentId ?? "x"}`,
    agentId: "a-1",
    conversationId: "c-1",
    status: "thinking",
    startedAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

describe("selectActiveRunStates", () => {
  it("drops terminal (idle / failed) states", () => {
    const states = [
      runState({ agentId: "a-1", status: "thinking" }),
      runState({ agentId: "a-2", status: "idle" }),
      runState({ agentId: "a-3", status: "failed" }),
      runState({ agentId: "a-4", status: "tool_running" }),
    ];
    expect(selectActiveRunStates(states).map((s) => s.agentId)).toEqual([
      "a-4", // tool_running ranks above thinking
      "a-1",
    ]);
  });

  it("no restriction (null/undefined) keeps every non-terminal state", () => {
    const states = [
      runState({ agentId: "a-1", status: "thinking" }),
      runState({ agentId: "a-2", status: "thinking" }),
    ];
    expect(
      selectActiveRunStates(states, null)
        .map((s) => s.agentId)
        .sort(),
    ).toEqual(["a-1", "a-2"]);
    expect(
      selectActiveRunStates(states, undefined)
        .map((s) => s.agentId)
        .sort(),
    ).toEqual(["a-1", "a-2"]);
  });

  it("restricts to the follower allow-list", () => {
    const states = [
      runState({ agentId: "a-1", status: "thinking" }),
      runState({ agentId: "a-2", status: "tool_running" }),
      runState({ agentId: "a-3", status: "thinking" }),
    ];
    // Only a-1 and a-3 follow this thread → a-2 (busy on main line) hidden.
    expect(
      selectActiveRunStates(states, ["a-1", "a-3"])
        .map((s) => s.agentId)
        .sort(),
    ).toEqual(["a-1", "a-3"]);
  });

  it("empty allow-list yields nothing (thread with no follower agents)", () => {
    const states = [runState({ agentId: "a-1", status: "tool_running" })];
    expect(selectActiveRunStates(states, [])).toEqual([]);
  });

  it("sorts tool_running ahead of thinking, ties broken by recency", () => {
    const states = [
      runState({ agentId: "a-1", status: "thinking", lastActivityAt: 5 }),
      runState({ agentId: "a-2", status: "thinking", lastActivityAt: 9 }),
      runState({ agentId: "a-3", status: "tool_running", lastActivityAt: 1 }),
    ];
    expect(selectActiveRunStates(states).map((s) => s.agentId)).toEqual([
      "a-3", // tool_running first regardless of recency
      "a-2", // newer thinking before older
      "a-1",
    ]);
  });
});

describe("activitySnippetKindLabel", () => {
  it("keeps snippet content type separate from run status", () => {
    expect(activitySnippetKindLabel("thinking")).toBe("Thinking");
    expect(activitySnippetKindLabel("text")).toBe("Writing");
    expect(activitySnippetKindLabel(undefined)).toBeNull();
  });
});

describe("activityLineOf", () => {
  const agents = new Map([["a-1", { id: "a-1", name: "toby", display_name: "Toby" }]]);
  const line = (states: AgentRunState[]) =>
    activityLineOf(selectActiveRunStates(states), (id) => agents.get(id));

  it("is null while nothing runs", () => {
    expect(line([runState({ status: "idle" })])).toBeNull();
  });

  it("leads with the subject and counts the others", () => {
    const result = line([
      runState({ agentId: "a-1", status: "tool_running", detail: "shell" }),
      runState({ agentId: "a-2" }),
    ]);
    expect([result?.name, result?.others, result?.badge]).toEqual(["@Toby", 1, "shell"]);
  });

  it("shows the live tool with its own count, not a sum", () => {
    const result = line([
      runState({ status: "tool_running", detail: "read", toolCallCounts: { read: 3, shell: 9 } }),
    ]);
    expect(result?.badge).toBe("read ×3");
  });

  it("gives the badge to compaction only without a running tool", () => {
    expect(line([runState({ compacting: true })])?.badge).toBe("Compacting");
    expect(
      line([runState({ status: "tool_running", detail: "shell", compacting: true })])?.badge,
    ).toBe("shell");
  });

  it("keeps the status apart from the streamed snippet", () => {
    const result = line([
      runState({ activitySnippet: "Reading the file", activitySnippetKind: "thinking" }),
    ]);
    expect([result?.status, result?.progress, result?.snippetKindLabel]).toEqual([
      "Thinking…",
      "Reading the file",
      "Thinking",
    ]);
  });
});
