import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MessageDto, TaskSummaryDto } from "@silverhand/shared";
import { decodeMessageSeq } from "@silverhand/shared";
import { SystemActivityCluster } from "./system-activity-cluster";
import { t } from "@/lib/i18n";
import { TaskRefContextProvider } from "@/features/tasks/components/task-ref-context";
import { taskBoardCacheScope, taskByNumberKey } from "@/features/tasks/hooks/use-task-by-number";

/** Minimal MessageDto factory — same shape as Markdown.test's helper,
 *  duplicated locally so the cluster tests don't reach into another
 *  test file's private helpers. */
function makeSystemMessage(
  subtype: string,
  metadata: Record<string, unknown>,
  overrides: Partial<Omit<MessageDto, "seq">> & { seq?: number } = {},
): MessageDto {
  const { seq, ...rest } = overrides;
  return {
    id: "sys-cluster-1",
    conversation_id: "conv-1",
    from_kind: "system",
    from_agent_id: null,
    from_user_id: null,
    author: null,
    content: "",
    metadata: { subtype, ...metadata },
    attachments: null,
    seq: decodeMessageSeq(seq ?? 1),
    created_at: 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
    ...rest,
  };
}

function seededTask(overrides: Partial<TaskSummaryDto> = {}): TaskSummaryDto {
  return {
    id: "task-42",
    task_number: 42,
    place: {
      kind: "workspace",
      conversation_id: "chan-1",
      workspace_id: "ws-1",
      channel_name: "general",
    },
    thread_root_id: null,
    status: "todo",
    title: "wire registry",
    assignee: null,
    creator: { type: "agent", id: "a-alice", name: "Alice" },
    created_at: 0,
    closed_at: null,
    ...overrides,
  };
}

function renderCluster(messages: MessageDto[], seededTasks: TaskSummaryDto[] = [], jumpMessageId?: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const t of seededTasks) {
    if (t.place.kind !== "workspace") throw new Error("workspace fixture expected");
    qc.setQueryData(
      taskByNumberKey(
        taskBoardCacheScope({ workspaceId: t.place.workspace_id, conversationId: "conv-1" }),
        t.task_number,
      ),
      t,
    );
  }
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: "/" },
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          TaskRefContextProvider,
          { value: { workspaceId: "ws-1", conversationId: "conv-1", onOpenTask: () => undefined } },
          React.createElement(SystemActivityCluster, {
            messages,
            jumpMessageId,
            channelsByName: new Map(),
            onOpenChannelRef: () => undefined,
          }),
        ),
      ),
    ),
  );
}

const fullTaskMeta = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_number: 42,
  task_status: "todo",
  task_id: "task-42",
  task_message_id: "msg-task-42",
  task_title: "wire registry",
  task_assignee: null,
  actor: { kind: "agent", id: "a-alice", name: "Alice" },
  ...overrides,
});

