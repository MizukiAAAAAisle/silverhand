import { describe, expect, it } from "vitest";
import type { MessageDto } from "@silverhand/shared";
import { foldTaskRuns } from "./fold-task-runs";

function event(id: string, taskNumber: number | null): MessageDto {
  return {
    id,
    metadata:
      taskNumber === null
        ? { subtype: "task_edit" }
        : { subtype: "task_edit", task_number: taskNumber, task_status: "todo" },
  } as unknown as MessageDto;
}

const ids = (folds: ReturnType<typeof foldTaskRuns>) => folds.map((f) => f.events.map((e) => e.id));

describe("foldTaskRuns", () => {
  it("folds consecutive events on the same task", () => {
    expect(ids(foldTaskRuns([event("a", 16), event("b", 16), event("c", 16)]))).toEqual([
      ["a", "b", "c"],
    ]);
  });

  it("starts a new fold when the task changes, even back to an earlier one", () => {
    expect(ids(foldTaskRuns([event("a", 1), event("b", 2), event("c", 1)]))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("keeps an event without a task number on its own", () => {
    expect(ids(foldTaskRuns([event("a", null), event("b", null), event("c", 3)]))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("keys a fold by its first event", () => {
    expect(foldTaskRuns([event("a", 5), event("b", 5)])[0]!.key).toBe("a");
  });
});
