import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { decodeTransportEpoch, decodeTransportSeq, type ServerFrame } from "@silverhand/shared";
import { useForeignWorkspaceChannelRemovalSync } from "../channels/use-viewer-channel-removal-sync";
import { applyAttentionFrame, attentionBadgesKey } from "./hooks";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  listeners: new Set<(frame: ServerFrame) => void>(),
  qc: null as QueryClient | null,
  subscribe: vi.fn((_scope: string) => ({ unsubscribe: vi.fn() })),
  request: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => harness.qc,
}));
vi.mock("@/lib/ws-client", async (original) => ({
  ...(await original<typeof import("@/lib/ws-client")>()),
  subscribeWsScope: (scope: string) => harness.subscribe(scope),
  onWsFrame: (listener: (frame: ServerFrame) => void) => {
    harness.listeners.add(listener);
    return () => harness.listeners.delete(listener);
  },
}));
vi.mock("../channels/foreign-workspace-reconcile", () => ({
  createForeignWorkspaceReconciler: () => ({ request: harness.request, dispose: harness.dispose }),
}));
function membershipFrame(workspaceId: string): ServerFrame {
  return {
    type: "event",
    scope: `workspace:${workspaceId}`,
    kind: "workspace_channels_changed",
    epoch: decodeTransportEpoch("epoch"),
    seq: decodeTransportSeq(1),
    payload: { workspace_id: workspaceId, channel_id: "channel" },
  };
}
afterEach(() => {
  harness.qc?.clear();
  harness.effects = [];
  harness.listeners.clear();
  vi.clearAllMocks();
});
describe("attention badge membership closure", () => {
  it("subscribes the selected workspace too, but reconciles only foreign workspaces", () => {
    harness.qc = new QueryClient();
    useForeignWorkspaceChannelRemovalSync({ workspaceIds: ["b", "a"], selectedWorkspaceId: "a" });
    const cleanups = harness.effects.map((effect) => effect());
    expect(harness.subscribe.mock.calls.map(([scope]) => scope)).toEqual([
      "workspace:a",
      "workspace:b",
    ]);
    for (const listener of harness.listeners) listener(membershipFrame("a"));
    expect(harness.request).not.toHaveBeenCalled();
    for (const listener of harness.listeners) listener(membershipFrame("unknown"));
    expect(harness.request).not.toHaveBeenCalled();
    for (const listener of harness.listeners) listener(membershipFrame("b"));
    expect(harness.request).toHaveBeenCalledExactlyOnceWith("b", new Set(["channel"]));
    for (const cleanup of cleanups) cleanup?.();
    expect(harness.listeners.size).toBe(0);
    expect(harness.dispose).toHaveBeenCalledOnce();
    for (const result of harness.subscribe.mock.results)
      expect(result.value.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["a", "b"])(
    "membership in workspace %s refreshes badges without viewer scope",
    (workspaceId) => {
      const qc = new QueryClient();
      qc.setQueryData(attentionBadgesKey(), "cached");
      qc.setQueryData(["attention", "modes", workspaceId], "cached");
      qc.setQueryData(["unrelated"], "cached");
      applyAttentionFrame(qc, membershipFrame(workspaceId), false);
      expect(qc.getQueryState(attentionBadgesKey())?.isInvalidated).toBe(true);
      expect(qc.getQueryState(["attention", "modes", workspaceId])?.isInvalidated).toBe(true);
      expect(qc.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
      qc.clear();
    },
  );
});
