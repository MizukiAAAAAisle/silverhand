import { describe, expect, it } from "vitest";
import type { ServerFrame } from "@silverhand/shared";
import type { TransportEpoch, TransportSeq } from "@silverhand/shared";
import { savedWorkspaceFrameInvalidates } from "./hooks";

// The workspace-scope subscriptions the Saved list holds (mirrors every
// `workspace:<id>` the viewer belongs to). Frame-decision only — no query
// client, no rendering.
const SCOPES = new Set(["workspace:w1", "workspace:w2"]);

const SEQ = 1 as unknown as TransportSeq;
const EPOCH = "e1" as unknown as TransportEpoch;

function event(scope: string, kind: string): ServerFrame {
  return { type: "event", scope, kind, seq: SEQ, epoch: EPOCH, payload: null };
}

function snapshotRequired(scope: string): ServerFrame {
  return {
    type: "snapshot_required",
    scope,
    reason: "gap_too_large",
    epoch: EPOCH,
    currentSeq: SEQ,
  };
}

describe("savedWorkspaceFrameInvalidates", () => {
  it("invalidates on a channel change delivered to a subscribed workspace scope", () => {
    expect(
      savedWorkspaceFrameInvalidates(event("workspace:w1", "workspace_channels_changed"), SCOPES),
    ).toBe(true);
  });

  it("ignores a channel change on a workspace the viewer does not belong to", () => {
    // The embedded `channel_name` we keep live is only for OUR workspaces; a
    // foreign workspace's rename cannot affect any row we hold.
    expect(
      savedWorkspaceFrameInvalidates(event("workspace:w9", "workspace_channels_changed"), SCOPES),
    ).toBe(false);
  });

  it("ignores an unrelated event kind on a subscribed scope", () => {
    // The same scope carries many kinds; only the channel-metadata one touches
    // the embedded projection.
    expect(savedWorkspaceFrameInvalidates(event("workspace:w1", "message"), SCOPES)).toBe(false);
  });

  it("invalidates on a snapshot_required for a subscribed scope", () => {
    // A reconnect gap may have swallowed the channel-change event, so a
    // snapshot on a subscribed scope forces the refetch too.
    expect(savedWorkspaceFrameInvalidates(snapshotRequired("workspace:w2"), SCOPES)).toBe(true);
  });

  it("ignores a snapshot_required for a non-subscribed scope", () => {
    expect(savedWorkspaceFrameInvalidates(snapshotRequired("workspace:w9"), SCOPES)).toBe(false);
  });
});
