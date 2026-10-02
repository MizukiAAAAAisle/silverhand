import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_FILTERS } from "@/features/tasks/model/task-filters";
import {
  taskBoardContainerForPane,
  taskContainerBaseline,
  taskContainerKey,
  type TaskBoardContainer,
} from "@/features/tasks/model/task-container";
import type { ConversationPaneMode } from "@/features/conversations/pane-mode";

describe("taskContainerBaseline", () => {
  it("narrows a pair on the conversation axis alone, on the direct_messages container", () => {
    // No workspace coordinate is minted: `t.workspace_id = ?` never matches the
    // NULL a DM task carries, so a claimed workspace would exclude the very
    // tasks the board opened for. The `direct_messages` container axis is set so
    // the board opens on the DM 对端 leaf (this pair selected) rather than
    // showing the workspace/channel controls under an orphan channelId
    // (#task:2041).
    expect(
      taskContainerBaseline({
        kind: "direct_pair",
        conversationId: "c-pair",
      }),
    ).toEqual({
      ...DEFAULT_TASK_FILTERS,
      container: "direct_messages",
      channelId: "c-pair",
    });
  });

  it("narrows a channel on workspace + conversation", () => {
    expect(
      taskContainerBaseline({
        kind: "workspace_channel",
        workspaceId: "ws-1",
        conversationId: "c-chan",
      }),
    ).toEqual({
      ...DEFAULT_TASK_FILTERS,
      workspaceId: "ws-1",
      channelId: "c-chan",
    });
  });

  it("keeps the workspace when no channel is focused", () => {
    expect(
      taskContainerBaseline({
        kind: "workspace_channel",
        workspaceId: "ws-1",
        conversationId: null,
      }),
    ).toEqual({ ...DEFAULT_TASK_FILTERS, workspaceId: "ws-1", channelId: null });
  });
});

describe("taskContainerKey", () => {
  const container: TaskBoardContainer = {
    kind: "workspace_channel",
    workspaceId: "ws-1",
    conversationId: "c-chan",
  };

  it("is equal for two assemblies of the same facts", () => {
    // The point of the key: a carrier refetch hands over fresh objects, and the
    // tab's baseline must not re-apply (discarding the viewer's filters) just
    // because a list was re-read.
    const a: TaskBoardContainer = { ...container };
    const b: TaskBoardContainer = { ...container };
    expect(a).not.toBe(b);
    expect(taskContainerKey(a)).toBe(taskContainerKey(b));
  });

  it("changes when the focused channel changes", () => {
    expect(taskContainerKey(container)).not.toBe(
      taskContainerKey({ ...container, conversationId: "c-other" }),
    );
  });

  it("type fence: the drawer-header carrier fields stay gone (re-adding fails typecheck)", () => {
    // A COMPILE-TIME fence, not a runtime assertion — the runtime key is
    // identity-only, so no value-level test can witness the ABSENCE of a field.
    // `label` / `workspaceName` were the drawer header's only readers (#task:2124);
    // if either is added back to `TaskBoardContainer`, the excess-property error
    // disappears, the `@ts-expect-error` goes unused, and this package's
    // typecheck goes red.
    const pair: TaskBoardContainer = {
      kind: "direct_pair",
      conversationId: "c-pair",
      // @ts-expect-error — removed drawer-header carrier (#task:2124)
      label: "Cindy",
    };
    const ws: TaskBoardContainer = {
      kind: "workspace_channel",
      workspaceId: "ws-1",
      conversationId: "c-chan",
      // @ts-expect-error — removed drawer-header carrier (#task:2124)
      workspaceName: "silverhand",
    };
    // The key encodes only the coordinate; the excess fields are ignored (they
    // survive on the object at runtime, but `taskContainerKey` never reads them).
    expect(taskContainerKey(pair)).toBe(JSON.stringify(["pair", "c-pair"]));
    expect(taskContainerKey(ws)).toBe(JSON.stringify(["ws", "ws-1", "c-chan"]));
  });

  it("never collides across the two arms on the same conversation id", () => {
    expect(taskContainerKey({ kind: "direct_pair", conversationId: "c-x" })).not.toBe(
      taskContainerKey({
        kind: "workspace_channel",
        workspaceId: "c-x",
        conversationId: null,
      }),
    );
  });
});

describe("taskBoardContainerForPane", () => {
  // The pane facts the projection folds in — never the source of the placement
  // decision, only the coordinates a formed container carries.
  const facts = { conversationId: "c-1" };

  it("forms a direct_pair for a direct_message pane", () => {
    const mode: ConversationPaneMode = {
      kind: "direct_message",
      counterpart: null,
    };
    expect(taskBoardContainerForPane(mode, facts)).toEqual({
      kind: "direct_pair",
      conversationId: "c-1",
    });
  });

  it("forms a workspace_channel when the workspace id is real", () => {
    const mode: ConversationPaneMode = {
      kind: "workspace_channel",
      workspaceId: "ws-1",
    };
    expect(taskBoardContainerForPane(mode, facts)).toEqual({
      kind: "workspace_channel",
      workspaceId: "ws-1",
      conversationId: "c-1",
    });
  });

  // The two fail-closed cases: NO container forms, which is the sole gate that
  // withholds the conversation's Tasks affordance (no selectable tab that would
  // reveal Chat beneath it — Cindy review).
  it("fails closed to null for a workspace pane with no workspace id", () => {
    const mode: ConversationPaneMode = {
      kind: "workspace_channel",
      workspaceId: null,
    };
    expect(taskBoardContainerForPane(mode, facts)).toBeNull();
  });

  it("fails closed to null for an unsupported placement", () => {
    const mode: ConversationPaneMode = {
      kind: "unsupported",
      placement: "workspace",
    };
    expect(taskBoardContainerForPane(mode, facts)).toBeNull();
  });
});
