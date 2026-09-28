import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@silverhand/shared";
import { decideAgentSyncAction } from "./agent-sync";

describe("decideAgentSyncAction", () => {
  const evt = (scope: string, kind: string, payload: unknown): ServerFrame =>
    ({ type: "event", scope, seq: 1, epoch: "e", kind, payload }) as ServerFrame;

  it("invalidates on a valid app-scope agent_changed event", () => {
    expect(decideAgentSyncAction(evt("app", "agent_changed", { agent_id: "a1" }))).toEqual({
      kind: "invalidate",
    });
  });

  it("ignores agent_changed on a non-app scope", () => {
    expect(
      decideAgentSyncAction(evt("workspace:w1", "agent_changed", { agent_id: "a1" })),
    ).toBeNull();
  });

  it("ignores a different event kind on app scope", () => {
    expect(decideAgentSyncAction(evt("app", "user_presence", { agent_id: "a1" }))).toBeNull();
  });

  it("ignores a malformed payload (agent_id missing / wrong type)", () => {
    expect(decideAgentSyncAction(evt("app", "agent_changed", {}))).toBeNull();
    expect(decideAgentSyncAction(evt("app", "agent_changed", { agent_id: 5 }))).toBeNull();
  });

  it("invalidates on app-scope snapshot_required (WS replay gap / epoch mismatch)", () => {
    const frame = {
      type: "snapshot_required",
      scope: "app",
      reason: "epoch_mismatch",
    } as ServerFrame;
    expect(decideAgentSyncAction(frame)).toEqual({ kind: "invalidate" });
  });

  it("ignores snapshot_required on a non-app scope", () => {
    const frame = {
      type: "snapshot_required",
      scope: "conversation:c1",
      reason: "gap_too_large",
    } as ServerFrame;
    expect(decideAgentSyncAction(frame)).toBeNull();
  });

  it("ignores transport frames (ping)", () => {
    expect(decideAgentSyncAction({ type: "ping" } as ServerFrame)).toBeNull();
  });
});