describe("SystemActivityCluster (PR-10)", () => {
  it("wraps the run in `.system-activity-cluster` and exposes the row count via data attribute", () => {
    const a = makeSystemMessage("task_create", fullTaskMeta(), { id: "a" });
    const b = makeSystemMessage("task_status", fullTaskMeta({ task_status: "in_review" }), {
      id: "b",
    });
    const html = renderCluster([a, b], [seededTask({ status: "in_review" })]);
    // The cluster's outermost element carries the row-count data marker.
    expect(html).toMatch(/^<div[^>]*\bdata-system-activity-cluster="2"/);
  });

  it("folds consecutive events on one task into its latest line, and keeps other tasks apart", () => {
    const a = makeSystemMessage("task_claim", fullTaskMeta(), { id: "a" });
    const b = makeSystemMessage("task_status", fullTaskMeta({ task_status: "in_review" }), {
      id: "b",
    });
    const c = makeSystemMessage("task_unclaim", fullTaskMeta({ task_status: "todo" }), { id: "c" });
    const folded = renderCluster([a, b, c], [seededTask()]);
    expect(folded.match(/data-system-event-row="1"/g) ?? []).toHaveLength(1);
    expect(folded).toContain(t("messages.activityRecords", { count: 3 }));

    const other = makeSystemMessage("task_create", fullTaskMeta({ task_number: 7 }), { id: "d" });
    const apart = renderCluster([a, other], [seededTask()]);
    expect(apart.match(/data-system-event-row="1"/g) ?? []).toHaveLength(2);
    expect(apart).not.toContain("data-activity-fold-toggle");
  });

  it("opens the fold that holds an early jump target, flashing only that event once", () => {
    const a = makeSystemMessage("task_claim", fullTaskMeta(), { id: "a" });
    const b = makeSystemMessage("task_status", fullTaskMeta({ task_status: "in_review" }), {
      id: "b",
    });
    const c = makeSystemMessage("task_unclaim", fullTaskMeta({ task_status: "todo" }), { id: "c" });
    const otherA = makeSystemMessage("task_create", fullTaskMeta({ task_number: 7 }), { id: "d" });
    const otherB = makeSystemMessage("task_claim", fullTaskMeta({ task_number: 7 }), { id: "e" });
    const html = renderCluster([a, b, c, otherA, otherB], [seededTask()], "a");
    expect(html).toContain('data-activity-fold="open"');
    // Each event is painted exactly once — no summary/history echo.
    for (const id of ["a", "b", "c"]) {
      expect(html.match(new RegExp(`data-system-message-id="${id}"`, "g")) ?? []).toHaveLength(1);
    }
    // The unrelated folded task stays closed: only its latest event is painted.
    expect(html.match(/data-system-message-id="e"/g) ?? []).toHaveLength(1);
    expect(html.match(/data-system-message-id="d"/g) ?? []).toHaveLength(0);
    expect(html.match(/data-system-event-row="1"/g) ?? []).toHaveLength(4);
    // Only the jump target flashes, and it is the target we asked for.
    expect(html.match(/msg-jump-flash/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/msg-jump-flash[^>]*data-system-message-id="a"/);
    // The unrelated two-event task keeps the upstream default closed fold.
    expect(html).toContain('data-activity-fold="closed"');
    expect(html).toContain(t("messages.activityRecords", { count: 2 }));
  });

  it("opens the fold that holds the latest jump target, flashing only that event once", () => {
    const a = makeSystemMessage("task_claim", fullTaskMeta(), { id: "a" });
    const b = makeSystemMessage("task_status", fullTaskMeta({ task_status: "in_review" }), {
      id: "b",
    });
    const c = makeSystemMessage("task_unclaim", fullTaskMeta({ task_status: "todo" }), { id: "c" });
    const html = renderCluster([a, b, c], [seededTask()], "c");
    expect(html).toContain('data-activity-fold="open"');
    expect(html.match(/data-system-event-row="1"/g) ?? []).toHaveLength(3);
    for (const id of ["a", "b", "c"]) {
      expect(html.match(new RegExp(`data-system-message-id="${id}"`, "g")) ?? []).toHaveLength(1);
    }
    expect(html.match(/msg-jump-flash/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/msg-jump-flash[^>]*data-system-message-id="c"/);
  });

  it("keeps the upstream default fold closed when nothing is jumped to", () => {
    const a = makeSystemMessage("task_claim", fullTaskMeta(), { id: "a" });
    const b = makeSystemMessage("task_status", fullTaskMeta({ task_status: "in_review" }), {
      id: "b",
    });
    const c = makeSystemMessage("task_unclaim", fullTaskMeta({ task_status: "todo" }), { id: "c" });
    const html = renderCluster([a, b, c], [seededTask()]);
    expect(html).toContain('data-activity-fold="closed"');
    expect(html.match(/data-system-event-row="1"/g) ?? []).toHaveLength(1);
    expect(html).toContain("data-activity-fold-toggle");
    expect(html).not.toContain("msg-jump-flash");
  });

  it("faithfully renders whatever subtypes it is handed, without re-gating (defensive passthrough)", () => {
    // DEFENSIVE-INPUT test — NOT a grouping contract. The decision of
    // which subtypes actually cluster lives in `group-messages.ts`, and
    // since #task:1145 `session_cleared` / `rename` are NOT clusterable
    // (they render standalone). This test only pins that the cluster
    // component is a dumb passthrough: if some caller ever hands it a
    // mixed/arbitrary message list, it renders each subtype via the
    // standalone SystemMessage renderer instead of dropping or
    // re-filtering rows. Using non-clusterable subtypes here on purpose,
    // to prove the renderer doesn't second-guess its input.
    const a = makeSystemMessage("task_claim", fullTaskMeta(), { id: "a" });
    const b = makeSystemMessage(
      "session_cleared",
      {
        agent_id: "a-bob",
        agent_name: "Bob",
        actor_user_id: "local",
        previous_cli_session_id_prefix: "fbe21c8a",
        was_running: true,
      },
      { id: "b" },
    );
    const c = makeSystemMessage(
      "rename",
      { old_name: "version2", new_name: "version3" },
      { id: "c" },
    );
    const html = renderCluster([a, b, c], [seededTask()]);
    // task event signal
    expect(html).toContain("data-task-event-dot");
    expect(html).toContain('data-task-ref="42"');
    // session_cleared signal
    expect(html).toContain('data-session-cleared="1"');
    // rename signal
    expect(html).toContain('data-rename-row="1"');
  });

  it("a 1-element cluster still uses the cluster wrapper (so even a lone audit row visually demotes)", () => {
    // Even a stray task event between two real messages should drop
    // below real-message visual weight. The grouping pass produces a
    // 1-element cluster for it; the renderer must not optimize that
    // away into a bare `<SystemMessage>` (which would re-attach the
    // standalone chunky `px-4 py-1.5` padding).
    const only = makeSystemMessage("task_claim", fullTaskMeta(), { id: "only" });
    const html = renderCluster([only], [seededTask()]);
    expect(html).toMatch(/^<div[^>]*\bdata-system-activity-cluster="1"/);
    expect(html).toContain('data-system-event-row="1"');
  });
});

 describe("exact activity member identity", () => {
  it("retains actual persisted IDs and highlights only one of two events for the same task", () => {
    const a=makeSystemMessage("task_create",fullTaskMeta(),{id:"create-E"});
    const b=makeSystemMessage("task_status",fullTaskMeta({subtype:"task_status"}),{id:"status-E"});
    const html=renderCluster([a,b],[seededTask()],"status-E");
    expect(html).toContain('class="system-message-row" data-system-event-row="1" data-system-message-id="create-E"');
    expect(html).toContain('class="system-message-row msg-jump-flash" data-system-event-row="1" data-system-message-id="status-E"');
    expect(html.match(/data-message-conversation-id="conv-1"/g)).toHaveLength(2);
    expect(html.match(/msg-jump-flash/g)).toHaveLength(1);
  });
  it("does not flash a task-number/text alias or absent event", () => {
    const html=renderCluster([makeSystemMessage("task_create",fullTaskMeta(),{id:"create-E"})],[seededTask()],"42");
    expect(html).not.toContain("msg-jump-flash"); expect(html).toContain('data-system-message-id="create-E"');
  });
});
