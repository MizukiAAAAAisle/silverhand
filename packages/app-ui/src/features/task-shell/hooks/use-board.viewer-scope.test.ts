import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { decodeTransportEpoch, decodeTransportSeq, type ServerFrame } from "@silverhand/shared";
import { useTaskBoardRealtime } from "./use-board";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  listeners: new Set<(frame: ServerFrame) => void>(),
  qc: null as QueryClient | null,
  subscribe: vi.fn((_scope: string) => ({ unsubscribe: vi.fn() })),
  apply: vi.fn((..._args: unknown[]) => ({ needsReconcile: false })),
  reconcile: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => harness.qc,
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspaces: () => ({ data: [{ id: "a" }, { id: "b" }] }),
}));
vi.mock("@/lib/ws-client", () => ({
  subscribeViewerScope: () => harness.subscribe("viewer:me"),
  subscribeWsScope: (scope: string) => harness.subscribe(scope),
  isCurrentViewerScope: (scope: string) => scope === "viewer:me",
  onWsFrame: (listener: (frame: ServerFrame) => void) => {
    harness.listeners.add(listener);
    return () => harness.listeners.delete(listener);
  },
}));
vi.mock("../model/task-projection", () => ({
  applyTaskChangedToProjections: (...args: unknown[]) => harness.apply(...args),
  reconcileTaskStatusWrite: (...args: unknown[]) => harness.reconcile(...args),
}));

function emit(scope: string, kind: "task_changed" | "workspace_channels_changed") {
  const frame: ServerFrame = {
    type: "event",
    scope,
    kind,
    epoch: decodeTransportEpoch("epoch"),
    seq: decodeTransportSeq(1),
    payload: { kind: "status" },
  };
  for (const listener of harness.listeners) listener(frame);
  return frame.payload;
}

let cleanups: Array<() => void>;
beforeEach(() => {
  vi.clearAllMocks();
  harness.qc = new QueryClient();
  harness.effects = [];
  useTaskBoardRealtime();
  cleanups = harness.effects
    .map((effect) => effect())
    .filter((cleanup): cleanup is () => void => typeof cleanup === "function");
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  harness.qc?.clear();
});

describe("board realtime scope boundary", () => {
  it("subscribes the viewer and every workspace, releasing all on unmount", () => {
    expect(harness.subscribe.mock.calls.map(([scope]) => scope).sort()).toEqual([
      "viewer:me",
      "workspace:a",
      "workspace:b",
    ]);
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    expect(harness.listeners.size).toBe(0);
    for (const result of harness.subscribe.mock.results)
      expect(result.value.unsubscribe).toHaveBeenCalledOnce();
  });

  it("applies a task payload exactly once only on the current viewer scope", () => {
    emit("workspace:a", "task_changed");
    emit("viewer:other", "task_changed");
    expect(harness.apply).not.toHaveBeenCalled();
    const payload = emit("viewer:me", "task_changed");
    expect(harness.apply).toHaveBeenCalledExactlyOnceWith(harness.qc, payload);
  });

  it("workspace events invalidate columns without applying task data", () => {
    const key = ["tasks", "board", "column", "sample"];
    harness.qc!.setQueryData(key, "cached");
    emit("workspace:unknown", "workspace_channels_changed");
    expect(harness.qc!.getQueryState(key)?.isInvalidated).toBe(false);
    emit("workspace:b", "workspace_channels_changed");
    expect(harness.qc!.getQueryState(key)?.isInvalidated).toBe(true);
    expect(harness.apply).not.toHaveBeenCalled();
    expect(harness.reconcile).not.toHaveBeenCalled();
  });
});
